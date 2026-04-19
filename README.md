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

*Remaining endpoints — implementation in progress:*

| Endpoint | Method | Description |
|---|---|---|
| `POST /api/extract` | POST | Upload & extract document via LLM (sync/async) |
| `GET /api/jobs/:jobId` | GET | Poll async extraction job status |
| `GET /api/sessions/:sessionId` | GET | List all extractions in a session |
| `POST /api/sessions/:sessionId/validate` | POST | Cross-document compliance validation |
| `GET /api/sessions/:sessionId/report` | GET | Structured compliance report |
