import { Router, Request, Response, NextFunction } from "express";
import pool from "../db/connection";
import { formatExtraction } from "./jobs";
import { validateSession } from "../services/validation";
import { buildReport } from "../services/report";

const router = Router();

/**
 * GET /api/sessions/:sessionId/expiring?withinDays=90
 *
 * Returns documents that are expired or expiring within N days.
 */
router.get(
  "/:sessionId/expiring",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const withinDaysRaw = req.query.withinDays as string | undefined;
      const withinDays = withinDaysRaw ? Number(withinDaysRaw) : 90;

      if (!Number.isFinite(withinDays) || withinDays <= 0 || withinDays > 3650) {
        res.status(400).json({
          error: "INVALID_WITHIN_DAYS",
          message: "withinDays must be a number between 1 and 3650",
        });
        return;
      }

      const sessionResult = await pool.query(
        "SELECT id FROM sessions WHERE id = $1",
        [sessionId]
      );

      if (sessionResult.rows.length === 0) {
        res.status(404).json({
          error: "SESSION_NOT_FOUND",
          message: `No session found with ID ${sessionId}`,
        });
        return;
      }

      const expiringResult = await pool.query(
        `SELECT id, file_name, document_type, document_name, date_of_expiry, is_expired
         FROM extractions
         WHERE session_id = $1
           AND status = 'COMPLETE'
           AND date_of_expiry IS NOT NULL
           AND date_of_expiry <= (CURRENT_DATE + ($2::int * INTERVAL '1 day'))
         ORDER BY date_of_expiry ASC`,
        [sessionId, withinDays]
      );

      const now = new Date();
      const documents = expiringResult.rows.map((row) => {
        const expiry = new Date(row.date_of_expiry as string);
        const daysUntilExpiry = Math.ceil(
          (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        );
        let urgency = "OK";
        if (daysUntilExpiry < 0) urgency = "EXPIRED";
        else if (daysUntilExpiry <= 30) urgency = "CRITICAL";
        else if (daysUntilExpiry <= 90) urgency = "WARNING";

        return {
          extractionId: row.id,
          fileName: row.file_name,
          documentType: row.document_type,
          documentName: row.document_name,
          dateOfExpiry: row.date_of_expiry,
          isExpired: row.is_expired,
          daysUntilExpiry,
          urgency,
        };
      });

      res.status(200).json({
        sessionId,
        withinDays,
        count: documents.length,
        documents,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/sessions/:sessionId
 *
 * Returns a summary of all documents in the session, pending jobs,
 * and computed health status.
 */
router.get(
  "/:sessionId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // Check session exists
      const sessionResult = await pool.query(
        "SELECT id, created_at FROM sessions WHERE id = $1",
        [sessionId]
      );

      if (sessionResult.rows.length === 0) {
        res.status(404).json({
          error: "SESSION_NOT_FOUND",
          message: `No session found with ID ${sessionId}`,
        });
        return;
      }

      // Fetch all completed extractions for this session
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
         FROM extractions
         WHERE session_id = $1
         ORDER BY created_at ASC`,
        [sessionId]
      );

      // Fetch pending jobs
      const jobsResult = await pool.query(
        `SELECT id, file_name, status, queued_at, started_at
         FROM jobs
         WHERE session_id = $1 AND status IN ('QUEUED', 'PROCESSING')
         ORDER BY queued_at ASC`,
        [sessionId]
      );

      const extractions = extResult.rows;
      const pendingJobs = jobsResult.rows;

      // Derive detectedRole from documents
      const detectedRole = deriveRole(extractions);

      // Derive overallHealth
      const overallHealth = deriveHealth(extractions);

      // Build document summaries for the response
      const documents = extractions
        .filter((e) => e.status === "COMPLETE")
        .map((e) => ({
          id: e.id,
          fileName: e.file_name,
          documentType: e.document_type,
          documentName: e.document_name,
          applicableRole: e.applicable_role,
          category: e.category,
          holderName: e.holder_name,
          confidence: e.confidence,
          isExpired: e.is_expired,
          flagCount: Array.isArray(e.flags_json) ? e.flags_json.length : 0,
          criticalFlagCount: Array.isArray(e.flags_json)
            ? e.flags_json.filter(
                (f: { severity: string }) => f.severity === "CRITICAL"
              ).length
            : 0,
          createdAt: e.created_at,
        }));

      res.status(200).json({
        sessionId,
        documentCount: documents.length,
        detectedRole,
        overallHealth,
        documents,
        pendingJobs: pendingJobs.map((j) => ({
          jobId: j.id,
          fileName: j.file_name,
          status: j.status,
          queuedAt: j.queued_at,
          startedAt: j.started_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Derive the detected role from extraction records.
 * If any doc says DECK and none say ENGINE → DECK.
 * If any doc says ENGINE and none say DECK → ENGINE.
 * If both → BOTH. If none → N/A.
 */
function deriveRole(
  extractions: Array<{ applicable_role: string; status: string }>
): string {
  const completed = extractions.filter((e) => e.status === "COMPLETE");
  const roles = new Set(completed.map((e) => e.applicable_role));

  const hasDeck = roles.has("DECK") || roles.has("BOTH");
  const hasEngine = roles.has("ENGINE") || roles.has("BOTH");

  if (hasDeck && hasEngine) return "BOTH";
  if (hasDeck) return "DECK";
  if (hasEngine) return "ENGINE";
  return "N/A";
}

/**
 * Derive overall health:
 * - CRITICAL: any CRITICAL flags OR any expired required cert
 * - WARN: any MEDIUM/HIGH flags OR certs expiring within 90 days
 * - OK: none of the above
 */
function deriveHealth(
  extractions: Array<{
    status: string;
    is_expired: boolean;
    is_required: boolean;
    date_of_expiry: string | null;
    flags_json: Array<{ severity: string }> | null;
  }>
): string {
  const completed = extractions.filter((e) => e.status === "COMPLETE");
  let hasCritical = false;
  let hasWarn = false;

  const now = new Date();
  const ninetyDaysFromNow = new Date(
    now.getTime() + 90 * 24 * 60 * 60 * 1000
  );

  for (const ext of completed) {
    // Check flags
    const flags = ext.flags_json ?? [];
    for (const flag of flags) {
      if (flag.severity === "CRITICAL") hasCritical = true;
      if (flag.severity === "HIGH" || flag.severity === "MEDIUM")
        hasWarn = true;
    }

    // Expired required cert → CRITICAL
    if (ext.is_expired && ext.is_required) {
      hasCritical = true;
    }

    // Expiring within 90 days → WARN
    if (ext.date_of_expiry) {
      const expiry = new Date(ext.date_of_expiry);
      if (expiry <= ninetyDaysFromNow && expiry > now) {
        hasWarn = true;
      }
    }
  }

  if (hasCritical) return "CRITICAL";
  if (hasWarn) return "WARN";
  return "OK";
}

/**
 * POST /api/sessions/:sessionId/validate
 *
 * Send all extraction records to the LLM for cross-document
 * compliance assessment.
 */
router.post(
  "/:sessionId/validate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // Check session exists
      const sessionResult = await pool.query(
        "SELECT id FROM sessions WHERE id = $1",
        [sessionId]
      );

      if (sessionResult.rows.length === 0) {
        res.status(404).json({
          error: "SESSION_NOT_FOUND",
          message: `No session found with ID ${sessionId}`,
        });
        return;
      }

      const sid = sessionId as string;
      const { validationId, result, processingTimeMs, promptVersion, llmProvider, llmModel } =
        await validateSession(sid);

      res.status(200).json({
        sessionId: sid,
        validationId,
        ...result,
        promptVersion,
        llmProvider,
        llmModel,
        processingTimeMs,
        validatedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const error = err as {
        code?: string;
        statusCode?: number;
        message?: string;
      };
      if (error.code === "INSUFFICIENT_DOCUMENTS") {
        res.status(400).json({
          error: "INSUFFICIENT_DOCUMENTS",
          message:
            "At least 2 completed documents are required for cross-document validation",
        });
        return;
      }
      if (error.code === "LLM_ERROR") {
        res.status(502).json({
          error: "LLM_ERROR",
          message: error.message ?? "LLM provider failed during validation",
        });
        return;
      }
      next(err);
    }
  }
);

/**
 * GET /api/sessions/:sessionId/report
 *
 * Structured compliance report derived entirely from DB data.
 * No LLM call — deterministic output for Manning Agent decision-making.
 */
router.get(
  "/:sessionId/report",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // Check session exists
      const sessionResult = await pool.query(
        "SELECT id FROM sessions WHERE id = $1",
        [sessionId]
      );

      if (sessionResult.rows.length === 0) {
        res.status(404).json({
          error: "SESSION_NOT_FOUND",
          message: `No session found with ID ${sessionId}`,
        });
        return;
      }

      const report = await buildReport(sessionId as string);
      res.status(200).json(report);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
