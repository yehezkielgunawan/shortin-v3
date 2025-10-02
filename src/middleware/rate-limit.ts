/**
 * Simplified rate limiting middleware wrapper for Hono using `hono-rate-limiter`.
 *
 * Removed custom store & manual header augmentation to avoid implementation
 * mismatches with the library's expected store shape. We rely entirely on the
 * built-in in-memory store provided by `hono-rate-limiter`.
 *
 * Default behavior:
 *  - 30 requests / 5 minutes per client key (IP heuristic)
 *  - Draft-7 standard headers if supported by the library
 */

import type { MiddlewareHandler, Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  keyGenerator?: (c: Context) => string;
  standardHeaders?: "draft-6" | "draft-7" | false;
}

export function createRateLimiter(
  options: RateLimitOptions = {},
): MiddlewareHandler {
  const {
    limit = 30,
    windowMs = 5 * 60 * 1000,
    keyGenerator = defaultKeyGenerator,
    standardHeaders = "draft-7",
  } = options;

  return rateLimiter({
    windowMs,
    limit,
    standardHeaders,
    keyGenerator,
  });
}

function defaultKeyGenerator(c: Context): string {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("x-forwarded-for") ||
    c.req.header("x-real-ip") ||
    "anonymous"
  );
}

export default createRateLimiter;
