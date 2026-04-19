import { Request, Response, NextFunction } from "express";

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const RATE_LIMIT = 10;          // requests per window
const WINDOW_MS = 60 * 1000;    // 1 minute

const buckets = new Map<string, TokenBucket>();

// Clean up stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > WINDOW_MS * 2) {
      buckets.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function rateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ip = getClientIp(req);
  const now = Date.now();

  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT, lastRefill: now };
    buckets.set(ip, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= WINDOW_MS) {
    bucket.tokens = RATE_LIMIT;
    bucket.lastRefill = now;
  }

  if (bucket.tokens <= 0) {
    const retryAfterMs = WINDOW_MS - (now - bucket.lastRefill);
    const retryAfterSec = Math.ceil(retryAfterMs / 1000);

    res.set("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "RATE_LIMITED",
      message: `Too many requests. Try again in ${retryAfterSec} seconds.`,
      retryAfterMs,
    });
    return;
  }

  bucket.tokens--;
  next();
}
