import { Router, Request, Response, NextFunction } from "express";
import pool from "../db/connection";
import { extractionQueue, ExtractionJobData } from "../queue/worker";

const router = Router();

/**
 * POST /api/jobs/:jobId/retry
 *
 * Re-queue a FAILED job that is marked retryable.
 */
router.post(
  "/:jobId/retry",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;

      const jobResult = await pool.query(
        `SELECT id, session_id, file_name, file_hash, mime_type,
                status, retryable, file_data, webhook_url
         FROM jobs
         WHERE id = $1`,
        [jobId]
      );

      if (jobResult.rows.length === 0) {
        res.status(404).json({
          error: "JOB_NOT_FOUND",
          message: `No job found with ID ${jobId}`,
        });
        return;
      }

      const job = jobResult.rows[0];

      if (job.status !== "FAILED") {
        res.status(409).json({
          error: "JOB_NOT_FAILED",
          message: `Only FAILED jobs can be retried. Current status: ${job.status}`,
        });
        return;
      }

      if (!job.retryable) {
        res.status(409).json({
          error: "JOB_NOT_RETRYABLE",
          message: "This job is not marked retryable",
        });
        return;
      }

      if (!job.file_data) {
        res.status(409).json({
          error: "JOB_DATA_UNAVAILABLE",
          message: "Original file data is unavailable for retry",
        });
        return;
      }

      await pool.query(
        `UPDATE jobs
         SET status = 'QUEUED',
             extraction_id = NULL,
             error_code = NULL,
             error_message = NULL,
             queued_at = NOW(),
             started_at = NULL,
             completed_at = NULL,
             retry_count = 0
         WHERE id = $1`,
        [jobId]
      );

      await extractionQueue.add("extract", {
        jobId: job.id,
        sessionId: job.session_id,
        fileName: job.file_name,
        fileHash: job.file_hash,
        mimeType: job.mime_type,
        webhookUrl: job.webhook_url ?? undefined,
      } satisfies ExtractionJobData);

      res.status(202).json({
        jobId: job.id,
        sessionId: job.session_id,
        status: "QUEUED",
        pollUrl: `/api/jobs/${job.id}`,
        message: "Job re-queued for retry",
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/jobs/:jobId
 *
 * Poll the status and result of an async extraction job.
 */
router.get(
  "/:jobId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;

      const jobResult = await pool.query(
        `SELECT j.id, j.session_id, j.extraction_id, j.status,
                j.error_code, j.error_message, j.retryable, j.retry_count,
                j.queued_at, j.started_at, j.completed_at
         FROM jobs j
         WHERE j.id = $1`,
        [jobId]
      );

      if (jobResult.rows.length === 0) {
        res.status(404).json({
          error: "JOB_NOT_FOUND",
          message: `No job found with ID ${jobId}`,
        });
        return;
      }

      const job = jobResult.rows[0];

      // QUEUED — include queue position
      if (job.status === "QUEUED") {
        const posResult = await pool.query(
          `SELECT COUNT(*) as position FROM jobs
           WHERE status = 'QUEUED' AND queued_at <= $1`,
          [job.queued_at]
        );

        res.status(200).json({
          jobId: job.id,
          sessionId: job.session_id,
          status: "QUEUED",
          queuePosition: parseInt(posResult.rows[0].position, 10),
          queuedAt: job.queued_at,
        });
        return;
      }

      // PROCESSING — include started time + estimate
      if (job.status === "PROCESSING") {
        const startedAt = new Date(job.started_at);
        const elapsed = Date.now() - startedAt.getTime();
        // Average extraction takes ~12s; estimate remaining
        const estimatedTotalMs = 15000;
        const estimatedCompleteMs = Math.max(0, estimatedTotalMs - elapsed);

        res.status(200).json({
          jobId: job.id,
          sessionId: job.session_id,
          status: "PROCESSING",
          startedAt: job.started_at,
          estimatedCompleteMs,
        });
        return;
      }

      // COMPLETE — include extraction result
      if (job.status === "COMPLETE" && job.extraction_id) {
        const extResult = await pool.query(
          `SELECT id, session_id, file_name, file_hash, mime_type,
                  document_type, document_name, category, applicable_role,
                  is_required, confidence, detection_reason,
                  holder_name, date_of_birth, nationality, passport_number,
                  sirb_number, rank,
                  date_of_issue, date_of_expiry, is_expired,
                  fitness_result, drug_test_result,
                  issuing_authority, regulation_reference,
                  fields_json, validity_json, compliance_json,
                  medical_data_json, flags_json,
                  summary, processing_time_ms, status, prompt_version,
                  created_at
           FROM extractions WHERE id = $1`,
          [job.extraction_id]
        );

        const ext = extResult.rows[0];

        res.status(200).json({
          jobId: job.id,
          sessionId: job.session_id,
          status: "COMPLETE",
          extractionId: job.extraction_id,
          result: formatExtraction(ext),
          completedAt: job.completed_at,
        });
        return;
      }

      // FAILED
      res.status(200).json({
        jobId: job.id,
        sessionId: job.session_id,
        status: "FAILED",
        error: job.error_code,
        message: job.error_message,
        failedAt: job.completed_at,
        retryable: job.retryable,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Format a raw extraction DB row into the API response shape
 * matching the assessment spec.
 */
function formatExtraction(row: Record<string, unknown>) {
  return {
    id: row.id,
    sessionId: row.session_id,
    fileName: row.file_name,
    documentType: row.document_type,
    documentName: row.document_name,
    applicableRole: row.applicable_role,
    category: row.category,
    confidence: row.confidence,
    holderName: row.holder_name,
    dateOfBirth: row.date_of_birth,
    sirbNumber: row.sirb_number,
    passportNumber: row.passport_number,
    fields: row.fields_json,
    validity: row.validity_json,
    compliance: row.compliance_json,
    medicalData: row.medical_data_json,
    flags: row.flags_json,
    isExpired: row.is_expired,
    processingTimeMs: row.processing_time_ms,
    summary: row.summary,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

export { formatExtraction };
export default router;
