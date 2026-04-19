import {
  extractJsonFromText,
  parseExtractionResponse,
  buildRepairPrompt,
  buildLowConfidenceRetryPrompt,
} from "../llm/json-extractor";

// ────────────────────────────────────────────────────────
// extractJsonFromText
// ────────────────────────────────────────────────────────

describe("extractJsonFromText", () => {
  it("extracts plain JSON object", () => {
    const input = '{"documentType": "COC"}';
    expect(extractJsonFromText(input)).toBe('{"documentType": "COC"}');
  });

  it("strips markdown ```json fences", () => {
    const input = '```json\n{"documentType": "COC"}\n```';
    expect(extractJsonFromText(input)).toBe('{"documentType": "COC"}');
  });

  it("strips plain ``` fences (no language tag)", () => {
    const input = '```\n{"type": "PASSPORT"}\n```';
    expect(extractJsonFromText(input)).toBe('{"type": "PASSPORT"}');
  });

  it("ignores preamble text before JSON", () => {
    const input = 'Here is the extracted data:\n\n{"holder": "John"}';
    expect(extractJsonFromText(input)).toBe('{"holder": "John"}');
  });

  it("ignores trailing text after JSON", () => {
    const input = '{"holder": "John"}\n\nLet me know if you need more.';
    expect(extractJsonFromText(input)).toBe('{"holder": "John"}');
  });

  it("handles preamble + JSON + trailing together", () => {
    const input =
      "Sure! Here's the result:\n" +
      '{"documentType": "SIRB", "holder": {"name": "Jane"}}\n' +
      "Hope this helps!";
    const result = extractJsonFromText(input);
    expect(JSON.parse(result)).toEqual({
      documentType: "SIRB",
      holder: { name: "Jane" },
    });
  });

  it("handles nested braces correctly", () => {
    const input = '{"outer": {"inner": {"deep": true}}}';
    expect(extractJsonFromText(input)).toBe(
      '{"outer": {"inner": {"deep": true}}}'
    );
  });

  it("handles JSON inside fences with preamble and trailing text", () => {
    const input =
      "Here you go:\n```json\n" +
      '{"key": "value"}\n' +
      "```\nAdditional notes here.";
    expect(extractJsonFromText(input)).toBe('{"key": "value"}');
  });

  it("throws when no JSON object exists", () => {
    expect(() => extractJsonFromText("No JSON here")).toThrow(
      "No JSON object found in LLM response"
    );
  });

  it("throws on empty string", () => {
    expect(() => extractJsonFromText("")).toThrow(
      "No JSON object found in LLM response"
    );
  });

  it("throws when only opening brace exists", () => {
    expect(() => extractJsonFromText("{ broken")).toThrow(
      "No JSON object found in LLM response"
    );
  });

  it("throws when braces are in wrong order", () => {
    expect(() => extractJsonFromText("} before {")).toThrow(
      "No JSON object found in LLM response"
    );
  });

  it("handles whitespace around JSON object", () => {
    const input = '   \n\n  {"key": "val"}  \n\n  ';
    expect(extractJsonFromText(input)).toBe('{"key": "val"}');
  });

  it("handles multiline JSON objects", () => {
    const input = `{
  "detection": {
    "documentType": "COC",
    "confidence": "HIGH"
  },
  "holder": {
    "fullName": "Juan Dela Cruz"
  }
}`;
    const result = JSON.parse(extractJsonFromText(input));
    expect(result.detection.documentType).toBe("COC");
    expect(result.holder.fullName).toBe("Juan Dela Cruz");
  });

  it("extracts JSON when LLM adds explanation after fences", () => {
    const input =
      "I've analyzed the document:\n\n" +
      "```json\n" +
      '{"documentType": "PEME", "medicalData": {"fitnessResult": "FIT"}}\n' +
      "```\n\n" +
      "The document appears to be a Pre-Employment Medical Examination certificate.";
    const result = JSON.parse(extractJsonFromText(input));
    expect(result.documentType).toBe("PEME");
    expect(result.medicalData.fitnessResult).toBe("FIT");
  });

  it("handles strings containing braces inside JSON values", () => {
    const input = '{"message": "Use {name} as placeholder"}';
    const result = JSON.parse(extractJsonFromText(input));
    expect(result.message).toBe("Use {name} as placeholder");
  });
});

// ────────────────────────────────────────────────────────
// parseExtractionResponse
// ────────────────────────────────────────────────────────

describe("parseExtractionResponse", () => {
  it("parses valid extraction response", () => {
    const input = JSON.stringify({
      detection: { documentType: "COC", confidence: "HIGH" },
      holder: { fullName: "Test User" },
    });
    const result = parseExtractionResponse(input);
    expect(result.detection.documentType).toBe("COC");
    expect(result.holder.fullName).toBe("Test User");
  });

  it("parses response wrapped in markdown fences", () => {
    const json = JSON.stringify({
      detection: { documentType: "PASSPORT" },
      holder: { fullName: "Jane Doe" },
    });
    const input = "```json\n" + json + "\n```";
    const result = parseExtractionResponse(input);
    expect(result.detection.documentType).toBe("PASSPORT");
  });

  it("throws on completely invalid content", () => {
    expect(() => parseExtractionResponse("not json at all")).toThrow();
  });

  it("throws on malformed JSON within braces", () => {
    expect(() =>
      parseExtractionResponse("{invalid json content}")
    ).toThrow();
  });
});

// ────────────────────────────────────────────────────────
// buildRepairPrompt
// ────────────────────────────────────────────────────────

describe("buildRepairPrompt", () => {
  it("includes the raw response in the repair prompt", () => {
    const raw = '{"broken: json}';
    const prompt = buildRepairPrompt(raw);
    expect(prompt).toContain(raw);
  });

  it("asks for valid JSON only", () => {
    const prompt = buildRepairPrompt("garbage");
    expect(prompt).toContain("valid JSON");
    expect(prompt).toContain("no markdown fences");
    expect(prompt).toContain("no code blocks");
  });

  it("references the original schema", () => {
    const prompt = buildRepairPrompt("bad response");
    expect(prompt).toContain("exact schema");
  });

  it("instructs to return nothing except JSON", () => {
    const prompt = buildRepairPrompt("test");
    expect(prompt).toContain("Return nothing except the JSON object");
  });
});

// ────────────────────────────────────────────────────────
// buildLowConfidenceRetryPrompt
// ────────────────────────────────────────────────────────

describe("buildLowConfidenceRetryPrompt", () => {
  const originalPrompt = "Extract all information from this document.";

  it("includes the original prompt", () => {
    const result = buildLowConfidenceRetryPrompt(
      originalPrompt,
      "coc.jpg",
      "image/jpeg"
    );
    expect(result).toContain(originalPrompt);
  });

  it("includes the file name", () => {
    const result = buildLowConfidenceRetryPrompt(
      originalPrompt,
      "passport_scan.png",
      "image/png"
    );
    expect(result).toContain("passport_scan.png");
  });

  it("includes the MIME type", () => {
    const result = buildLowConfidenceRetryPrompt(
      originalPrompt,
      "doc.pdf",
      "application/pdf"
    );
    expect(result).toContain("application/pdf");
  });

  it("mentions LOW confidence", () => {
    const result = buildLowConfidenceRetryPrompt(
      originalPrompt,
      "test.jpg",
      "image/jpeg"
    );
    expect(result).toContain("LOW confidence");
  });

  it("asks for more careful analysis", () => {
    const result = buildLowConfidenceRetryPrompt(
      originalPrompt,
      "test.jpg",
      "image/jpeg"
    );
    expect(result).toContain("more carefully");
  });
});
