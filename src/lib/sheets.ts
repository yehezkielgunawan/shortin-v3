/*
  Google Sheets client using raw REST + Service Account JWT.
  - Works on Cloudflare Workers (Web Crypto) and Node during dev.
  - Columns schema (A..F):
    A: id, B: url, C: shortCode, D: createdAt, E: updatedAt, F: count
*/

import type { Context } from 'hono'
import { env } from 'hono/adapter'

export type ShortUrlRow = {
  id: string
  url: string
  shortCode: string
  createdAt: string
  updatedAt: string
  count: number
}

type GoogleEnv = {
  SPREADSHEET_ID: string
  GOOGLE_CLIENT_EMAIL: string
  GOOGLE_PRIVATE_KEY: string
  SHEET_NAME?: string
}

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

const textEncoder = new TextEncoder()

function isNode(): boolean {
  // Detect Node in vite dev or tests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (globalThis as any).process !== 'undefined' && !!(globalThis as any).process.versions?.node
}

function base64Encode(bytes: Uint8Array): string {
  if (!isNode()) {
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    return btoa(binary)
  }
  // Node
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const buf = Buffer.from(bytes)
  return buf.toString('base64')
}

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64(base64: string): Uint8Array {
  if (!isNode()) {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  // Node
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

function pemToPkcs8Der(pem: string): ArrayBuffer {
  const normalized = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  return decodeBase64(normalized).buffer
}

async function importPrivateKeyRS256(pemKey: string): Promise<CryptoKey> {
  const pkcs8 = pemToPkcs8Der(pemKey)
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

async function createServiceAccountJwt(c: Context): Promise<string> {
  const { GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY } = env<GoogleEnv>(c)
  const nowSec = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: GOOGLE_TOKEN_URI,
    iat: nowSec,
    exp: nowSec + 3600,
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const toSign = `${encodedHeader}.${encodedPayload}`
  const privateKey = await importPrivateKeyRS256(GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'))
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, textEncoder.encode(toSign))
  )
  const encodedSig = base64UrlEncode(signature)
  return `${toSign}.${encodedSig}`
}

async function getAccessToken(c: Context): Promise<string> {
  const assertion = await createServiceAccountJwt(c)
  const res = await fetch(GOOGLE_TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to fetch access token: ${res.status} ${text}`)
  }
  const json = (await res.json()) as { access_token: string }
  return json.access_token
}

function getSheetName(c: Context): string {
  const { SHEET_NAME } = env<GoogleEnv>(c)
  return SHEET_NAME && SHEET_NAME.trim().length > 0 ? SHEET_NAME : 'Sheet1'
}

async function sheetsFetch(c: Context, path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken(c)
  const url = `${SHEETS_BASE}${path}`
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })
}

function parseRow(values: string[]): ShortUrlRow | null {
  if (!values || values.length < 3) return null
  const [id, url, shortCode, createdAt, updatedAt, count] = [
    values[0] ?? '',
    values[1] ?? '',
    values[2] ?? '',
    values[3] ?? '',
    values[4] ?? '',
    values[5] ?? '0',
  ]
  if (!id || !url || !shortCode) return null
  const parsed: ShortUrlRow = {
    id,
    url,
    shortCode,
    createdAt,
    updatedAt,
    count: Number.parseInt(count || '0', 10) || 0,
  }
  return parsed
}

export async function listAllRows(
  c: Context
): Promise<{ rows: ShortUrlRow[]; raw: string[][]; offset: number }> {
  const { SPREADSHEET_ID } = env<GoogleEnv>(c)
  const sheet = getSheetName(c)
  const res = await sheetsFetch(
    c,
    `/${SPREADSHEET_ID}/values/${encodeURIComponent(sheet)}!A:F?majorDimension=ROWS`
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sheets values get failed: ${res.status} ${text}`)
  }
  const json = (await res.json()) as { values?: string[][] }
  const values = json.values ?? []
  const headerOffset = 1
  const dataRows = values.slice(headerOffset)
  const rows: ShortUrlRow[] = []
  for (const v of dataRows) {
    const r = parseRow(v)
    if (r) rows.push(r)
  }
  return { rows, raw: values, offset: headerOffset }
}

export async function findByShortCode(
  c: Context,
  shortCode: string
): Promise<{ row?: ShortUrlRow; rowNumber?: number }> {
  const all = await listAllRows(c)
  for (let i = 0; i < all.rows.length; i++) {
    const row = all.rows[i]
    if (row.shortCode === shortCode) {
      // Row number in sheet (1-based): header row (1) + index in data + 1
      return { row, rowNumber: all.offset + i + 1 }
    }
  }
  return {}
}

export async function appendRow(c: Context, data: ShortUrlRow): Promise<void> {
  const { SPREADSHEET_ID } = env<GoogleEnv>(c)
  const sheet = getSheetName(c)
  const res = await sheetsFetch(
    c,
    `/${SPREADSHEET_ID}/values/${encodeURIComponent(sheet)}!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      body: JSON.stringify({
        range: `${sheet}!A:F`,
        majorDimension: 'ROWS',
        values: [[data.id, data.url, data.shortCode, data.createdAt, data.updatedAt, String(data.count)]],
      }),
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sheets append failed: ${res.status} ${text}`)
  }
}

export async function updateRow(
  c: Context,
  rowNumber: number,
  data: Partial<ShortUrlRow>
): Promise<void> {
  const { SPREADSHEET_ID } = env<GoogleEnv>(c)
  const sheet = getSheetName(c)
  // Fetch current row values to merge updates
  const resGet = await sheetsFetch(
    c,
    `/${SPREADSHEET_ID}/values/${encodeURIComponent(sheet)}!A${rowNumber}:F${rowNumber}?majorDimension=ROWS`
  )
  const current = resGet.ok
    ? ((await resGet.json()) as { values?: string[][] }).values?.[0] ?? []
    : []
  const merged: string[] = []
  merged[0] = data.id ?? current[0] ?? ''
  merged[1] = data.url ?? current[1] ?? ''
  merged[2] = data.shortCode ?? current[2] ?? ''
  merged[3] = data.createdAt ?? current[3] ?? ''
  merged[4] = data.updatedAt ?? current[4] ?? ''
  merged[5] = data.count !== undefined ? String(data.count) : current[5] ?? '0'

  const res = await sheetsFetch(
    c,
    `/${SPREADSHEET_ID}/values/${encodeURIComponent(sheet)}!A${rowNumber}:F${rowNumber}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      body: JSON.stringify({
        range: `${sheet}!A${rowNumber}:F${rowNumber}`,
        majorDimension: 'ROWS',
        values: [merged],
      }),
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sheets update failed: ${res.status} ${text}`)
  }
}

export async function clearRow(c: Context, rowNumber: number): Promise<void> {
  const { SPREADSHEET_ID } = env<GoogleEnv>(c)
  const sheet = getSheetName(c)
  const res = await sheetsFetch(
    c,
    `/${SPREADSHEET_ID}/values/${encodeURIComponent(sheet)}!A${rowNumber}:F${rowNumber}:clear`,
    { method: 'POST' }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sheets clear failed: ${res.status} ${text}`)
  }
}

export function generateId(): string {
  const rand = Math.floor(Math.random() * 10_000)
  return `id_${Date.now()}_${rand}`
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
export function generateShortCode(length = 6): string {
  let out = ''
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return out
}
