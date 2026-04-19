# Smart Maritime Document Extractor (SMDE)

A production-oriented backend API that processes maritime seafarer certification documents through an LLM pipeline, extracting structured data and performing cross-document compliance validation.

## Prerequisites

- Node.js >= 18
- Docker & Docker Compose (for PostgreSQL)
- A Gemini API key (or other supported LLM provider)

## Quick Start

```bash
cp .env.example .env          # configure your API key
docker compose up -d           # start PostgreSQL
npm install && npm run dev     # start the server
```

## Environment Variables

See `.env.example` for all required variables.

### Changing the LLM Provider

To switch LLM providers, update three environment variables in `.env` — no code changes required:

```env
# Gemini (default)
LLM_PROVIDER=gemini
LLM_MODEL=gemini-2.0-flash
LLM_API_KEY=your_gemini_key

# Anthropic
LLM_PROVIDER=anthropic
LLM_MODEL=claude-haiku-4-5-20251001
LLM_API_KEY=your_anthropic_key

# OpenAI
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=your_openai_key

# Groq
LLM_PROVIDER=groq
LLM_MODEL=llama-3.2-11b-vision-preview
LLM_API_KEY=your_groq_key
```

Restart the server after changing. The `/api/health` endpoint will confirm the new provider is connected.

## API Endpoints

### `GET /api/health`

Returns service health status with dependency checks (database, LLM provider, queue).

**Response `200 OK`**
```json
{
  "status": "OK",
  "version": "1.0.0",
  "uptime": 3612,
  "dependencies": {
    "database": "OK",
    "llmProvider": "OK",
    "queue": "OK"
  },
  "timestamp": "2026-04-19T08:45:00Z"
}
```

```bash
curl http://localhost:3000/api/health
```

---

### `POST /api/extract`

Upload a maritime document for LLM-powered data extraction. Supports sync (default) and async modes.

**Request** — `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `document` | File | Yes | JPEG, PNG, or PDF (max 10MB) |
| `sessionId` | String | No | UUID to group documents. Auto-created if omitted. |

**Query params:**
- `mode=sync` (default) — blocks until extraction completes, returns full result
- `mode=async` — returns immediately with a `jobId` for polling

**Sync response `200 OK`**
```json
{
  "extractionId": "069f0c19-...",
  "sessionId": "a59002e4-...",
  "status": "COMPLETE",
  "processingTimeMs": 12957,
  "data": {
    "detection": { "documentType": "COC", "confidence": "HIGH", "..." : "..." },
    "holder": { "fullName": "John Doe", "..." : "..." },
    "fields": [ { "key": "certificate_number", "value": "12345", "..." : "..." } ],
    "validity": { "dateOfExpiry": "15/06/2027", "isExpired": false, "..." : "..." },
    "compliance": { "issuingAuthority": "MARINA", "..." : "..." },
    "medicalData": { "fitnessResult": "N/A", "..." : "..." },
    "flags": [],
    "summary": "..."
  }
}
```

**Async response `202 Accepted`**
```json
{
  "jobId": "10364003-...",
  "sessionId": "88b2dc6d-...",
  "status": "QUEUED",
  "pollUrl": "/api/jobs/10364003-..."
}
```

**Deduplicated response `200 OK`** (same file + same session — skips LLM)
```
X-Deduplicated: true
```
```json
{
  "extractionId": "069f0c19-...",
  "sessionId": "a59002e4-...",
  "deduplicated": true,
  "status": "COMPLETE"
}
```

**Error responses:**

| Code | Error | Condition |
|---|---|---|
| 400 | `MISSING_FILE` | No file in request |
| 400 | `UNSUPPORTED_FORMAT` | Not JPEG/PNG/PDF |
| 413 | `FILE_TOO_LARGE` | Exceeds 10MB |
| 422 | `LLM_ERROR` / `LLM_TIMEOUT` | Extraction failed |
| 429 | `RATE_LIMITED` | More than 10 requests/min from same IP |

```bash
# Sync extraction
curl -X POST http://localhost:3000/api/extract \
  -F "document=@seafarer_coc.jpg;type=image/jpeg"

# With session ID
curl -X POST http://localhost:3000/api/extract \
  -F "document=@passport.png;type=image/png" \
  -F "sessionId=a59002e4-5dc5-44b0-84d7-4185612f9d38"

# Async mode
curl -X POST "http://localhost:3000/api/extract?mode=async" \
  -F "document=@medical_cert.pdf;type=application/pdf"
```

---

*Remaining endpoints — implementation in progress:*

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/jobs/:jobId` | GET | Poll async extraction job status |
| `GET /api/sessions/:sessionId` | GET | List all extractions in a session |
| `POST /api/sessions/:sessionId/validate` | POST | Cross-document compliance validation |
| `GET /api/sessions/:sessionId/report` | GET | Structured compliance report |

## Database Schema

Four tables, designed around real query patterns rather than the suggested JSONB-heavy template.

### `sessions`
Lightweight session container. One session = one seafarer's document upload batch.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `created_at` | TIMESTAMPTZ | |

### `extractions`
Core table. Key fields promoted from JSONB to typed columns for indexed queries; dynamic LLM output kept as JSONB.

**What I changed from the suggested schema and why:**

| Change | Why |
|---|---|
| Added `document_name`, `category`, `is_required`, `detection_reason` | Needed for display and filtering without parsing JSON |
| Added `nationality`, `rank` | Common holder fields used in session summaries |
| Changed `date_of_issue`/`date_of_expiry` from TEXT → `DATE` | Enables native range queries (`< NOW() + INTERVAL '90 days'`) |
| Changed `is_expired` from INTEGER → `BOOLEAN` | Postgres-native, not SQLite-compat |
| Promoted `fitness_result`, `drug_test_result`, `issuing_authority`, `regulation_reference` | Filtering medical status and compliance without JSON parsing |
| Added `mime_type` | Needed for LLM API calls and validation |
| Added `error_code`, `error_message`, `retry_count`, `prompt_version` | Track failures, retries, and prompt lineage |
| Changed all JSON cols from TEXT → `JSONB` | Enables `@>` containment queries and GIN indexing if needed later |

**Indexes:**
- `(session_id, file_hash)` UNIQUE — deduplication on upload
- `(session_id)` — session document listing
- `(document_type, is_expired)` — "find all expired COCs" queries
- `(date_of_expiry)` partial — expiry alerting (only rows with expiry date)

### `jobs`
Async extraction pipeline. Stores the uploaded file as BYTEA so the worker can process it independently.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `session_id` | UUID (FK) | |
| `extraction_id` | UUID (FK, nullable) | Set when job completes |
| `file_name`, `file_hash`, `mime_type` | TEXT | File metadata for processing |
| `file_data` | BYTEA | Raw file bytes for async worker |
| `status` | TEXT | `QUEUED → PROCESSING → COMPLETE \| FAILED` |
| `error_code`, `error_message` | TEXT | Failure details |
| `retryable` | BOOLEAN | Whether the job can be retried |
| `retry_count` | INTEGER | |
| `queued_at`, `started_at`, `completed_at` | TIMESTAMPTZ | State transition timestamps |

**Indexes:**
- `(status, queued_at)` partial WHERE `IN ('QUEUED','PROCESSING')` — worker picks next job without scanning completed rows
- `(session_id)` — pending jobs per session

### `validations`
Cross-document compliance results. `overall_status` and `overall_score` promoted for querying.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `session_id` | UUID (FK) | |
| `overall_status` | TEXT | `APPROVED \| CONDITIONAL \| REJECTED` |
| `overall_score` | INTEGER | 0-100 |
| `result_json` | JSONB | Full validation result |
| `created_at` | TIMESTAMPTZ | |

**Indexes:**
- `(session_id, created_at DESC)` — get latest validation for a session
