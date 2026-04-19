// Shared types for the SMDE application

// ============================================================
// LLM Provider Types
// ============================================================

export interface LLMResponse {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface LLMProvider {
  readonly name: string;

  /**
   * Send a document image to the LLM for extraction.
   * @param base64 - Base64-encoded file data
   * @param mimeType - MIME type of the file
   * @param prompt - The extraction prompt
   * @returns Raw text response from the LLM
   */
  extractDocument(
    base64: string,
    mimeType: string,
    prompt: string
  ): Promise<LLMResponse>;

  /**
   * Send a text-only prompt (used for repair, validation, etc.)
   * @param prompt - The text prompt
   * @returns Raw text response from the LLM
   */
  sendPrompt(prompt: string): Promise<LLMResponse>;

  /**
   * Quick connectivity check.
   * @returns true if the provider is reachable
   */
  checkHealth(): Promise<boolean>;
}

// ============================================================
// LLM Extraction Result (parsed from LLM JSON response)
// ============================================================

export interface ExtractionDetection {
  documentType: string;
  documentName: string;
  category: string;
  applicableRole: string;
  isRequired: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  detectionReason: string;
}

export interface ExtractionHolder {
  fullName: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  passportNumber: string | null;
  sirbNumber: string | null;
  rank: string | null;
  photo: "PRESENT" | "ABSENT";
}

export interface ExtractionField {
  key: string;
  label: string;
  value: string;
  importance: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  status: "OK" | "EXPIRED" | "WARNING" | "MISSING" | "N/A";
}

export interface ExtractionValidity {
  dateOfIssue: string | null;
  dateOfExpiry: string | null;
  isExpired: boolean;
  daysUntilExpiry: number | null;
  revalidationRequired: boolean | null;
}

export interface ExtractionCompliance {
  issuingAuthority: string;
  regulationReference: string | null;
  imoModelCourse: string | null;
  recognizedAuthority: boolean;
  limitations: string | null;
}

export interface ExtractionMedicalData {
  fitnessResult: "FIT" | "UNFIT" | "N/A";
  drugTestResult: "NEGATIVE" | "POSITIVE" | "N/A";
  restrictions: string | null;
  specialNotes: string | null;
  expiryDate: string | null;
}

export interface ExtractionFlag {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  message: string;
}

export interface ExtractionResult {
  detection: ExtractionDetection;
  holder: ExtractionHolder;
  fields: ExtractionField[];
  validity: ExtractionValidity;
  compliance: ExtractionCompliance;
  medicalData: ExtractionMedicalData;
  flags: ExtractionFlag[];
  summary: string;
}

// ============================================================
// API Error Response
// ============================================================

export interface ApiError {
  error: string;
  message: string;
  extractionId?: string;
  retryAfterMs?: number | null;
}

// ============================================================
// Config
// ============================================================

export interface AppConfig {
  port: number;
  databaseUrl: string;
  llm: {
    provider: string;
    model: string;
    apiKey: string;
  };
}
