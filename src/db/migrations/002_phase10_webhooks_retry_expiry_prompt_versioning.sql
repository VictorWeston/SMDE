-- ============================================================
-- Phase 10 enhancements
-- - Webhook support for async jobs
-- - Validation prompt/model/provider metadata (prompt versioning)
-- ============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS webhook_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS webhook_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS webhook_last_error TEXT;

ALTER TABLE validations
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS llm_provider TEXT,
  ADD COLUMN IF NOT EXISTS llm_model TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_webhook_pending
  ON jobs (status, queued_at)
  WHERE webhook_url IS NOT NULL AND status IN ('QUEUED', 'PROCESSING', 'FAILED', 'COMPLETE');
