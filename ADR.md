# Architecture Decision Record — SMDE

---

## Question 1 — Sync vs Async

### Short Answer

Async should be the production default. I would force async for files larger than 5MB or when there are already more than 5 in-flight extractions.

### Why async by default

LLM providers are fundamentally unreliable as a synchronous dependency. Even for a small JPEG under 100KB, the extraction call can take anywhere from 2 seconds to 30+ seconds depending on the model's current load, the provider's rate-limiting tier, and whether you're hitting a cold instance. I saw this first-hand during previous job — Gemini's free tier returns 429s unpredictably, and a single timed-out request holds an Express connection open for the full timeout window. In a sync-default system, a burst of 20 concurrent uploads during provider throttling would exhaust the connection pool and cascade into timeouts for every subsequent request, including health checks.

Async-by-default decouples the HTTP request lifecycle from LLM latency entirely. The client gets a `jobId` and `pollUrl` within milliseconds, the file is persisted in the jobs table, and the worker processes it at its own pace with built-in retry logic. If the LLM provider goes down for 5 minutes, queued jobs simply wait — no client connections are held open, no timeouts cascade.

### When to force async regardless of mode param

I would force async in two scenarios:

1. **File size > 5MB.** Larger files (especially multi-page PDFs) produce larger base64 payloads that take longer for the LLM to process. A 5MB PDF encoded to base64 is ~6.7MB of prompt data — this reliably pushes response times past 15 seconds on every provider I tested. No HTTP client should be waiting that long synchronously.

2. **Concurrent in-flight extractions > 5.** If there are already 5 or more LLM calls in progress (tracked via an atomic counter or Redis key), new sync requests should be automatically promoted to async. This prevents the LLM from becoming a bottleneck that backs up the entire API. The threshold of 5 is based on typical rate limits for mid-tier API keys — Gemini allows ~15 RPM on the free tier, and even paid tiers have per-minute caps that make unbounded concurrency dangerous.

The sync mode still exists for callers who need it (internal tooling, single-document testing, migration scripts), but it's opt-in and subject to the force-async thresholds above.

---

## Question 2 — Queue Choice

### Short Answer

I used BullMQ with Redis because it gives fast dispatch, retries, concurrency control, and crash recovery with minimal custom code. If throughput needed to reach 500 concurrent extractions per minute, I would keep BullMQ and scale horizontally with more workers and provider-aware throttling.


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

### Short Answer

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

The junior engineer's PR in Part 3 imports `@anthropic-ai/sdk` directly — that's exactly what I wanted to avoid. Vendor SDKs add dependency weight, version management overhead, and API surface that mostly goes unused. For our use case (send an image, get text back), raw `fetch` with an `AbortController` timeout covers every provider identically, and timeout is configurable via `LLM_TIMEOUT_MS` for document-heavy workloads. The entire LLM layer is one file with zero external dependencies.

I made timeout configurable (instead of fixed 30 seconds) because the same provider path is used by more than one endpoint and operation: document extraction (`/api/extract`), cross-document validation (`/api/sessions/:sessionId/validate`), repair prompts after parse failures, and LLM health checks. A single fixed timeout that fits one path poorly can cause avoidable failures in another. Centralizing timeout in `LLM_TIMEOUT_MS` gives us one operational control point to tune reliability without code changes.

### Why Gemini 2.5 Flash

I chose `gemini-2.5-flash` as the default because it has a generous free tier with no credit card required, sub-second response times for simple prompts, strong vision capabilities for document extraction, and it's cost-efficient enough to iterate rapidly during development. The abstraction means switching to Claude Haiku or GPT-4o-mini for production benchmarking is a config change, not a code change.

---

## Question 4 — Schema Design

### Short Answer

Storing dynamic fields only in JSONB/TEXT becomes expensive at scale because it weakens indexing, schema control, and query performance. I kept dynamic sections in JSONB, but promoted operationally important fields into typed columns so expiry, identity, compliance, and dedup queries remain cheap and explicit.

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

---

## Question 5 — What You Skipped

### Short Answer

I deliberately skipped auth, full webhook redelivery infrastructure, long-term object storage/retention, observability, and multi-tenant encryption. Those all matter in production, but they were lower priority than getting the core extraction, validation, reporting, and async reliability paths right.

### Detail

Each omission was a conscious tradeoff — I chose depth on the core extraction, validation, and async reliability paths over breadth across features that can be layered on later.

### 1. Authentication and Authorization

No auth layer exists; every endpoint is publicly accessible. In production this would be JWT middleware at the route level with role-based access. I skipped it because it's orthogonal to the extraction pipeline and can be added without restructuring any route logic.

### 2. Fine-Grained Webhook Retry Infrastructure

I implemented webhook delivery with attempt tracking (`webhook_attempts`, `webhook_last_error`, `webhook_delivered_at`), but retries are tied to the job lifecycle rather than a dedicated outbound scheduler. In production I would split this into its own queue with exponential retry windows (1m → 5m → 30m → 2h), idempotency keys, and a dead-letter policy. I deprioritized it because the core delivery and signing logic is in place — the retry scheduling is an infrastructure extension, not an architectural one.

### 3. File Storage

Uploaded files are stored as `BYTEA` in the jobs table and cleared after the worker finishes. Nothing is persisted long-term. In production I would move files to object storage (S3/GCS/MinIO) and keep only a reference ID in the database. I skipped this because it's an infrastructure concern that doesn't affect the extraction logic under evaluation.

### 4. Observability

Error handling catches LLM failures and returns the right HTTP codes, but there's no structured logging, no metrics pipeline, and no circuit breaker. In production I would add OpenTelemetry traces, ship logs to a centralized system, and alert on queue depth and LLM error rate. Skipped because it doesn't demonstrate architectural judgment in an assessment context.

### 5. Multi-tenant Isolation and PII Encryption

The system has no tenant scoping and stores PII (names, passport numbers, medical results) as plaintext. In production every query would include a `tenant_id` filter and sensitive columns would use envelope encryption backed by a KMS. Skipped because both concerns are horizontal — they touch every query and every table — and implementing them correctly would have consumed more time than the core pipeline warranted.

---

## Phase 10 Addendum — Prompt Versioning and Benchmark Scope

### Why prompt versioning matters in production

I added explicit prompt version metadata to validation records (and extraction already stored prompt version). In production this matters for at least four reasons:

1. **Token cost tracking by prompt generation.** Prompt edits change token footprint immediately. Version tags let me measure cost deltas per release and catch silent cost inflation.

2. **Accuracy and speed differences across prompt versions.** A “better” prompt might improve extraction quality but increase latency, or vice versa. Versioned records make A/B analysis possible without guessing which prompt produced which result.

3. **Model and requirement updates over time.** Providers change model behavior, and business requirements evolve (new compliance rules, new document types). Prompt versioning provides auditability: I can explain exactly why an output looked the way it did on a specific date.

4. **Operational rollback and incident response.** If a prompt change causes regressions, versioning enables targeted rollback and bounded blast radius analysis (“all failures are from prompt v1.1.0”).

5. **Regulatory and client audit trails.** In maritime compliance workflows, being able to trace result lineage (model + prompt version + timestamp) is valuable for defensibility.

### Why provider benchmark is still skipped

I intentionally did not publish a provider benchmark in this iteration because I don't have enough representative data yet. A credible benchmark needs:

- a sufficiently large and diverse labeled corpus (multiple document types, quality levels, scan artifacts),
- repeated runs to smooth provider variance and temporary rate-limit effects,
- normalized scoring criteria (field-level precision/recall, latency distribution, token cost per successful extraction).

Right now, the sample size is too small and skewed toward synthetic/manual test cases, so any benchmark ranking would be noisy and potentially misleading.

---

## One Thing I Would Change With More Time

**Move file storage out of PostgreSQL and into cloud object storage.**

Right now, uploaded files are stored as `BYTEA` in the `jobs` table. It works, but it's the wrong tool for the job. Binary blobs inflate the database size, complicate backups, and make it hard to implement retention policies or re-extraction workflows when prompts improve.

Given more time I would store files in S3, GCS, or Self Hosted FS on upload and save only the returned object key in the database. The jobs table would hold a `file_storage_key` column instead of `file_data BYTEA`. Benefits are immediate: the database stays lean and fast, files get their own lifecycle management (TTL policies, versioning, cross-region replication), and re-extraction becomes trivial — just fetch the key and re-send to the LLM. It also aligns with how every production document-processing system I've seen is actually built.
