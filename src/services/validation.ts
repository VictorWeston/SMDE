import pool from "../db/connection";
import {
  getLLMProvider,
  extractJsonFromText,
  buildRepairPrompt,
  VALIDATION_PROMPT,
  VALIDATION_PROMPT_VERSION,
} from "../llm";
import { formatExtraction } from "../routes/jobs";

// ============================================================
// Types
// ============================================================

export interface ValidationResult {
  holderProfile: Record<string, unknown>;
  consistencyChecks: Array<Record<string, unknown>>;
  missingDocuments: Array<Record<string, unknown>>;
  expiringDocuments: Array<Record<string, unknown>>;
  medicalFlags: Array<Record<string, unknown>>;
  overallStatus: "APPROVED" | "CONDITIONAL" | "REJECTED";
  overallScore: number;
  summary: string;
  recommendations: string[];
}

// ============================================================
// Core validation pipeline
// ============================================================

/**
 * Run cross-document validation for a session.
 *
 * 1. Fetch all COMPLETE extractions for the session
 * 2. Build the LLM prompt with extraction data as context
 * 3. Parse and store the validation result
 */
export async function validateSession(sessionId: string): Promise<{
  validationId: string;
  result: ValidationResult;
  processingTimeMs: number;
}> {
  const startTime = Date.now();

  // Fetch completed extractions
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
     WHERE session_id = $1 AND status = 'COMPLETE'
     ORDER BY created_at ASC`,
    [sessionId]
  );

  const extractions = extResult.rows;

  if (extractions.length < 2) {
    throw Object.assign(
      new Error("At least 2 documents are required for validation"),
      { code: "INSUFFICIENT_DOCUMENTS", statusCode: 400 }
    );
  }

  // Format extractions for LLM context
  const documents = extractions.map((e) => formatExtraction(e));
  const contextPayload = JSON.stringify(documents, null, 2);

  const fullPrompt = `${VALIDATION_PROMPT}

--- EXTRACTION RECORDS FOR THIS SESSION ---
${contextPayload}
--- END OF EXTRACTION RECORDS ---

Today's date is ${new Date().toISOString().split("T")[0]}. Use this to calculate days until expiry.`;

  // Call LLM
  const provider = getLLMProvider();
  let llmResponse;
  try {
    llmResponse = await provider.sendPrompt(fullPrompt);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`LLM call failed: ${message}`), {
      code: "LLM_ERROR",
      statusCode: 502,
    });
  }

  // Parse response — same strategy as extraction: extract JSON, repair if needed
  let parsed: ValidationResult;
  try {
    const jsonStr = extractJsonFromText(llmResponse.text);
    parsed = JSON.parse(jsonStr) as ValidationResult;
  } catch {
    // Attempt repair
    const repairPrompt = buildRepairPrompt(llmResponse.text);
    const repairResponse = await provider.sendPrompt(repairPrompt);
    const jsonStr = extractJsonFromText(repairResponse.text);
    parsed = JSON.parse(jsonStr) as ValidationResult;
  }

  const processingTimeMs = Date.now() - startTime;

  // Store in DB
  const insertResult = await pool.query(
    `INSERT INTO validations (session_id, overall_status, overall_score, result_json)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [
      sessionId,
      parsed.overallStatus,
      parsed.overallScore,
      JSON.stringify({
        ...parsed,
        sessionId,
        promptVersion: VALIDATION_PROMPT_VERSION,
        processingTimeMs,
        llmUsage: llmResponse.usage,
      }),
    ]
  );

  return {
    validationId: insertResult.rows[0].id,
    result: parsed,
    processingTimeMs,
  };
}
