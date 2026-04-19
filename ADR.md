# Architecture Decision Record — SMDE

---

## Question 1 — Sync vs Async

**Async should be the default mode.** Aysnc is default so `POST /api/extract` queues a job and returns `202 Accepted` unless the caller explicitly passes `?mode=sync`.

### Why async by default

LLM providers are fundamentally unreliable as a synchronous dependency. Even for a small JPEG under 100KB, the extraction call can take anywhere from 2 seconds to 30+ seconds depending on the model's current load, the provider's rate-limiting tier, and whether you're hitting a cold instance. I saw this first-hand during previous job — Gemini's free tier returns 429s unpredictably, and a single timed-out request holds an Express connection open for the full 30-second timeout window. In a sync-default system, a burst of 20 concurrent uploads during provider throttling would exhaust the connection pool and cascade into timeouts for every subsequent request, including health checks.

Async-by-default decouples the HTTP request lifecycle from LLM latency entirely. The client gets a `jobId` and `pollUrl` within milliseconds, the file is persisted in the jobs table, and the worker processes it at its own pace with built-in retry logic. If the LLM provider goes down for 5 minutes, queued jobs simply wait — no client connections are held open, no timeouts cascade.

### When to force async regardless of mode param

I would force async in two scenarios:

1. **File size > 5MB.** Larger files (especially multi-page PDFs) produce larger base64 payloads that take longer for the LLM to process. A 5MB PDF encoded to base64 is ~6.7MB of prompt data — this reliably pushes response times past 15 seconds on every provider I tested. No HTTP client should be waiting that long synchronously.

2. **Concurrent in-flight extractions > 5.** If there are already 5 or more LLM calls in progress (tracked via an atomic counter or Redis key), new sync requests should be automatically promoted to async. This prevents the LLM from becoming a bottleneck that backs up the entire API. The threshold of 5 is based on typical rate limits for mid-tier API keys — Gemini allows ~15 RPM on the free tier, and even paid tiers have per-minute caps that make unbounded concurrency dangerous.

The sync mode still exists for callers who need it (internal tooling, single-document testing, migration scripts), but it's opt-in and subject to the force-async thresholds above.

---

## Question 2 — Queue Choice

I chose **BullMQ** backed by Redis. The mechanism matters less than the reasoning, so here's mine.

### Why BullMQ over the alternatives

**pg-boss** was the obvious low-infrastructure choice — it uses PostgreSQL as the broker, which I already have. But pg-boss polls the database on an interval (default 2 seconds), which means job pickup latency is 0–2s. More importantly, every poll is a `SELECT ... FOR UPDATE SKIP LOCKED` against the jobs table. At scale this creates write contention on the same rows the API is inserting into. For a service where the primary write path (file upload → insert job) and the primary read path (worker → claim job) hit the same table under the same locks, PostgreSQL becomes the bottleneck before the LLM does.

**A simple in-process queue** (array + setInterval) would technically work for a single-instance assessment, but it loses all jobs on process restart. Since I'm already storing jobs in PostgreSQL, I could recover from crashes by re-queuing incomplete jobs — but at that point I'm reimplementing half of BullMQ poorly.

**BullMQ** gives me what I actually need:

- **Redis-backed** — sub-millisecond job dispatch via `BRPOPLPUSH`, no polling. Jobs are picked up instantly.
- **Built-in retry with backoff** — I configure `attempts: 3` with exponential backoff. LLM 429s and transient failures are handled without custom retry logic.
- **Concurrency control** — `concurrency: 3` on the worker means I process 3 jobs in parallel without exceeding typical LLM rate limits.
- **Job lifecycle events** — `completed`, `failed`, `stalled` events let me update the jobs table state machine reactively.
- **Stall detection** — if a worker crashes mid-processing, BullMQ detects the stalled job and re-queues it. I don't lose work.

The tradeoff is adding Redis as an infrastructure dependency. For this project that's one extra line in `docker-compose.yml`. In production, Redis is almost certainly already present for caching or sessions.

### Scaling to 500 concurrent extractions per minute

The current setup (single worker, `concurrency: 3`) handles maybe 10–15 extractions per minute depending on LLM response times. To reach 500/min:

1. **Horizontal workers.** BullMQ supports multiple worker processes out of the box — each connects to the same Redis instance and claims jobs independently. I'd run 10–20 worker instances (containers), each with `concurrency: 5`, giving 50–100 concurrent LLM calls.

2. **Multiple LLM providers in parallel.** The provider abstraction pays off here — route jobs round-robin across Gemini, Anthropic, and OpenAI to avoid hitting any single provider's rate limit. Each worker could be configured for a different provider via environment variables.

3. **Rate-limit-aware dispatching.** Add a BullMQ rate limiter (`limiter: { max: 100, duration: 60000 }`) per provider queue. This prevents bursting past provider limits and getting 429s that waste retry capacity.

4. **Redis Cluster.** At 500/min the Redis instance handles ~8 ops/sec for job dispatch alone — well within single-instance Redis capacity. I wouldn't need Redis Cluster until 5,000+/min.

The architecture wouldn't need to change — BullMQ's distributed workers model scales horizontally by adding containers.

### Failure modes

1. **Redis goes down.** All job dispatch stops. The API can still accept uploads (jobs are created in PostgreSQL), but they won't be picked up until Redis recovers. Mitigation: Redis Sentinel for automatic failover in production.

2. **Worker crashes mid-extraction.** The LLM call may have completed but the result isn't stored. BullMQ's stall detection re-queues the job after `stalledInterval` (30s default). The worker retries from scratch — the LLM call is idempotent, so this is safe but wasteful of one API call.

3. **LLM provider outage.** All jobs fail with `LLM_ERROR`. BullMQ retries with exponential backoff (3 attempts). After max retries, the job is moved to the failed set and the jobs table is updated with `status: FAILED, retryable: true`. A manual retry endpoint (`POST /api/jobs/:id/retry`) can re-queue once the provider recovers.

4. **Poison pill — unparseable document.** The LLM returns garbage JSON, repair prompt also fails. The job fails after max retries with `errorCode: LLM_ERROR`. The raw LLM response is always stored in the extraction record for debugging — I never discard data.

---

## Question 3 — LLM Provider Abstraction

I built a provider abstraction, but I deliberately avoided the typical SDK-per-provider approach. Every vision-capable LLM API follows the same pattern: POST a JSON body with an image and a prompt to a URL, get text back. So I implemented a single `FetchLLMProvider` class driven by a config object per provider — no vendor SDKs, no npm dependencies, just `fetch`.

### The interface

The `LLMProvider` interface exposes three methods:

- `extractDocument(base64, mimeType, prompt)` — sends a vision request (image + text prompt)
- `sendPrompt(prompt)` — sends a text-only request (used for repair prompts, validation)
- `checkHealth()` — quick connectivity check

Each provider is defined as a `ProviderConfig` object with five functions:

```
buildUrl(model, apiKey)      → the API endpoint
buildHeaders(apiKey)         → auth and content-type headers
buildVisionBody(...)         → request payload for image + text
buildTextBody(...)           → request payload for text-only
parseResponse(data)          → extract text + usage from response
```

Adding a new provider means writing one config object and adding one entry to the `PROVIDERS` map. No new files, no new classes, no new dependencies.

### Swapping providers

Changing the LLM is a three-variable operation:

```env
LLM_PROVIDER=gemini          # or anthropic, openai, groq
LLM_MODEL=gemini-2.0-flash
LLM_API_KEY=your_key
```

No code changes. No restarts beyond picking up the new env vars. Four major providers are wired up for now: Gemini, Anthropic, OpenAI, and Groq.

### Why no vendor SDKs

The junior engineer's PR in Part 3 imports `@anthropic-ai/sdk` directly — that's exactly what I wanted to avoid. Vendor SDKs add dependency weight, version management overhead, and API surface that mostly goes unused. For our use case (send an image, get text back), raw `fetch` with a 30-second `AbortController` timeout covers every provider identically. The entire LLM layer is one file with zero external dependencies.

### Why Gemini 2.5 Flash

I chose `gemini-2.5-flash` as the default because it has a generous free tier with no credit card required, sub-second response times for simple prompts, strong vision capabilities for document extraction, and it's cost-efficient enough to iterate rapidly during development. The abstraction means switching to Claude Haiku or GPT-4o-mini for production benchmarking is a config change, not a code change.

---

## Question 4 — Schema Design

The suggested schema stores `fields_json`, `validity_json`, `medical_data_json`, `flags_json`, and `compliance_json` as opaque TEXT columns. I changed them to JSONB and promoted every field I'd realistically query on into its own column.

### Risks of JSONB/TEXT at scale

**Query blindness.** TEXT columns can't be indexed or filtered by PostgreSQL at all — every query that touches them is a full table scan plus application-side parsing. JSONB is better (supports `@>`, `->`, `->>` operators with GIN indexes), but it still has real costs: GIN indexes are large, updates rewrite the entire JSONB blob, and the query planner can't estimate selectivity inside JSONB the way it can with a B-tree on a typed column.

**Schema drift.** When LLM output evolves (new fields, changed names), JSONB silently absorbs the change. There's no constraint enforcement — you only discover the problem when a downstream consumer breaks. At scale with multiple prompt versions running in parallel, this becomes a debugging nightmare.

**Storage bloat.** JSONB stores keys on every row. If I have 100k extraction records each containing `{"fitnessResult": "FIT", "drugTestResult": "NEGATIVE", ...}`, that key overhead adds up. Typed columns are compact by comparison.

### What I changed

I promoted every field that satisfies at least one of these criteria into a dedicated column:

1. **Used in WHERE clauses** — `document_type`, `is_expired`, `date_of_expiry`, `confidence`, `fitness_result`, `drug_test_result`
2. **Used in ORDER BY** — `date_of_expiry`, `created_at`
3. **Displayed in list views** — `holder_name`, `document_name`, `category`, `applicable_role`
4. **Part of deduplication** — `file_hash` (with a unique composite index on `session_id + file_hash`)

I kept JSONB for genuinely dynamic data: `fields_json` (variable per document type), `flags_json` (variable-length array), and the full response objects (`validity_json`, `compliance_json`, `medical_data_json`) that are read-through to the API response without server-side filtering.

I parsed `date_of_expiry` and `date_of_issue` into native `DATE` columns instead of storing the LLM's `DD/MM/YYYY` strings. This makes expiry queries trivial:

```sql
-- Documents expiring within 90 days
SELECT * FROM extractions
WHERE date_of_expiry < NOW() + INTERVAL '90 days'
  AND date_of_expiry >= NOW();
```

### "All sessions where any document has an expired COC"

With the promoted columns and the composite index `(document_type, is_expired)`, this is a single indexed query:

```sql
SELECT DISTINCT e.session_id
FROM extractions e
WHERE e.document_type = 'COC' AND e.is_expired = TRUE;
```

No JSON parsing. No full table scan. The index `idx_extractions_type_expired` covers it directly.

### If full-text search were required later

If the product needed search across extracted field values (e.g., "find all documents mentioning STCW Reg II/1"), I would do one of two things depending on scale:

**At moderate scale (< 1M rows):** Add a GIN index on `fields_json` using `jsonb_path_ops`. This enables containment queries (`@>`) efficiently without schema changes. For free-text search, I'd add a generated `tsvector` column built from the concatenation of promoted text fields plus a `jsonb_each_text()` expansion of `fields_json`, with a GIN index on the tsvector.

**At large scale (> 1M rows, frequent search):** I'd normalize `fields_json` into a child table `extraction_fields(extraction_id, key, label, value, importance, status)` with a GIN trigram index (`pg_trgm`) on the `value` column. This makes substring search, ILIKE, and similarity queries fast, and eliminates the need to parse JSONB at query time. The tradeoff is write amplification — every extraction fans out into N child rows — but reads dominate this workload.

I chose not to implement the child table now because the current query patterns don't require it, and the normalization adds write complexity that isn't justified until full-text search is an actual product requirement.
