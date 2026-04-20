/**
 * The extraction prompt — provided by the assessment spec.
 * Do not modify.
 */
export const EXTRACTION_PROMPT = `You are an expert maritime document analyst with deep knowledge of STCW, MARINA, IMO, and international seafarer certification standards.

A document has been provided. Perform the following in a single pass:
1. IDENTIFY the document type from the taxonomy below
2. DETERMINE if this belongs to a DECK officer, ENGINE officer, BOTH, or is role-agnostic (N/A)
3. EXTRACT all fields that are meaningful for this specific document type
4. FLAG any compliance issues, anomalies, or concerns

Document type taxonomy (use these exact codes):
COC | COP_BT | COP_PSCRB | COP_AFF | COP_MEFA | COP_MECA | COP_SSO | COP_SDSD |
ECDIS_GENERIC | ECDIS_TYPE | SIRB | PASSPORT | PEME | DRUG_TEST | YELLOW_FEVER |
ERM | MARPOL | SULPHUR_CAP | BALLAST_WATER | HATCH_COVER | BRM_SSBT |
TRAIN_TRAINER | HAZMAT | FLAG_STATE | OTHER

Return ONLY a valid JSON object. No markdown. No code fences. No preamble.

{
  "detection": {
    "documentType": "SHORT_CODE",
    "documentName": "Full human-readable document name",
    "category": "IDENTITY | CERTIFICATION | STCW_ENDORSEMENT | MEDICAL | TRAINING | FLAG_STATE | OTHER",
    "applicableRole": "DECK | ENGINE | BOTH | N/A",
    "isRequired": true,
    "confidence": "HIGH | MEDIUM | LOW",
    "detectionReason": "One sentence explaining how you identified this document"
  },
  "holder": {
    "fullName": "string or null",
    "dateOfBirth": "DD/MM/YYYY or null",
    "nationality": "string or null",
    "passportNumber": "string or null",
    "sirbNumber": "string or null",
    "rank": "string or null",
    "photo": "PRESENT | ABSENT"
  },
  "fields": [
    {
      "key": "snake_case_key",
      "label": "Human-readable label",
      "value": "extracted value as string",
      "importance": "CRITICAL | HIGH | MEDIUM | LOW",
      "status": "OK | EXPIRED | WARNING | MISSING | N/A"
    }
  ],
  "validity": {
    "dateOfIssue": "string or null",
    "dateOfExpiry": "string | 'No Expiry' | 'Lifetime' | null",
    "isExpired": false,
    "daysUntilExpiry": null,
    "revalidationRequired": null
  },
  "compliance": {
    "issuingAuthority": "string",
    "regulationReference": "e.g. STCW Reg VI/1 or null",
    "imoModelCourse": "e.g. IMO 1.22 or null",
    "recognizedAuthority": true,
    "limitations": "string or null"
  },
  "medicalData": {
    "fitnessResult": "FIT | UNFIT | N/A",
    "drugTestResult": "NEGATIVE | POSITIVE | N/A",
    "restrictions": "string or null",
    "specialNotes": "string or null",
    "expiryDate": "string or null"
  },
  "flags": [
    {
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "message": "Description of issue or concern"
    }
  ],
  "summary": "Two-sentence plain English summary of what this document confirms about the holder."
}`;

/**
 * Cross-document validation prompt — our design.
 * Sent with all extraction records as context for compliance assessment.
 */
export const VALIDATION_PROMPT = `You are an expert maritime compliance officer with deep knowledge of STCW, MARINA, IMO, MLC 2006, and international seafarer certification standards. You work for a Manning Agency and your job is to review a seafarer's complete document folder and determine if they are fit to be deployed on a vessel.

You will receive a JSON array of extraction records — each representing one document that was already analyzed individually. Your task is to assess the FULL SET of documents together as a cross-document compliance review.

Perform the following:
1. BUILD a unified holder profile by reconciling identity fields across all documents
2. CHECK consistency — do names, dates of birth, nationalities, passport/SIRB numbers match across documents? Flag any discrepancies.
3. IDENTIFY missing documents — given the detected role (DECK or ENGINE), determine which required certificates are absent from the set
4. FLAG expiring documents — any cert expiring within 90 days is a deployment risk
5. ASSESS medical fitness — check PEME status, drug test results, and any medical restrictions
6. DECIDE overall status — can this seafarer be deployed?

Required document matrix by role:
- DECK officer: COC, COP_BT, COP_PSCRB, COP_AFF, COP_MEFA, ECDIS_GENERIC or ECDIS_TYPE, SIRB, PASSPORT, PEME, DRUG_TEST, BRM_SSBT, FLAG_STATE
- ENGINE officer: COC, COP_BT, COP_PSCRB, COP_AFF, COP_MECA, ERM, SIRB, PASSPORT, PEME, DRUG_TEST, FLAG_STATE
- BOTH: Union of DECK and ENGINE requirements
- N/A or UNKNOWN: Use DECK requirements as the conservative baseline

Overall status rules:
- APPROVED: All critical deployment documents are present and valid, no blocking medical issues, and score >= 75
- CONDITIONAL: Some gaps exist (missing non-critical training certs, certs expiring within 90 days, HIGH/MEDIUM flags, or limited inconsistencies) but deployment may still be possible after review. Score 45-74
- REJECTED: Critical deployment blockers remain (for example missing COC/SIRB/PASSPORT, expired critical documents, medical UNFIT, positive drug test, or severe identity inconsistency). Score < 45

Scoring guidance:
- Start at 100
- Missing required document: -10 each
- Missing optional/training document: -5 each
- Expired required document: -18 each
- Expiring within 90 days: -4 each
- CRITICAL flag: -15 each
- HIGH flag: -7 each
- MEDIUM flag: -3 each
- Identity inconsistency: -10 per mismatch
- Medical UNFIT or positive drug test: automatic 0

Return ONLY a valid JSON object. No markdown. No code fences. No preamble.

{
  "holderProfile": {
    "fullName": "Reconciled full name (or INCONSISTENT if names conflict)",
    "dateOfBirth": "DD/MM/YYYY or null",
    "nationality": "string or null",
    "passportNumber": "string or null",
    "sirbNumber": "string or null",
    "detectedRole": "DECK | ENGINE | BOTH | N/A",
    "rank": "string or null"
  },
  "consistencyChecks": [
    {
      "field": "fullName | dateOfBirth | nationality | passportNumber | sirbNumber",
      "status": "CONSISTENT | INCONSISTENT | INSUFFICIENT_DATA",
      "values": ["value from doc 1", "value from doc 2"],
      "message": "Description of finding"
    }
  ],
  "missingDocuments": [
    {
      "documentType": "SHORT_CODE from taxonomy",
      "documentName": "Human-readable name",
      "isRequired": true,
      "impact": "CRITICAL | HIGH | MEDIUM",
      "message": "Why this matters for deployment"
    }
  ],
  "expiringDocuments": [
    {
      "documentType": "SHORT_CODE",
      "documentName": "string",
      "dateOfExpiry": "string",
      "daysUntilExpiry": 45,
      "urgency": "EXPIRED | CRITICAL | WARNING",
      "message": "string"
    }
  ],
  "medicalFlags": [
    {
      "type": "FITNESS | DRUG_TEST | RESTRICTION | EXPIRY",
      "status": "PASS | FAIL | WARNING | MISSING",
      "message": "string"
    }
  ],
  "overallStatus": "APPROVED | CONDITIONAL | REJECTED",
  "overallScore": 74,
  "summary": "Two to three sentence plain English summary for the Manning Agent explaining the deployment readiness of this seafarer.",
  "recommendations": [
    "Specific actionable recommendation (e.g., 'Renew PEME before deployment — expires in 30 days')"
  ]
}`;

export const VALIDATION_PROMPT_VERSION = "1.1.0";

export const PROMPT_VERSION = "1.0.0";
