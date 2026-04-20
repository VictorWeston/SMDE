# Smart Maritime Document Extractor (SMDE)

A production-oriented backend API that processes maritime seafarer certification documents through an LLM pipeline, extracting structured data and performing cross-document compliance validation.

## Index

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
  - [Changing the LLM Provider](#changing-the-llm-provider)
- [API Endpoints](#api-endpoints)
- [Database Schema](#database-schema)
- [Testing](#testing)
  - [Unit Tests](#unit-tests)
  - [Postman Collection](#postman-collection)

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

To switch LLM providers, update these environment variables in `.env` — no code changes required:

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

# Optional: increase LLM request timeout for large documents
# 30s proved too low for some real-world vision/document validations,
# so timeout is now configurable via environment variable.
# This timeout is shared by all LLM calls via the provider layer:
# extraction, validation, repair prompts, and health checks.
LLM_TIMEOUT_MS=90000

# Optional: webhook signing + delivery timeout
WEBHOOK_SECRET=your_hmac_secret
WEBHOOK_TIMEOUT_MS=10000
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
| `webhookUrl` | String | No | Async mode only. Receives signed completion/failure event payload. |

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
  "pollUrl": "/api/jobs/10364003-...",
  "webhookConfigured": true
}
```

When `webhookUrl` is provided in async mode, SMDE sends an HMAC-signed POST on terminal job states:
- `JOB_COMPLETED`
- `JOB_FAILED`

Webhook headers:
- `X-SMDE-Event`
- `X-SMDE-Timestamp`
- `X-SMDE-Signature` (format: `sha256=<hex>`, only when `WEBHOOK_SECRET` is configured)

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

# Async mode with webhook callback
curl -X POST "http://localhost:3000/api/extract?mode=async" \
  -F "document=@medical_cert.pdf;type=application/pdf" \
  -F "sessionId=a59002e4-5dc5-44b0-84d7-4185612f9d38" \
  -F "webhookUrl=https://example.com/smde/webhooks"
```

---

### `GET /api/jobs/:jobId`

Poll the status and result of an async extraction job.

**States:**

| Status | Payload | Description |
|---|---|---|
| `QUEUED` | `queuePosition` | Waiting in queue |
| `PROCESSING` | `startedAt`, `estimatedCompleteMs` | LLM extraction in progress |
| `COMPLETE` | `extractionId`, `result`, `completedAt` | Full extraction result included |
| `FAILED` | `error`, `message`, `retryable`, `failedAt` | Extraction failed |

**Response `200 OK`** (COMPLETE example)
```json
{
  "jobId": "5d427818-...",
  "sessionId": "1670eb0d-...",
  "status": "COMPLETE",
  "extractionId": "6a0e358d-...",
  "result": {
    "documentType": "COC",
    "holderName": "Juan Dela Cruz",
    "..."
  },
  "completedAt": "2026-04-19T17:25:34.886Z"
}
```

**Error `404`** — `JOB_NOT_FOUND`

```bash
curl http://localhost:3000/api/jobs/5d427818-62af-4cdd-b884-27d4627c89d6
```

### `POST /api/jobs/:jobId/retry`

Re-queue a failed async extraction job.

Rules:
- Job must exist
- Job status must be `FAILED`
- Job must be marked `retryable`
- Original `file_data` must still exist

**Response `202 Accepted`**
```json
{
  "jobId": "5d427818-...",
  "sessionId": "1670eb0d-...",
  "status": "QUEUED",
  "pollUrl": "/api/jobs/5d427818-...",
  "message": "Job re-queued for retry"
}
```

```bash
curl -X POST http://localhost:3000/api/jobs/5d427818-62af-4cdd-b884-27d4627c89d6/retry
```

---

### `GET /api/sessions/:sessionId`

Returns all documents in a session with health status and pending jobs.

**Response `200 OK`**
```json
{
  "sessionId": "b6a3fe00-...",
  "documentCount": 5,
  "detectedRole": "DECK",
  "overallHealth": "WARN",
  "documents": [
    {
      "id": "069f0c19-...",
      "fileName": "coc.jpg",
      "documentType": "COC",
      "holderName": "Juan Dela Cruz",
      "confidence": "HIGH",
      "isExpired": false,
      "flagCount": 0,
      "criticalFlagCount": 0,
      "createdAt": "2026-04-19T08:30:00Z"
    }
  ],
  "pendingJobs": []
}
```

`overallHealth` is derived from session data:
- **OK** — no expired certs, no CRITICAL flags
- **WARN** — certs expiring within 90 days or MEDIUM/HIGH flags
- **CRITICAL** — expired required certs or CRITICAL flags

**Error `404`** — `SESSION_NOT_FOUND`

```bash
curl http://localhost:3000/api/sessions/b6a3fe00-37b6-483c-a111-3eacaa48c983
```

### `GET /api/sessions/:sessionId/expiring?withinDays=90`

Returns expired or soon-to-expire documents in the session.

**Query params:**
- `withinDays` (optional, default `90`, range `1..3650`)

**Response `200 OK`**
```json
{
  "sessionId": "b6a3fe00-...",
  "withinDays": 90,
  "count": 2,
  "documents": [
    {
      "extractionId": "069f0c19-...",
      "fileName": "peme.jpg",
      "documentType": "PEME",
      "documentName": "Pre-Employment Medical Examination",
      "dateOfExpiry": "2026-06-03",
      "isExpired": false,
      "daysUntilExpiry": 45,
      "urgency": "WARNING"
    }
  ]
}
```

```bash
curl "http://localhost:3000/api/sessions/b6a3fe00-37b6-483c-a111-3eacaa48c983/expiring?withinDays=90"
```

---

### `POST /api/sessions/:sessionId/validate`

Cross-document compliance validation. Sends all extraction records to the LLM with a structured prompt that checks identity consistency, missing documents, expiring certs, medical fitness, and overall deployment readiness.

Requires at least 2 completed documents in the session.

**Response `200 OK`**
```json
{
  "sessionId": "b6a3fe00-...",
  "validationId": "8c7be816-...",
  "holderProfile": {
    "fullName": "Juan Dela Cruz",
    "detectedRole": "DECK",
    "..."
  },
  "consistencyChecks": [
    { "field": "fullName", "status": "CONSISTENT", "..." }
  ],
  "missingDocuments": [
    { "documentType": "BRM_SSBT", "impact": "HIGH", "..." }
  ],
  "expiringDocuments": [
    { "documentType": "PEME", "daysUntilExpiry": 45, "urgency": "WARNING", "..." }
  ],
  "medicalFlags": [
    { "type": "FITNESS", "status": "PASS", "..." }
  ],
  "overallStatus": "CONDITIONAL",
  "overallScore": 74,
  "promptVersion": "1.0.0",
  "llmProvider": "gemini",
  "llmModel": "gemini-2.5-flash",
  "summary": "Seafarer is conditionally deployable...",
  "recommendations": ["Renew PEME before deployment — expires in 45 days"],
  "processingTimeMs": 14079,
  "validatedAt": "2026-04-19T20:17:24.657Z"
}
```

**Scoring:** Starts at 100, deductions for missing/expired documents, flags, and identity mismatches. Medical UNFIT or positive drug test = automatic 0. Status thresholds: APPROVED >= 80, CONDITIONAL 50-79, REJECTED < 50.

**Error responses:**

| Code | Error | Condition |
|---|---|---|
| 400 | `INSUFFICIENT_DOCUMENTS` | Fewer than 2 completed extractions |
| 404 | `SESSION_NOT_FOUND` | Invalid session ID |
| 502 | `LLM_ERROR` | LLM provider failed |

```bash
curl -X POST http://localhost:3000/api/sessions/b6a3fe00-37b6-483c-a111-3eacaa48c983/validate
```

---

### `GET /api/sessions/:sessionId/report`

Structured compliance report derived entirely from database data — no LLM call. Designed for Manning Agent hire/no-hire decisions.

**Response `200 OK`**
```json
{
  "sessionId": "b6a3fe00-...",
  "generatedAt": "2026-04-19T20:26:09.597Z",
  "seafarer": {
    "fullName": "Juan Dela Cruz",
    "nationality": "Filipino",
    "passportNumber": "P1234567",
    "sirbNumber": "SIRB-2024-001",
    "rank": "Second Officer"
  },
  "detectedRole": "DECK",
  "documentInventory": {
    "total": 10,
    "present": [{ "documentType": "COC", "status": "PRESENT" }],
    "missing": [{ "documentType": "BRM_SSBT", "impact": "HIGH" }],
    "additional": [{ "documentType": "YELLOW_FEVER", "documentName": "Yellow Fever Vaccination" }]
  },
  "expiryTimeline": [
    { "documentType": "PEME", "daysUntilExpiry": 45, "urgency": "WARNING" }
  ],
  "flagSummary": {
    "total": 3, "critical": 0, "high": 1, "medium": 2, "low": 0,
    "items": [{ "severity": "HIGH", "message": "..." }]
  },
  "medicalStatus": {
    "fitnessResult": "FIT",
    "drugTestResult": "NEGATIVE",
    "pemeExpiry": "2026-06-03",
    "pemeExpired": false
  },
  "latestValidation": {
    "validationId": "8c7be816-...",
    "overallStatus": "CONDITIONAL",
    "overallScore": 74,
    "promptVersion": "1.0.0",
    "llmProvider": "gemini",
    "llmModel": "gemini-2.5-flash",
    "summary": "...",
    "recommendations": ["..."],
    "validatedAt": "2026-04-19T20:17:24.412Z"
  },
  "complianceReadiness": {
    "status": "CONDITIONAL",
    "score": 74,
    "blockers": ["Missing required document: BRM_SSBT"],
    "validated": true
  }
}
```

The report front-loads **blockers** (what stops deployment) and **actions** (from the latest validation recommendations). `complianceReadiness.validated` indicates whether an LLM validation has been run — if `false`, the status and score are estimated from document data alone.

**Error `404`** — `SESSION_NOT_FOUND`

```bash
curl http://localhost:3000/api/sessions/b6a3fe00-37b6-483c-a111-3eacaa48c983/report
```

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

---

## Testing

### Unit Tests

JSON extraction and repair logic is covered by Jest unit tests:

```bash
npm test
```

Tests cover:
- `extractJsonFromText` — markdown fence stripping, preamble/trailing removal, nested braces, error cases
- `parseExtractionResponse` — end-to-end parse from LLM output to typed result
- `buildRepairPrompt` — repair prompt content validation
- `buildLowConfidenceRetryPrompt` — retry prompt includes file context and confidence reference

### Postman Collection

A full Postman collection is included at [`postman/SMDE-API.postman_collection.json`](postman/SMDE-API.postman_collection.json).

**Import:** File → Import → select the JSON file.

**Setup:** Set the `baseUrl` collection variable (default: `http://localhost:3000`).

**Included requests:**
| Request | Method | Tests |
|---|---|---|
| Health Check | GET | Status 200, `status: "OK"` |
| Extract — Sync | POST | 200, has `extractionId`, status COMPLETE, has `data` |
| Extract — Async | POST | 202, has `jobId` + `pollUrl`, status QUEUED |
| Extract — Async Mode With Webhook | POST | 202, webhook configured = true |
| Extract — Missing File | POST | 400, `MISSING_FILE` |
| Poll Job Status | GET | 200, valid status enum |
| Retry Failed Job | POST | 202, status QUEUED |
| Poll Job — Not Found | GET | 404, `JOB_NOT_FOUND` |
| Get Session | GET | 200, has documents array + health |
| Get Expiring Documents | GET | 200, has count + documents array |
| Get Session — Not Found | GET | 404, `SESSION_NOT_FOUND` |
| Validate Session | POST | 200, has `overallStatus` + `overallScore` |
| Validate — Insufficient | POST | 400, `INSUFFICIENT_DOCUMENTS` |
| Get Compliance Report | GET | 200, full report shape |
| Report — Not Found | GET | 404, `SESSION_NOT_FOUND` |

Collection variables (`sessionId`, `jobId`, `retryJobId`, `webhookUrl`, `extractionId`) are available; `sessionId`, `jobId`, and `extractionId` are auto-populated from response data.
