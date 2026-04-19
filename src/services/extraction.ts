import crypto from "crypto";
import pool from "../db/connection";
import {
  getLLMProvider,
  parseExtractionResponse,
  buildRepairPrompt,
  buildLowConfidenceRetryPrompt,
  EXTRACTION_PROMPT,
  PROMPT_VERSION,
} from "../llm";
import { ExtractionResult } from "../types";

// ============================================================
// Helpers
// ============================================================

export function computeFileHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Parse a "DD/MM/YYYY" string from the LLM into a "YYYY-MM-DD"
 * string suitable for PostgreSQL DATE columns.
 * Returns null for non-date strings like "No Expiry", "Lifetime", null, etc.
 */
function parseDateField(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

// ============================================================
// Session management
// ============================================================

export async function ensureSession(
  sessionId?: string
): Promise<{ id: string; created: boolean }> {
  if (sessionId) {
    const exists = await pool.query(
      "SELECT id FROM sessions WHERE id = $1",
      [sessionId]
    );
    if (exists.rows.length > 0) {
      return { id: sessionId, created: false };
    }
  }
  const result = await pool.query(
    "INSERT INTO sessions DEFAULT VALUES RETURNING id"
  );
  return { id: result.rows[0].id, created: true };
}

// ============================================================
// Dedup check
// ============================================================

export interface ExistingExtraction {
  id: string;
  session_id: string;
  status: string;
  [key: string]: unknown;
}

export async function findDuplicate(
  sessionId: string,
  fileHash: string
): Promise<ExistingExtraction | null> {
  const result = await pool.query(
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
     WHERE session_id = $1 AND file_hash = $2`,
    [sessionId, fileHash]
  );
  return result.rows.length > 0 ? (result.rows[0] as ExistingExtraction) : null;
}

// ============================================================
// Store extraction
// ============================================================

interface StoreParams {
  sessionId: string;
  fileName: string;
  fileHash: string;
  mimeType: string;
  result: ExtractionResult;
  rawLlmResponse: string;
  processingTimeMs: number;
  status: "COMPLETE" | "FAILED";
  errorCode?: string;
  errorMessage?: string;
  retryCount: number;
}

export async function storeExtraction(params: StoreParams): Promise<string> {
  const {
    sessionId, fileName, fileHash, mimeType,
    result, rawLlmResponse, processingTimeMs,
    status, errorCode, errorMessage, retryCount,
  } = params;

  const r = result;

  const res = await pool.query(
    `INSERT INTO extractions (
      session_id, file_name, file_hash, mime_type,
      document_type, document_name, category, applicable_role,
      is_required, confidence, detection_reason,
      holder_name, date_of_birth, nationality, passport_number,
      sirb_number, rank,
      date_of_issue, date_of_expiry, is_expired,
      fitness_result, drug_test_result,
      issuing_authority, regulation_reference,
      fields_json, validity_json, compliance_json,
      medical_data_json, flags_json,
      summary, raw_llm_response, processing_time_ms,
      status, error_code, error_message, retry_count, prompt_version
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14, $15,
      $16, $17,
      $18, $19, $20,
      $21, $22,
      $23, $24,
      $25, $26, $27,
      $28, $29,
      $30, $31, $32,
      $33, $34, $35, $36, $37
    ) RETURNING id`,
    [
      sessionId, fileName, fileHash, mimeType,
      r.detection.documentType, r.detection.documentName,
      r.detection.category, r.detection.applicableRole,
      r.detection.isRequired, r.detection.confidence,
      r.detection.detectionReason,
      r.holder.fullName, r.holder.dateOfBirth,
      r.holder.nationality, r.holder.passportNumber,
      r.holder.sirbNumber, r.holder.rank,
      parseDateField(r.validity.dateOfIssue),
      parseDateField(r.validity.dateOfExpiry),
      r.validity.isExpired,
      r.medicalData.fitnessResult, r.medicalData.drugTestResult,
      r.compliance.issuingAuthority, r.compliance.regulationReference,
      JSON.stringify(r.fields), JSON.stringify(r.validity),
      JSON.stringify(r.compliance), JSON.stringify(r.medicalData),
      JSON.stringify(r.flags),
      r.summary, rawLlmResponse, processingTimeMs,
      status, errorCode || null, errorMessage || null,
      retryCount, PROMPT_VERSION,
    ]
  );

  return res.rows[0].id;
}

// ============================================================
// Store failed extraction
// ============================================================

export async function storeFailedExtraction(params: {
  sessionId: string;
  fileName: string;
  fileHash: string;
  mimeType: string;
  rawLlmResponse: string | null;
  processingTimeMs: number;
  errorCode: string;
  errorMessage: string;
  retryCount: number;
}): Promise<string> {
  const p = params;
  const res = await pool.query(
    `INSERT INTO extractions (
      session_id, file_name, file_hash, mime_type,
      raw_llm_response, processing_time_ms,
      status, error_code, error_message, retry_count, prompt_version
    ) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED', $7, $8, $9, $10)
    RETURNING id`,
    [
      p.sessionId, p.fileName, p.fileHash, p.mimeType,
      p.rawLlmResponse, p.processingTimeMs,
      p.errorCode, p.errorMessage, p.retryCount, PROMPT_VERSION,
    ]
  );
  return res.rows[0].id;
}

// ============================================================
// Core sync extraction pipeline
// ============================================================

export interface SyncExtractionResult {
  extractionId: string;
  sessionId: string;
  deduplicated: boolean;
  data: ExtractionResult | null;
  status: "COMPLETE" | "FAILED";
  errorCode?: string;
  errorMessage?: string;
  processingTimeMs: number;
}

export async function extractSync(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  sessionId?: string
): Promise<SyncExtractionResult> {
  const startTime = Date.now();
  const fileHash = computeFileHash(fileBuffer);

  // 1. Ensure session
  const session = await ensureSession(sessionId);

  // 2. Dedup check
  const existing = await findDuplicate(session.id, fileHash);
  if (existing) {
    return {
      extractionId: existing.id as string,
      sessionId: session.id,
      deduplicated: true,
      data: null,
      status: existing.status as "COMPLETE" | "FAILED",
      processingTimeMs: 0,
    };
  }

  // 3. Call LLM
  const provider = getLLMProvider();
  const base64 = fileBuffer.toString("base64");
  let rawResponse = "";
  let retryCount = 0;

  try {
    const llmResult = await provider.extractDocument(
      base64,
      mimeType,
      EXTRACTION_PROMPT
    );
    rawResponse = llmResult.text;

    // 4. Parse response
    let parsed: ExtractionResult;
    try {
      parsed = parseExtractionResponse(rawResponse);
    } catch {
      // Attempt repair
      retryCount++;
      const repairResult = await provider.sendPrompt(
        buildRepairPrompt(rawResponse)
      );
      rawResponse = repairResult.text;
      parsed = parseExtractionResponse(rawResponse);
    }

    // 5. Low confidence retry
    if (parsed.detection.confidence === "LOW") {
      retryCount++;
      const retryResult = await provider.extractDocument(
        base64,
        mimeType,
        buildLowConfidenceRetryPrompt(EXTRACTION_PROMPT, fileName, mimeType)
      );
      try {
        const retryParsed = parseExtractionResponse(retryResult.text);
        if (retryParsed.detection.confidence !== "LOW") {
          parsed = retryParsed;
          rawResponse = retryResult.text;
        }
      } catch {
        // Keep original parsed result if retry fails
      }
    }

    // 6. Store
    const processingTimeMs = Date.now() - startTime;
    const extractionId = await storeExtraction({
      sessionId: session.id,
      fileName,
      fileHash,
      mimeType,
      result: parsed,
      rawLlmResponse: rawResponse,
      processingTimeMs,
      status: "COMPLETE",
      retryCount,
    });

    return {
      extractionId,
      sessionId: session.id,
      deduplicated: false,
      data: parsed,
      status: "COMPLETE",
      processingTimeMs,
    };
  } catch (err: unknown) {
    const processingTimeMs = Date.now() - startTime;
    const errorMessage =
      err instanceof Error ? err.message : "Unknown extraction error";
    const errorCode = errorMessage.includes("timed out")
      ? "LLM_TIMEOUT"
      : "LLM_ERROR";

    const extractionId = await storeFailedExtraction({
      sessionId: session.id,
      fileName,
      fileHash,
      mimeType,
      rawLlmResponse: rawResponse || null,
      processingTimeMs,
      errorCode,
      errorMessage,
      retryCount,
    });

    return {
      extractionId,
      sessionId: session.id,
      deduplicated: false,
      data: null,
      status: "FAILED",
      errorCode,
      errorMessage,
      processingTimeMs,
    };
  }
}

// ============================================================
// Create async job
// ============================================================

export async function createAsyncJob(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  sessionId?: string
): Promise<{
  jobId: string;
  sessionId: string;
  deduplicated: boolean;
  existingExtractionId?: string;
}> {
  const fileHash = computeFileHash(fileBuffer);
  const session = await ensureSession(sessionId);

  // Dedup check
  const existing = await findDuplicate(session.id, fileHash);
  if (existing) {
    return {
      jobId: "",
      sessionId: session.id,
      deduplicated: true,
      existingExtractionId: existing.id as string,
    };
  }

  const result = await pool.query(
    `INSERT INTO jobs (session_id, file_name, file_hash, mime_type, file_data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [session.id, fileName, fileHash, mimeType, fileBuffer]
  );

  return {
    jobId: result.rows[0].id,
    sessionId: session.id,
    deduplicated: false,
  };
}
