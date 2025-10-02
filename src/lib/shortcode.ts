/**
 * Short code generation utilities for Shortin v3.
 *
 * Design goals:
 *  - Framework/runtime agnostic (works in Edge / Workers / Node)
 *  - Predictable, testable, typed
 *  - Supports both random and deterministic (hash-based) generation
 *  - Optional collision check hook to ensure uniqueness against storage
 *
 * You can import the primary helpers:
 *  - generateShortCode()
 *  - generateUniqueShortCode()
 *  - hashShortCode()
 *
 * Example:
 *    import {
 *      generateUniqueShortCode,
 *      alphanumericCharset,
 *    } from "@/lib/shortcode";
 *
 *    const code = await generateUniqueShortCode({
 *      length: 7,
 *      checkExists: async (candidate) => await doesShortCodeExist(candidate),
 *    });
 */

/* -------------------------------------------------------------------------- */
/* Character Sets                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Default (Base62) character set: A-Z a-z 0-9
 */
export const alphanumericCharset =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * URL-friendly, excludes visually ambiguous chars (0,O,o,1,l,I)
 */
export const urlFriendlyCharset =
  "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/**
 * Extended (adds _ and -); still URL safe without encoding.
 */
export const extendedUrlCharset =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface GenerateShortCodeOptions {
  /**
   * Desired code length (default: 6)
   */
  length?: number;
  /**
   * Characters to sample from (default: alphanumericCharset)
   */
  charset?: string;
  /**
   * Optional function to supply cryptographically strong random values
   * (mainly for test injection). Must return an integer in [0, maxExclusive).
   */
  randomInt?: (maxExclusive: number) => number;
}

export interface GenerateUniqueShortCodeOptions
  extends GenerateShortCodeOptions {
  /**
   * Async callback to check if a generated code already exists.
   * Should return true if the candidate ALREADY EXISTS (i.e. collision).
   */
  checkExists: (candidate: string) => Promise<boolean> | boolean;
  /**
   * Maximum attempts before giving up (default: 5 * length to reflect
   * more attempts for larger lengths).
   */
  maxAttempts?: number;
}

export interface HashShortCodeOptions {
  /**
   * Desired code length (truncates hash) (default: 8)
   */
  length?: number;
  /**
   * Character set used to map raw hash bytes (default: alphanumericCharset)
   */
  charset?: string;
  /**
   * Salt to reduce predictability / increase uniqueness across environments
   */
  salt?: string;
  /**
   * Algorithm to use (currently "SHA-256" only)
   */
  algorithm?: "SHA-256";
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Internal: produce a random integer in [0, maxExclusive) using
 * crypto.getRandomValues when available, falling back to Math.random().
 */
function secureRandomInt(maxExclusive: number): number {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    // Use 32-bit unsigned integers
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    // Bias-correct approach (simple rejection sampling)
    const limit = Math.floor((0xffffffff / maxExclusive) * maxExclusive);
    if (arr[0] < limit) {
      return arr[0] % maxExclusive;
    }
    // Fallback to recursion (extremely unlikely to loop many times)
    return secureRandomInt(maxExclusive);
  }
  // Fallback - NOT cryptographically strong
  return Math.floor(Math.random() * maxExclusive);
}

/* -------------------------------------------------------------------------- */
/* Core Generators                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Generate a random short code (does NOT check uniqueness).
 */
export function generateShortCode(
  options: GenerateShortCodeOptions = {},
): string {
  const {
    length = 6,
    charset = alphanumericCharset,
    randomInt = secureRandomInt,
  } = options;

  if (!Number.isInteger(length) || length <= 0) {
    throw new Error("length must be a positive integer");
  }
  if (!charset || charset.length < 2) {
    throw new Error("charset must contain at least 2 characters");
  }

  let out = "";
  for (let i = 0; i < length; i++) {
    out += charset[randomInt(charset.length)];
  }
  return out;
}

/**
 * Generate a random short code ensuring (through user-provided callback) that
 * it does not already exist in storage.
 */
export async function generateUniqueShortCode(
  options: GenerateUniqueShortCodeOptions,
): Promise<string> {
  const {
    checkExists,
    maxAttempts = (options.length ?? 6) * 5,
    ...rest
  } = options;

  if (typeof checkExists !== "function") {
    throw new Error("checkExists callback is required for uniqueness checks");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = generateShortCode(rest);
    // If it does NOT exist => success
    // (checkExists returns true when taken)
    const exists = await checkExists(candidate);
    if (!exists) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to generate unique short code after ${maxAttempts} attempts`,
  );
}

/* -------------------------------------------------------------------------- */
/* Hash-Based (Deterministic) Variant                                         */
/* -------------------------------------------------------------------------- */

/**
 * Create a deterministic short code derived from input data (e.g., a URL).
 * Useful for idempotent behavior (same URL => same code) or for building
 * stable preview links.
 *
 * NOTE: Collisions are still possible when truncating the hash. If that
 * matters for your use case, pair this with `generateUniqueShortCode` fallback.
 *
 * Example:
 *   const code = await hashShortCode("https://example.com/page", { length: 8 });
 */
export async function hashShortCode(
  input: string,
  options: HashShortCodeOptions = {},
): Promise<string> {
  const {
    length = 8,
    charset = alphanumericCharset,
    salt = "",
    algorithm = "SHA-256",
  } = options;

  if (!charset || charset.length < 4) {
    throw new Error("charset must contain at least 4 characters");
  }

  // Use Web Crypto subtle API (Cloudflare Workers and modern browsers)
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + input);

  let digestBytes: Uint8Array;

  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest(algorithm, data);
    digestBytes = new Uint8Array(hashBuffer);
  } else {
    // Fallback: poor-man hash (FNV-1a variant)
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      h ^= data[i];
      h = (h * 0x01000193) >>> 0;
    }
    // Expand to bytes
    digestBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      digestBytes[i] = (h >>> ((i % 4) * 8)) & 0xff;
    }
  }

  // Map digest bytes into characters of chosen charset
  let code = "";
  const charLen = charset.length;
  for (let i = 0; i < digestBytes.length && code.length < length; i++) {
    const idx = digestBytes[i] % charLen;
    code += charset[idx];
  }
  return code.slice(0, length);
}

/* -------------------------------------------------------------------------- */
/* Hybrid Utility                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Attempt to produce a deterministic code first; if collision occurs according
 * to `checkExists`, fall back to random unique generation.
 *
 * This lets you have idempotent codes when unused, but still avoid accidental
 * reuse when the deterministic slot is already taken.
 *
 * Example:
 *   const code = await hybridDeterministicThenRandom("https://example.com/x", {
 *     deterministicLength: 7,
 *     randomLength: 8,
 *     checkExists: async (c) => await exists(c),
 *   });
 */
export async function hybridDeterministicThenRandom(
  input: string,
  opts: {
    checkExists: (candidate: string) => Promise<boolean> | boolean;
    deterministicLength?: number;
    randomLength?: number;
    charset?: string;
    salt?: string;
  },
): Promise<string> {
  const {
    checkExists,
    deterministicLength = 6,
    randomLength = deterministicLength,
    charset = alphanumericCharset,
    salt = "",
  } = opts;

  const deterministic = await hashShortCode(input, {
    length: deterministicLength,
    charset,
    salt,
  });

  const taken = await checkExists(deterministic);
  if (!taken) return deterministic;

  return generateUniqueShortCode({
    length: randomLength,
    charset,
    checkExists,
  });
}

/* -------------------------------------------------------------------------- */
/* Simple Validation Helpers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Very lightweight URL validation (basic structure check).
 * Prefer a more robust validator if you need full spec compliance.
 */
export function isProbablyValidUrl(candidate: string): boolean {
  try {
    // Will throw if invalid
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Exports Summary                                                            */
/* -------------------------------------------------------------------------- */
/**
 * Named exports for convenience & tree-shaking friendliness.
 */
export default {
  alphanumericCharset,
  urlFriendlyCharset,
  extendedUrlCharset,
  generateShortCode,
  generateUniqueShortCode,
  hashShortCode,
  hybridDeterministicThenRandom,
  isProbablyValidUrl,
};
