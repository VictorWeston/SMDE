import multer from "multer";
import { Request, Response, NextFunction } from "express";

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("UNSUPPORTED_FORMAT"));
    }
  },
});

export const uploadDocument = upload.single("document");

/**
 * Wraps multer errors into standardized API error responses.
 */
export function handleUploadError(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err.message === "UNSUPPORTED_FORMAT") {
    res.status(400).json({
      error: "UNSUPPORTED_FORMAT",
      message:
        "File type not accepted. Supported types: image/jpeg, image/png, application/pdf",
    });
    return;
  }

  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({
      error: "FILE_TOO_LARGE",
      message: `File exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
    });
    return;
  }

  next(err);
}
