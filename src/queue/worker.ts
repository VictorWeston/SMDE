import { Queue, Worker, Job } from "bullmq";
import IORedis from "ioredis";
import pool from "../db/connection";
import {
  getLLMProvider,
  parseExtractionResponse,
  buildRepairPrompt,
  buildLowConfidenceRetryPrompt,
  EXTRACTION_PROMPT,
  PROMPT_VERSION,
} from "../llm";
import { storeExtraction, storeFailedExtraction } from "../services/extraction";
import { ExtractionResult } from "../types";

// ============================================================
// Redis connection
// ============================================================

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
});

// ============================================================
// Queue definition
// ============================================================

export const EXTRACTION_QUEUE = "extraction";

export const extractionQueue = new Queue(EXTRACTION_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000, // 5s, 10s, 20s
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

// ============================================================
// Job data shape
// ============================================================

export interface ExtractionJobData {
  jobId: string;        // our PG jobs.id
  sessionId: string;
  fileName: string;
  fileHash: string;
  mimeType: string;
  // file_data stays in PG — we read it from there
}

// ============================================================
// Worker
// ============================================================

let worker: Worker | null = null;

export function startWorker(): Worker {
  if (worker) return worker;

  worker = new Worker<ExtractionJobData>(
    EXTRACTION_QUEUE,
    async (job: Job<ExtractionJobData>) => {
      const { jobId, sessionId, fileName, fileHash, mimeType } = job.data;
      const startTime = Date.now();

      // Update job status to PROCESSING
      await pool.query(
        `UPDATE jobs SET status = 'PROCESSING', started_at = NOW()
         WHERE id = $1`,
        [jobId]
      );

      // Read file data from PG
      const fileResult = await pool.query(
        "SELECT file_data FROM jobs WHERE id = $1",
        [jobId]
      );

      if (fileResult.rows.length === 0) {
        throw new Error(`Job ${jobId} not found in database`);
      }

      const fileData: Buffer = fileResult.rows[0].file_data;
      const base64 = fileData.toString("base64");
      const provider = getLLMProvider();

      let rawResponse = "";
      let retryCount = 0;

      // Call LLM
      const llmResult = await provider.extractDocument(
        base64,
        mimeType,
        EXTRACTION_PROMPT
      );
      rawResponse = llmResult.text;

      // Parse response
      let parsed: ExtractionResult;
      try {
        parsed = parseExtractionResponse(rawResponse);
      } catch {
        retryCount++;
        const repairResult = await provider.sendPrompt(
          buildRepairPrompt(rawResponse)
        );
        rawResponse = repairResult.text;
        parsed = parseExtractionResponse(rawResponse);
      }

      // Low confidence retry
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
          // Keep original
        }
      }

      // Store extraction
      const processingTimeMs = Date.now() - startTime;
      const extractionId = await storeExtraction({
        sessionId,
        fileName,
        fileHash,
        mimeType,
        result: parsed,
        rawLlmResponse: rawResponse,
        processingTimeMs,
        status: "COMPLETE",
        retryCount,
      });

      // Update job as complete
      await pool.query(
        `UPDATE jobs
         SET status = 'COMPLETE', extraction_id = $1, completed_at = NOW(),
             file_data = NULL
         WHERE id = $2`,
        [extractionId, jobId]
      );

      return { extractionId, processingTimeMs };
    },
    {
      connection,
      concurrency: 3,
    }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { jobId, sessionId, fileName, fileHash, mimeType } = job.data;
    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);

    console.error(
      `Job ${jobId} failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`,
      err.message
    );

    if (isLastAttempt) {
      const errorCode = err.message.includes("timed out")
        ? "LLM_TIMEOUT"
        : "LLM_ERROR";

      // Store failed extraction — never discard
      const extractionId = await storeFailedExtraction({
        sessionId,
        fileName,
        fileHash,
        mimeType,
        rawLlmResponse: null,
        processingTimeMs: 0,
        errorCode,
        errorMessage: err.message,
        retryCount: job.attemptsMade,
      });

      await pool.query(
        `UPDATE jobs
         SET status = 'FAILED', extraction_id = $1, completed_at = NOW(),
             error_code = $2, error_message = $3, retryable = TRUE,
             retry_count = $4, file_data = NULL
         WHERE id = $5`,
        [extractionId, errorCode, err.message, job.attemptsMade, jobId]
      );
    }
  });

  worker.on("completed", (job) => {
    console.log(`Job ${job.data.jobId} completed`);
  });

  console.log("Extraction worker started (concurrency: 3)");
  return worker;
}

// ============================================================
// Health check
// ============================================================

export async function checkQueueHealth(): Promise<boolean> {
  try {
    const res = await connection.ping();
    return res === "PONG";
  } catch {
    return false;
  }
}

// ============================================================
// Graceful shutdown
// ============================================================

export async function shutdownQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  await extractionQueue.close();
  connection.disconnect();
}
