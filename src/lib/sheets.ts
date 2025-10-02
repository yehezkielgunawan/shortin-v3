/**
 * Edge-compatible Google Sheets adapter for Shortin v3
 *
 * This replaces the earlier Node-centric `googleapis` usage with direct REST calls
 * authenticated via a manually constructed Service Account JWT (OAuth 2.0).
 *
 * It is designed for Cloudflare Workers / other edge runtimes:
 *  - No Node.js core modules
 *  - Uses Web Crypto (`crypto.subtle`) to sign RS256 JWT
 *  - Caches access tokens in-memory for their lifetime (non-persistent)
 *
 * Data Model (Sheet1):
 *  Column A: id
 *  Column B: url
 *  Column C: shortCode
 *  Column D: createdAt
 *  Column E: updatedAt
 *  Column F: count
 *
 * Public Exports (parity with previous implementation):
 *  - Interfaces: ShortUrlRecord, SheetsEnvironment
 *  - Errors: NotFoundError, ConflictError
 *  - Helpers: generateRecordId, buildShortUrlRecord
 *  - CRUD-ish functions:
 *      createShortUrl
 *      deleteShortUrl
 *      updateDestination
 *      resolveAndIncrement
 *      getStats
 *      getRecord
 *      assertShortCodeAvailable
 *
 * NOTE: This implementation makes multiple round-trips to Sheets; for higher scale
 * consider migrating to a database designed for concurrency (D1, Durable Object, etc.).
 */

/* -------------------------------------------------------------------------- */
/* Types & Errors                                                             */
/* -------------------------------------------------------------------------- */

export interface ShortUrlRecord {
  id: string;
  url: string;
  shortCode: string;
  createdAt: string;
  updatedAt: string;
  count: number;
}

export interface SheetsEnvironment {
  SPREADSHEET_ID: string;

  GOOGLE_PROJECT_ID: string;
  GOOGLE_PRIVATE_KEY_ID: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_AUTH_URI: string;
  GOOGLE_TOKEN_URI: string;
  GOOGLE_AUTH_PROVIDER_X509_CERT_URL: string;
  GOOGLE_CLIENT_X509_CERT_URL: string;
  GOOGLE_UNIVERSE_DOMAIN: string;
}

export class NotFoundError extends Error {
  constructor(message = "Not Found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const SHEET_DATA_RANGE = "Sheet1!A:F";
const SHORT_CODE_COLUMN_RANGE = "Sheet1!C:C";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/* -------------------------------------------------------------------------- */
/* Internal Caches                                                            */
/* -------------------------------------------------------------------------- */

let tokenCache: { token: string; exp: number } | null = null;
let privateKeyCache: { pem: string; key: CryptoKey } | null = null;

/* -------------------------------------------------------------------------- */
/* Environment Validation & Sanitization                                      */
/* -------------------------------------------------------------------------- */

function sanitizePrivateKey(key: string | undefined): string {
  if (!key) return "";
  return key.replace(/\\n/g, "\n");
}

function validateEnv(
  env: Partial<SheetsEnvironment>,
): asserts env is SheetsEnvironment {
  const required: (keyof SheetsEnvironment)[] = [
    "SPREADSHEET_ID",
    "GOOGLE_PROJECT_ID",
    "GOOGLE_PRIVATE_KEY_ID",
    "GOOGLE_PRIVATE_KEY",
    "GOOGLE_CLIENT_EMAIL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_AUTH_URI",
    "GOOGLE_TOKEN_URI",
    "GOOGLE_AUTH_PROVIDER_X509_CERT_URL",
    "GOOGLE_CLIENT_X509_CERT_URL",
    "GOOGLE_UNIVERSE_DOMAIN",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `Missing Google Sheets environment variables: ${missing.join(", ")}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* JWT & Access Token Handling                                                */
/* -------------------------------------------------------------------------- */

async function getAccessToken(env: SheetsEnvironment): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (tokenCache && tokenCache.exp - 60 > now) {
    return tokenCache.token;
  }

  const iat = now;
  const exp = iat + 3600;

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const claimSet = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: GOOGLE_OAUTH_TOKEN_URL,
    exp,
    iat,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claimSet));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signature = await signJwt(unsignedToken, env.GOOGLE_PRIVATE_KEY);
  const signedJwt = `${unsignedToken}.${signature}`;

  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", signedJwt);

  const resp = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Failed to obtain access token: ${resp.status} ${resp.statusText} - ${text}`,
    );
  }

  const tokenJson = (await resp.json()) as {
    access_token: string;
    expires_in?: number;
  };
  const accessToken = tokenJson.access_token;
  const expiresIn: number =
    typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : 3600;

  tokenCache = {
    token: accessToken,
    exp: now + expiresIn,
  };

  return accessToken;
}

async function signJwt(unsignedToken: string, rawPem: string): Promise<string> {
  const pem = sanitizePrivateKey(rawPem);
  const key = await importPrivateKey(pem);
  const encoder = new TextEncoder();
  const data = encoder.encode(unsignedToken);

  const signatureBuffer = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    data,
  );

  return base64UrlEncode(new Uint8Array(signatureBuffer));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (privateKeyCache && privateKeyCache.pem === pem) {
    return privateKeyCache.key;
  }

  // Strip header/footer
  const normalized = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  const binaryDer = base64Decode(normalized);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  privateKeyCache = { pem, key };
  return key;
}

/* -------------------------------------------------------------------------- */
/* Base64URL Utilities                                                        */
/* -------------------------------------------------------------------------- */

function base64UrlEncode(data: Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = data;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return base64;
}

function base64Decode(base64: string): ArrayBuffer {
  const pad =
    base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const b64 = base64.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/* -------------------------------------------------------------------------- */
/* Sheets REST Helpers                                                        */
/* -------------------------------------------------------------------------- */

async function sheetsFetch(
  env: SheetsEnvironment,
  method: string,
  path: string,
  query?: Record<string, string | number | undefined>,
  body?: unknown,
): Promise<any> {
  const token = await getAccessToken(env);

  const url = new URL(`${SHEETS_API_BASE}/${env.SPREADSHEET_ID}/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const resp = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Sheets API error (${method} ${path}): ${resp.status} ${resp.statusText} - ${text}`,
    );
  }

  if (resp.status === 204) return null;
  const json = await resp.json();
  return json;
}

async function getValues(
  env: SheetsEnvironment,
  range: string,
): Promise<string[][]> {
  const data = await sheetsFetch(
    env,
    "GET",
    `values/${encodeURIComponent(range)}`,
  );
  return (data.values as string[][]) || [];
}

async function appendValues(
  env: SheetsEnvironment,
  range: string,
  rows: (string | number | boolean | null)[][],
): Promise<void> {
  await sheetsFetch(
    env,
    "POST",
    `values/${encodeURIComponent(range)}:append`,
    {
      valueInputOption: "RAW",
    },
    {
      values: rows,
    },
  );
}

async function updateValues(
  env: SheetsEnvironment,
  range: string,
  rows: (string | number | boolean | null)[][],
): Promise<void> {
  await sheetsFetch(
    env,
    "PUT",
    `values/${encodeURIComponent(range)}`,
    {
      valueInputOption: "RAW",
    },
    {
      values: rows,
    },
  );
}

async function clearRange(
  env: SheetsEnvironment,
  range: string,
): Promise<void> {
  await sheetsFetch(env, "POST", `values/${encodeURIComponent(range)}:clear`);
}

/* -------------------------------------------------------------------------- */
/* Utility Lookups                                                            */
/* -------------------------------------------------------------------------- */

async function getAllShortCodes(env: SheetsEnvironment): Promise<string[]> {
  const values = await getValues(env, SHORT_CODE_COLUMN_RANGE);
  // Flatten and filter empty
  return values.flat().filter((v) => v);
}

async function findRowIndexByShortCode(
  env: SheetsEnvironment,
  shortCode: string,
): Promise<number | null> {
  const codes = await getAllShortCodes(env);
  const idx = codes.indexOf(shortCode);
  return idx === -1 ? null : idx + 1;
}

async function readRowAsRecord(
  env: SheetsEnvironment,
  rowIndex: number,
): Promise<ShortUrlRecord | null> {
  const range = `Sheet1!A${rowIndex}:F${rowIndex}`;
  const values = await getValues(env, range);
  const row = values[0];
  if (!row || row.length < 6 || row.every((cell) => cell === "")) {
    return null;
  }
  const [id, url, shortCode, createdAt, updatedAt, countRaw] = row;
  return {
    id,
    url,
    shortCode,
    createdAt,
    updatedAt,
    count: Number(countRaw ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* ID & Record Builders                                                       */
/* -------------------------------------------------------------------------- */

export function generateRecordId(): string {
  return `id_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

export function buildShortUrlRecord(params: {
  url: string;
  shortCode: string;
}): ShortUrlRecord {
  const now = new Date().toISOString();
  return {
    id: generateRecordId(),
    url: params.url,
    shortCode: params.shortCode,
    createdAt: now,
    updatedAt: now,
    count: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Public CRUD-like API                                                       */
/* -------------------------------------------------------------------------- */

export async function createShortUrl(
  envPartial: Partial<SheetsEnvironment>,
  record: ShortUrlRecord,
): Promise<ShortUrlRecord> {
  validateEnv(envPartial);
  const env = {
    ...envPartial,
    GOOGLE_PRIVATE_KEY: sanitizePrivateKey(envPartial.GOOGLE_PRIVATE_KEY),
  } as SheetsEnvironment;

  const existing = await getAllShortCodes(env);
  if (existing.includes(record.shortCode)) {
    throw new ConflictError("Short code already in use");
  }

  await appendValues(env, SHEET_DATA_RANGE, [
    [
      record.id,
      record.url,
      record.shortCode,
      record.createdAt,
      record.updatedAt,
      record.count,
    ],
  ]);

  return record;
}

export async function deleteShortUrl(
  envPartial: Partial<SheetsEnvironment>,
  shortCode: string,
): Promise<void> {
  validateEnv(envPartial);
  const env = {
    ...envPartial,
    GOOGLE_PRIVATE_KEY: sanitizePrivateKey(envPartial.GOOGLE_PRIVATE_KEY),
  } as SheetsEnvironment;

  const rowIndex = await findRowIndexByShortCode(env, shortCode);
  if (!rowIndex) throw new NotFoundError("Short code not found");

  const range = `Sheet1!A${rowIndex}:F${rowIndex}`;
  await clearRange(env, range);
}

export async function updateDestination(
  envPartial: Partial<SheetsEnvironment>,
  shortCode: string,
  newUrl: string,
): Promise<void> {
  validateEnv(envPartial);
  const env = {
    ...envPartial,
    GOOGLE_PRIVATE_KEY: sanitizePrivateKey(envPartial.GOOGLE_PRIVATE_KEY),
  } as SheetsEnvironment;

  const rowIndex = await findRowIndexByShortCode(env, shortCode);
  if (!rowIndex) throw new NotFoundError("Short code not found");

  // Update URL (B) & updatedAt (E)
  await updateValues(env, `Sheet1!B${rowIndex}`, [[newUrl]]);
  await updateValues(env, `Sheet1!E${rowIndex}`, [[new Date().toISOString()]]);
}

export async function resolveAndIncrement(
  envPartial: Partial<SheetsEnvironment>,
  shortCode: string,
): Promise<string> {
  validateEnv(envPartial);
  const env = {
    ...envPartial,
    GOOGLE_PRIVATE_KEY: sanitizePrivateKey(envPartial.GOOGLE_PRIVATE_KEY),
  } as SheetsEnvironment;

  const rowIndex = await findRowIndexByShortCode(env, shortCode);
  if (!rowIndex) throw new NotFoundError("Short code not found");

  const record = await readRowAsRecord(env, rowIndex);
  if (!record) throw new NotFoundError("Record not found");

  const newCount = record.count + 1;
  await updateValues(env, `Sheet1!F${rowIndex}`, [[newCount]]);
  return record.url;
}

export async function getStats(
  envPartial: Partial<SheetsEnvironment>,
  shortCode: string,
): Promise<number> {
  validateEnv(envPartial);
  const env = {
    ...envPartial,
    GOOGLE_PRIVATE_KEY: sanitizePrivateKey(envPartial.GOOGLE_PRIVATE_KEY),
  } as SheetsEnvironment;

  const rowIndex = await findRowIndexByShortCode(env, shortCode);
  if (!rowIndex) throw new NotFoundError("Short code not found");

  const record = await readRowAsRecord(env, rowIndex);
  if (!record) throw new NotFoundError("Record not found");
  return record.count;
}

export async function getRecord(
  envPartial: Partial<SheetsEnvironment>,
  shortCode: string,
): Promise<ShortUrlRecord> {
  validateEnv(envPartial);
  const env = {
    ...envPartial,
    GOOGLE_PRIVATE_KEY: sanitizePrivateKey(envPartial.GOOGLE_PRIVATE_KEY),
  } as SheetsEnvironment;

  const rowIndex = await findRowIndexByShortCode(env, shortCode);
  if (!rowIndex) throw new NotFoundError("Short code not found");

  const record = await readRowAsRecord(env, rowIndex);
  if (!record) throw new NotFoundError("Record not found");
  return record;
}

export async function assertShortCodeAvailable(
  envPartial: Partial<SheetsEnvironment>,
  shortCode: string,
): Promise<void> {
  validateEnv(envPartial);
  const env = {
    ...envPartial,
    GOOGLE_PRIVATE_KEY: sanitizePrivateKey(envPartial.GOOGLE_PRIVATE_KEY),
  } as SheetsEnvironment;

  const codes = await getAllShortCodes(env);
  if (codes.includes(shortCode)) {
    throw new ConflictError("Short code already in use");
  }
}

/* -------------------------------------------------------------------------- */
/* (Optional) Default Export Summary                                          */
/* -------------------------------------------------------------------------- */

export default {
  generateRecordId,
  buildShortUrlRecord,
  createShortUrl,
  deleteShortUrl,
  updateDestination,
  resolveAndIncrement,
  getStats,
  getRecord,
  assertShortCodeAvailable,
  NotFoundError,
  ConflictError,
};
