import pool from "../db/connection";

// Required cert matrix — same as in the validation prompt
const REQUIRED_CERTS: Record<string, string[]> = {
  DECK: [
    "COC", "COP_BT", "COP_PSCRB", "COP_AFF", "COP_MEFA",
    "ECDIS_GENERIC", "SIRB", "PASSPORT", "PEME", "DRUG_TEST",
    "BRM_SSBT", "FLAG_STATE",
  ],
  ENGINE: [
    "COC", "COP_BT", "COP_PSCRB", "COP_AFF", "COP_MECA",
    "ERM", "SIRB", "PASSPORT", "PEME", "DRUG_TEST", "FLAG_STATE",
  ],
};

// ECDIS alternatives — if either is present, the ECDIS requirement is met
const ECDIS_ALTERNATIVES = ["ECDIS_GENERIC", "ECDIS_TYPE"];

/**
 * Build a compliance report entirely from database data — no LLM call.
 * Designed for what a Manning Agent needs to make a hire/no-hire decision.
 */
export async function buildReport(sessionId: string) {
  // Fetch completed extractions
  const extResult = await pool.query(
    `SELECT id, file_name, document_type, document_name, category,
            applicable_role, is_required, confidence,
            holder_name, date_of_birth, nationality, passport_number,
            sirb_number, rank,
            date_of_issue, date_of_expiry, is_expired,
            fitness_result, drug_test_result,
            issuing_authority, flags_json,
            summary, created_at
     FROM extractions
     WHERE session_id = $1 AND status = 'COMPLETE'
     ORDER BY created_at ASC`,
    [sessionId]
  );

  const extractions = extResult.rows;

  // ── Seafarer profile (reconciled from all docs) ──────────
  const seafarer = reconcileSeafarer(extractions);

  // ── Detected role ────────────────────────────────────────
  const detectedRole = deriveRole(extractions);

  // ── Document inventory ───────────────────────────────────
  const presentTypes = new Set(extractions.map((e: Record<string, unknown>) => e.document_type as string));
  const requiredList = getRequiredCerts(detectedRole);

  const documentInventory = {
    total: extractions.length,
    present: requiredList
      .filter((code) => isCertPresent(code, presentTypes))
      .map((code) => ({
        documentType: code,
        status: "PRESENT" as const,
      })),
    missing: requiredList
      .filter((code) => !isCertPresent(code, presentTypes))
      .map((code) => ({
        documentType: code,
        impact: ["COC", "SIRB", "PASSPORT", "PEME", "DRUG_TEST"].includes(code)
          ? "CRITICAL"
          : "HIGH",
      })),
    additional: extractions
      .filter((e: Record<string, unknown>) => !requiredList.includes(e.document_type as string))
      .map((e: Record<string, unknown>) => ({
        documentType: e.document_type,
        documentName: e.document_name,
      })),
  };

  // ── Expiry timeline (sorted soonest-first) ───────────────
  const now = new Date();
  const expiryTimeline = extractions
    .filter((e: Record<string, unknown>) => e.date_of_expiry != null)
    .map((e: Record<string, unknown>) => {
      const expiry = new Date(e.date_of_expiry as string);
      const daysUntilExpiry = Math.ceil(
        (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );
      let urgency: string;
      if (daysUntilExpiry < 0) urgency = "EXPIRED";
      else if (daysUntilExpiry <= 30) urgency = "CRITICAL";
      else if (daysUntilExpiry <= 90) urgency = "WARNING";
      else urgency = "OK";

      return {
        documentType: e.document_type,
        documentName: e.document_name,
        dateOfExpiry: e.date_of_expiry,
        daysUntilExpiry,
        urgency,
      };
    })
    .sort(
      (a: { daysUntilExpiry: number }, b: { daysUntilExpiry: number }) =>
        a.daysUntilExpiry - b.daysUntilExpiry
    );

  // ── Flag summary ─────────────────────────────────────────
  const allFlags: Array<{ severity: string; message: string }> = [];
  for (const ext of extractions) {
    const flags = (ext.flags_json as Array<{ severity: string; message: string }>) ?? [];
    allFlags.push(...flags);
  }
  const flagSummary = {
    total: allFlags.length,
    critical: allFlags.filter((f) => f.severity === "CRITICAL").length,
    high: allFlags.filter((f) => f.severity === "HIGH").length,
    medium: allFlags.filter((f) => f.severity === "MEDIUM").length,
    low: allFlags.filter((f) => f.severity === "LOW").length,
    items: allFlags,
  };

  // ── Medical status ───────────────────────────────────────
  const peme = extractions.find((e: Record<string, unknown>) => e.document_type === "PEME");
  const drugTest = extractions.find((e: Record<string, unknown>) => e.document_type === "DRUG_TEST");

  const medicalStatus = {
    fitnessResult: peme ? (peme.fitness_result as string) : "NOT_SUBMITTED",
    drugTestResult: drugTest ? (drugTest.drug_test_result as string) : "NOT_SUBMITTED",
    pemeExpiry: peme ? (peme.date_of_expiry as string | null) : null,
    pemeExpired: peme ? (peme.is_expired as boolean) : null,
  };

  // ── Latest validation (if any) ───────────────────────────
  const valResult = await pool.query(
    `SELECT id, overall_status, overall_score, result_json, created_at
     FROM validations
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );

  let latestValidation = null;
  if (valResult.rows.length > 0) {
    const v = valResult.rows[0];
    const full = v.result_json as Record<string, unknown>;
    latestValidation = {
      validationId: v.id,
      overallStatus: v.overall_status,
      overallScore: v.overall_score,
      summary: full.summary ?? null,
      recommendations: full.recommendations ?? [],
      validatedAt: v.created_at,
    };
  }

  // ── Compliance readiness ─────────────────────────────────
  const blockers: string[] = [];

  // Missing critical docs
  for (const doc of documentInventory.missing) {
    if (doc.impact === "CRITICAL") {
      blockers.push(`Missing required document: ${doc.documentType}`);
    }
  }

  // Expired docs
  for (const item of expiryTimeline) {
    if (item.urgency === "EXPIRED") {
      blockers.push(`Expired: ${item.documentType} (${item.documentName})`);
    }
  }

  // Medical blockers
  if (medicalStatus.fitnessResult === "UNFIT") {
    blockers.push("Seafarer declared medically UNFIT");
  }
  if (medicalStatus.drugTestResult === "POSITIVE") {
    blockers.push("Positive drug test result");
  }
  if (medicalStatus.fitnessResult === "NOT_SUBMITTED") {
    blockers.push("PEME not submitted");
  }
  if (medicalStatus.drugTestResult === "NOT_SUBMITTED") {
    blockers.push("Drug test not submitted");
  }

  // Critical flags
  if (flagSummary.critical > 0) {
    blockers.push(`${flagSummary.critical} CRITICAL flag(s) on uploaded documents`);
  }

  // Derive status from blockers if no validation exists
  let readinessStatus: string;
  let readinessScore: number;

  if (latestValidation) {
    readinessStatus = latestValidation.overallStatus;
    readinessScore = latestValidation.overallScore;
  } else {
    // Compute from data
    if (blockers.length === 0) {
      readinessStatus = "LIKELY_APPROVED";
      readinessScore = 100 - flagSummary.high * 10 - flagSummary.medium * 5;
    } else {
      const criticalBlockers = blockers.filter(
        (b) => b.startsWith("Missing") || b.startsWith("Expired") || b.includes("UNFIT") || b.includes("POSITIVE")
      );
      readinessStatus = criticalBlockers.length > 0 ? "LIKELY_REJECTED" : "NEEDS_REVIEW";
      readinessScore = Math.max(0, 100 - criticalBlockers.length * 20 - flagSummary.high * 10 - flagSummary.medium * 5);
    }
  }

  const complianceReadiness = {
    status: readinessStatus,
    score: readinessScore,
    blockers,
    validated: latestValidation !== null,
  };

  return {
    sessionId,
    generatedAt: new Date().toISOString(),
    seafarer,
    detectedRole,
    documentInventory,
    expiryTimeline,
    flagSummary,
    medicalStatus,
    latestValidation,
    complianceReadiness,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function reconcileSeafarer(extractions: Array<Record<string, unknown>>) {
  // Take the first non-null value for each field across all extractions
  let fullName: string | null = null;
  let dateOfBirth: string | null = null;
  let nationality: string | null = null;
  let passportNumber: string | null = null;
  let sirbNumber: string | null = null;
  let rank: string | null = null;

  for (const ext of extractions) {
    if (!fullName && ext.holder_name) fullName = ext.holder_name as string;
    if (!dateOfBirth && ext.date_of_birth) dateOfBirth = ext.date_of_birth as string;
    if (!nationality && ext.nationality) nationality = ext.nationality as string;
    if (!passportNumber && ext.passport_number) passportNumber = ext.passport_number as string;
    if (!sirbNumber && ext.sirb_number) sirbNumber = ext.sirb_number as string;
    if (!rank && ext.rank) rank = ext.rank as string;
  }

  return { fullName, dateOfBirth, nationality, passportNumber, sirbNumber, rank };
}

function deriveRole(extractions: Array<Record<string, unknown>>): string {
  const roles = new Set(extractions.map((e) => e.applicable_role as string));
  const hasDeck = roles.has("DECK") || roles.has("BOTH");
  const hasEngine = roles.has("ENGINE") || roles.has("BOTH");
  if (hasDeck && hasEngine) return "BOTH";
  if (hasDeck) return "DECK";
  if (hasEngine) return "ENGINE";
  return "N/A";
}

function getRequiredCerts(role: string): string[] {
  if (role === "BOTH") {
    return [...new Set([...REQUIRED_CERTS.DECK, ...REQUIRED_CERTS.ENGINE])];
  }
  // N/A defaults to DECK (conservative baseline)
  return REQUIRED_CERTS[role] ?? REQUIRED_CERTS.DECK;
}

function isCertPresent(code: string, presentTypes: Set<string>): boolean {
  // ECDIS_GENERIC can be satisfied by either ECDIS_GENERIC or ECDIS_TYPE
  if (ECDIS_ALTERNATIVES.includes(code)) {
    return ECDIS_ALTERNATIVES.some((alt) => presentTypes.has(alt));
  }
  return presentTypes.has(code);
}
