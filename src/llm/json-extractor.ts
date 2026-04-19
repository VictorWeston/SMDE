import { ExtractionResult } from "../types";

/**
 * Extract valid JSON from an LLM response that may contain
 * markdown fences, preamble text, or trailing explanations.
 *
 * Strategy: find the outermost { and } in the response.
 */
export function extractJsonFromText(text: string): string {
  // Strip markdown code fences if present
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/;
  const fenceMatch = fencePattern.exec(text);
  if (fenceMatch) {
    text = fenceMatch[1]!;
  }

  // Find outermost { and }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found in LLM response");
  }

  return text.slice(firstBrace, lastBrace + 1);
}

/**
 * Parse the LLM response text into an ExtractionResult.
 * Handles markdown fences, preamble, and trailing text.
 *
 * @throws Error if JSON cannot be extracted or parsed
 */
export function parseExtractionResponse(text: string): ExtractionResult {
  const jsonStr = extractJsonFromText(text);
  return JSON.parse(jsonStr) as ExtractionResult;
}

/**
 * Build a repair prompt to send back to the LLM when
 * the initial response couldn't be parsed as valid JSON.
 */
export function buildRepairPrompt(rawResponse: string): string {
  return `Your previous response could not be parsed as valid JSON. Here is what you returned:

---
${rawResponse}
---

Please return ONLY a valid JSON object with no markdown fences, no code blocks, no preamble, and no trailing text. The JSON must match the exact schema I originally requested. Return nothing except the JSON object.`;
}

/**
 * Build a retry prompt for LOW confidence results.
 * Includes file name and MIME type as additional hints.
 */
export function buildLowConfidenceRetryPrompt(
  originalPrompt: string,
  fileName: string,
  mimeType: string
): string {
  return `${originalPrompt}

Additional context for improved accuracy:
- File name: ${fileName}
- File type: ${mimeType}

The previous extraction attempt returned LOW confidence. Please analyze the document more carefully, paying close attention to document headers, stamps, logos, and any identifying text. Return your best assessment with the highest confidence level you can justify.`;
}
