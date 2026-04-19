import { Router, Request, Response, NextFunction } from "express";
import { uploadDocument, handleUploadError } from "../middleware/upload";
import { rateLimiter } from "../middleware/rate-limiter";
import { extractSync, createAsyncJob } from "../services/extraction";

const router = Router();

/**
 * POST /api/extract
 *
 * Query params:
 *   mode = "sync" (default) | "async"
 *
 * Body (multipart/form-data):
 *   document  - the file (jpeg, png, pdf — max 10MB)
 *   sessionId - optional UUID to group documents
 */
router.post(
  "/",
  rateLimiter,
  (req: Request, res: Response, next: NextFunction) => {
    uploadDocument(req, res, (err?: unknown) => {
      if (err) return handleUploadError(err as Error, req, res, next);
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({
          error: "MISSING_FILE",
          message:
            'No file uploaded. Send a file in the "document" field.',
        });
        return;
      }

      const sessionId = req.body?.sessionId as string | undefined;
      const mode =
        (req.query.mode as string)?.toLowerCase() === "async"
          ? "async"
          : "sync";

      if (mode === "async") {
        const result = await createAsyncJob(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype,
          sessionId
        );

        if (result.deduplicated) {
          res.set("X-Deduplicated", "true");
          res.status(200).json({
            extractionId: result.existingExtractionId,
            sessionId: result.sessionId,
            deduplicated: true,
          });
          return;
        }

        res.status(202).json({
          jobId: result.jobId,
          sessionId: result.sessionId,
          status: "QUEUED",
          pollUrl: `/api/jobs/${result.jobId}`,
        });
        return;
      }

      // Sync mode
      const result = await extractSync(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        sessionId
      );

      if (result.deduplicated) {
        res.set("X-Deduplicated", "true");
        res.status(200).json({
          extractionId: result.extractionId,
          sessionId: result.sessionId,
          deduplicated: true,
          status: result.status,
        });
        return;
      }

      if (result.status === "FAILED") {
        res.status(422).json({
          error: result.errorCode,
          message: result.errorMessage,
          extractionId: result.extractionId,
        });
        return;
      }

      res.status(200).json({
        extractionId: result.extractionId,
        sessionId: result.sessionId,
        status: result.status,
        processingTimeMs: result.processingTimeMs,
        data: result.data,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
