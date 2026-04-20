import crypto from "crypto";

const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS ?? "10000");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

export interface JobWebhookPayload {
  event: "JOB_COMPLETED" | "JOB_FAILED";
  jobId: string;
  sessionId: string;
  extractionId: string | null;
  status: "COMPLETE" | "FAILED";
  error?: {
    code: string | null;
    message: string | null;
  };
  timestamp: string;
}

function buildSignature(body: string): string {
  if (!WEBHOOK_SECRET) return "";
  const digest = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  return `sha256=${digest}`;
}

export async function sendJobWebhook(
  webhookUrl: string,
  payload: JobWebhookPayload
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const rawBody = JSON.stringify(payload);
    const signature = buildSignature(rawBody);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-SMDE-Event": payload.event,
      "X-SMDE-Timestamp": payload.timestamp,
    };

    if (signature) {
      headers["X-SMDE-Signature"] = signature;
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: rawBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Webhook HTTP ${response.status}: ${body}`);
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Webhook request timed out after ${WEBHOOK_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
