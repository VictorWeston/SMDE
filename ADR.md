# Architecture Decision Record — SMDE

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
