-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- SESSIONS
-- ============================================================
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- EXTRACTIONS
-- ============================================================
CREATE TABLE extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- File metadata
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,               -- SHA-256 hex for dedup
  mime_type TEXT NOT NULL,

  -- Detection (promoted from LLM response for querying)
  document_type TEXT,                    -- COC, PEME, PASSPORT, etc.
  document_name TEXT,                    -- Human-readable name
  category TEXT,                         -- IDENTITY, CERTIFICATION, MEDICAL, etc.
  applicable_role TEXT,                  -- DECK, ENGINE, BOTH, N/A
  is_required BOOLEAN,
  confidence TEXT,                       -- HIGH, MEDIUM, LOW
  detection_reason TEXT,

  -- Holder (promoted — common query/display fields)
  holder_name TEXT,
  date_of_birth TEXT,
  nationality TEXT,
  passport_number TEXT,
  sirb_number TEXT,
  rank TEXT,

  -- Validity (key fields promoted for WHERE/ORDER BY)
  date_of_issue DATE,
  date_of_expiry DATE,
  is_expired BOOLEAN NOT NULL DEFAULT FALSE,

  -- Medical (promoted for quick filtering)
  fitness_result TEXT,                   -- FIT, UNFIT, N/A
  drug_test_result TEXT,                 -- NEGATIVE, POSITIVE, N/A

  -- Compliance (promoted for querying)
  issuing_authority TEXT,
  regulation_reference TEXT,

  -- Dynamic / full LLM response sections (JSONB — read-through only)
  fields_json JSONB,                     -- dynamic fields[] array
  validity_json JSONB,                   -- full validity object
  compliance_json JSONB,                 -- full compliance object
  medical_data_json JSONB,              -- full medicalData object
  flags_json JSONB DEFAULT '[]'::jsonb,  -- flags[] array

  -- Processing metadata
  summary TEXT,
  raw_llm_response TEXT,                 -- never discard
  processing_time_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'COMPLETE', -- COMPLETE, FAILED
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  prompt_version TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedup: same file in same session → skip LLM
CREATE UNIQUE INDEX idx_extractions_dedup ON extractions(session_id, file_hash);

-- Session document listing
CREATE INDEX idx_extractions_session ON extractions(session_id);

-- "All sessions with expired COC" type queries
CREATE INDEX idx_extractions_type_expired ON extractions(document_type, is_expired);

-- Expiry alerting: docs expiring within N days (partial — only rows with expiry)
CREATE INDEX idx_extractions_expiry ON extractions(date_of_expiry)
  WHERE date_of_expiry IS NOT NULL;

-- ============================================================
-- JOBS (async extraction pipeline)
-- ============================================================
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  extraction_id UUID REFERENCES extractions(id) ON DELETE SET NULL,

  -- Job metadata
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_data BYTEA,                       -- stored file for async processing

  -- State machine: QUEUED → PROCESSING → COMPLETE | FAILED
  status TEXT NOT NULL DEFAULT 'QUEUED',
  error_code TEXT,
  error_message TEXT,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  retry_count INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Worker picks next job (partial — only active jobs)
CREATE INDEX idx_jobs_active ON jobs(status, queued_at)
  WHERE status IN ('QUEUED', 'PROCESSING');

-- Session's pending jobs
CREATE INDEX idx_jobs_session ON jobs(session_id);

-- ============================================================
-- VALIDATIONS (cross-document compliance results)
-- ============================================================
CREATE TABLE validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- Promoted for querying without parsing JSON
  overall_status TEXT NOT NULL,           -- APPROVED, CONDITIONAL, REJECTED
  overall_score INTEGER NOT NULL,

  -- Full validation result
  result_json JSONB NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Get latest validation for a session
CREATE INDEX idx_validations_session ON validations(session_id, created_at DESC);
