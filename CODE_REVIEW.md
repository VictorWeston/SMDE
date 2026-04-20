# Code Review — `feat: add document extraction endpoint`

**PR by:** Junior Engineer
**Reviewer:** Victor Yee
**Verdict:** ❌ **Request Changes**

---

## Summary

Hey — thanks for getting the extraction endpoint up and running. The core flow is correct: accept a file, encode it, send it to the LLM, parse the response, and return structured data. That's the right idea and it's good that you tested it with a real document.

That said, this PR has several issues that would block it from merging. The most critical one is a hardcoded API key in the source code — that needs to be fixed before anything else. Beyond that, there are cost, reliability, security, and architecture concerns I'll walk through below. None of this is unusual for a first pass — the important thing is understanding *why* each matters.

---

## Critical Issues

### 1. Hardcoded API Key (Line 8)

```ts
const client = new Anthropic({ apiKey: 'sk-ant-REDACTED' });
```

This is the single biggest problem in this PR. API keys must **never** appear in source code. Even with `REDACTED` in the PR, the real key was in your local commits and is now in the git history. Anyone with repo access can extract it, and if this repo were public, automated scrapers would find it within minutes.

**Fix:** Read the key from an environment variable (`process.env.ANTHROPIC_API_KEY`), add it to `.env` (which is `.gitignore`d), and rotate the compromised key immediately in the Anthropic dashboard.

**Why this matters:** Leaked API keys are one of the most common causes of unexpected cloud bills. Anthropic keys in particular can rack up thousands of dollars in hours if abused.

---

### 2. Using Claude Opus — Cost Concerns (Line 27)

```ts
model: 'claude-opus-4-6',
```

I understand Opus gave better results in testing, but it's the most expensive model Anthropic offers — approximately **$15 per million input tokens and $75 per million output tokens**. A single maritime document extraction with a high-resolution image can consume 5,000–10,000 input tokens per request. At scale, processing 500 documents per day would cost roughly **$100–200/day just in LLM fees** on Opus.

**Fix:** Use `claude-haiku-4-5-20251001` for the default path (roughly **60x cheaper** than Opus). The extraction prompt can be tuned to produce equivalent results on a smaller model. Reserve Opus for edge cases that genuinely need it — a confidence-based retry where Haiku returns LOW confidence could escalate to a more capable model.

**Why this matters:** Model selection is a product decision with direct P&L impact. Always start with the cheapest model that produces acceptable results and escalate only when needed.

---

### 3. No Vendor SDK — We Should Use Raw `fetch` Instead (Line 2, 27)

```ts
import Anthropic from '@anthropic-ai/sdk';
// ...
const response = await client.messages.create({ ... });
```

The Anthropic SDK adds a significant dependency for what is fundamentally a single HTTP POST. Every LLM vision API follows the same pattern: send a JSON body with an image and prompt to a URL, get text back. A raw `fetch` call with an `AbortController` timeout does the same thing with zero dependencies, works identically across providers (Gemini, OpenAI, Groq), and avoids locking us into one vendor's SDK versioning. In our codebase, we've implemented a provider abstraction that supports four LLM providers with no vendor SDKs — switching providers is a config change, not a code change.

**Why this matters:** SDK dependencies create upgrade burden, increase bundle size, and couple your code to one vendor's API surface. For simple request/response patterns, `fetch` is the right tool.

---

## Major Issues

### 4. No Request Timeout (Line 27-48)

```ts
const response = await client.messages.create({
  model: 'claude-opus-4-6',
  max_tokens: 4096,
  messages: [ ... ],
});
```

There's no timeout on the LLM call. If Claude takes 60 seconds or hangs indefinitely, this Express handler holds the connection open the entire time. Under load, a few hung requests exhaust the connection pool and cascade into timeouts for every other request — including health checks.

**Fix:** Use an `AbortController` with a 30-second timeout:

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
try {
  const response = await fetch(url, { signal: controller.signal, ... });
} finally {
  clearTimeout(timeout);
}
```

---

### 5. Vague Extraction Prompt (Line 40-43)

```ts
{
  type: 'text',
  text: 'Extract all information from this maritime document and return as JSON.',
}
```

This prompt gives the LLM no structure to follow. "All information" is ambiguous — the model will invent its own JSON shape every time, making downstream parsing unreliable. One call might return `{"name": "John"}`, another `{"holder": {"fullName": "John"}}`. You can't build a reliable pipeline on unpredictable output shapes.

**Fix:** Provide a detailed extraction prompt that specifies the exact JSON schema you expect, the document types you're looking for, the fields per section (detection, holder, validity, compliance, medical, flags), and enumerated values where applicable. Our extraction prompt in production is ~2,000 tokens and produces consistent, parseable output across document types.

---

### 6. Fragile JSON Parsing (Line 50)

```ts
const result = JSON.parse(response.content[0].text);
```

This will crash on:
- Markdown code fences (LLMs frequently wrap JSON in ` ```json `)
- Preamble text ("Here is the extracted data:\n{...}")
- Trailing explanations after the JSON
- Malformed JSON from the LLM

A bare `JSON.parse` on raw LLM output is a guaranteed production failure. LLMs are not deterministic JSON generators.

**Fix:** Implement a JSON extraction utility that strips markdown fences, finds the outermost `{}`  braces, and falls back to a repair prompt if parsing still fails. We have `extractJsonFromText()` and `buildRepairPrompt()` in our codebase for exactly this — with unit tests covering all the edge cases above.

---

### 7. Global State for Storage (Line 53-54)

```ts
global.extractions = global.extractions || [];
global.extractions.push(result);
```

This stores all extractions in memory on the global object. This data is lost on every server restart, invisible to other processes, has no size limit (memory leak under load), and provides no query capability. It also mutates `global`, which makes testing impossible and creates hidden coupling.

**Fix:** Store results in PostgreSQL. The extractions table should capture the full LLM response, promoted queryable fields (document type, holder name, expiry dates), and metadata (session ID, file hash, timestamps). This survives restarts, scales horizontally, and enables compliance queries like "find all expired COCs."

---

### 8. Saving Files to Disk (Line 23-24)

```ts
const savedPath = path.join('./uploads', file.originalname);
fs.copyFileSync(file.path, savedPath);
```

Multiple problems:
- **Path traversal:** `file.originalname` comes from the client. A malicious filename like `../../etc/passwd` or `../../../.env` would write outside the uploads directory. Always sanitize or replace user-provided filenames.
- **Name collisions:** Two files named `passport.jpg` silently overwrite each other.
- **No cleanup:** Files accumulate on disk forever.
- **PII on the filesystem:** Maritime documents contain personal data (names, photos, passport numbers). Storing them as plain files with no encryption or access control is a compliance risk.

**Fix:** If you need to persist originals, use object storage (S3/GCS) with a UUID-based key, not the original filename. For the async pipeline, store the file bytes temporarily in the database (BYTEA) and clear them after processing.

---

## Minor Issues

### 9. Generic Error Handling (Line 56-58)

```ts
catch (error) {
  console.log('Error:', error);
  res.status(500).json({ error: 'Something went wrong' });
}
```

- `console.log` should be `console.error` for errors — they go to different streams.
- "Something went wrong" gives the caller zero diagnostic information. Return structured error codes (`LLM_ERROR`, `LLM_TIMEOUT`, `PARSE_ERROR`) so clients can handle each case differently.
- The full error object logged to console may contain the API key in request headers — be careful what you log.

### 10. No TypeScript Types (Line 50)

```ts
const result = JSON.parse(response.content[0].text);
```

`result` is `any`. The whole point of TypeScript is to catch shape mismatches at compile time. Define an `ExtractionResult` interface that matches your expected JSON schema, and validate the parsed output against it. If you don't, a schema change from the LLM silently breaks every downstream consumer.

---

## Learning Note: Treat Prompt like a fucntion

The biggest non-obvious issue in this PR is the vague prompt. It's tempting to think of the LLM call as a black box — send an image, get JSON back. But in practice, the prompt *is* your contract with the model. It's the equivalent of an API schema, a database migration, and a validation layer all in one.

A production extraction prompt should:

1. **Define the exact output schema** — every key, every nested object, every enum value
2. **Enumerate what you're looking for** — document types, field names, severity levels
3. **Set behavioral rules** — "return null, not empty string, for missing fields" / "never invent data"
4. **Handle edge cases explicitly** — "if no document is detected, return documentType: OTHER with a CRITICAL flag"


Keep in mind: **Think of prompts like functions but written in plain english**. Context is the params, prompt is logic. never assume the model will fill in ambiguity the way you expect.

---

## Summary of Required Changes

| Priority | Issue | Action |
|---|---|---|
| 🔴 Critical | Hardcoded API key | Move to env var, rotate key |
| 🔴 Critical | Opus cost | Switch to Haiku, benchmark before deploying Opus |
| 🟠 Major | No timeout | Add AbortController (30s) |
| 🟠 Major | Vague prompt | Define exact JSON schema in prompt |
| 🟠 Major | Fragile JSON.parse | Add extraction + repair logic |
| 🟠 Major | Global state | Use PostgreSQL |
| 🟠 Major | File path traversal | Sanitize filenames or use UUID keys |
| 🟡 Minor | Generic error handling | Structured error codes |
| 🟡 Minor | No types | Define ExtractionResult interface |

Happy to pair on the prompt design and the JSON repair logic — those two changes alone will make the endpoint production-ready. Good first iteration.
