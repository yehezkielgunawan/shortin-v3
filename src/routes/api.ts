import { Hono } from 'hono'
import { validator } from 'hono/validator'
import { rateLimiter } from 'hono-rate-limiter'
import {
  appendRow,
  clearRow,
  findByShortCode,
  generateId,
  generateShortCode,
  listAllRows,
  updateRow,
} from '@/lib/sheets'

type Bindings = {}

const api = new Hono<{ Bindings: Bindings }>()

const limiter = rateLimiter({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-6',
  keyGenerator: (c) =>
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for') ??
    c.req.raw.headers.get('x-real-ip') ??
    c.req.raw.headers.get('host') ??
    'anonymous',
})

api.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Headers', 'Content-Type')
  c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  c.header(
    'Access-Control-Expose-Headers',
    'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, RateLimit-Policy, RateLimit-Remaining, RateLimit-Reset'
  )
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  return limiter(c, next)
})

const validateShorten = validator('json', (value, c) => {
  const url = String(value?.url ?? '')
  try {
    // throws on invalid
    // eslint-disable-next-line no-new
    new URL(url)
  } catch {
    return c.json({ error: 'Invalid url' }, 400)
  }
  let shortCodeInput: string | undefined = value?.shortCodeInput
  if (shortCodeInput != null) {
    shortCodeInput = String(shortCodeInput)
    if (shortCodeInput.length < 3 || shortCodeInput.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(shortCodeInput)) {
      return c.json({ error: 'Invalid shortCodeInput' }, 400)
    }
  }
  return { url, shortCodeInput }
})

api.post('/shorten', validateShorten, async (c) => {
  const { url, shortCodeInput } = c.req.valid('json') as { url: string; shortCodeInput?: string }

  const code = (shortCodeInput && shortCodeInput.trim()) || generateShortCode(6)
  const existing = await findByShortCode(c, code)
  if (existing.row) {
    return c.json({ error: 'Short code already in use' }, 400)
  }

  const now = new Date().toISOString()
  const row = {
    id: generateId(),
    url,
    shortCode: code,
    createdAt: now,
    updatedAt: now,
    count: 0,
  }
  await appendRow(c, row)
  return c.json(row, 201)
})

api.get('/shorten/:shortCodeInput/stats', async (c) => {
  const shortCode = c.req.param('shortCodeInput')
  const { row } = await findByShortCode(c, shortCode)
  if (!row) return c.json({ error: 'Short code not found' }, 404)
  return c.json({ count: row.count })
})

const validateUpdate = validator('json', (value, c) => {
  const url = String(value?.url ?? '')
  try {
    // eslint-disable-next-line no-new
    new URL(url)
  } catch {
    return c.json({ error: 'Invalid url' }, 400)
  }
  return { url }
})

api.put('/shorten/:shortCodeInput', validateUpdate, async (c) => {
  const shortCode = c.req.param('shortCodeInput')
  const { url } = c.req.valid('json') as { url: string }
  const found = await findByShortCode(c, shortCode)
  if (!found.row || !found.rowNumber) return c.json({ error: 'Short code not found' }, 404)
  const now = new Date().toISOString()
  await updateRow(c, found.rowNumber, { url, updatedAt: now })
  return c.json({ message: 'Short code updated successfully' })
})

api.delete('/shorten/:shortCodeInput', async (c) => {
  const shortCode = c.req.param('shortCodeInput')
  const found = await findByShortCode(c, shortCode)
  if (!found.row || !found.rowNumber) return c.json({ error: 'Short code not found' }, 404)
  await clearRow(c, found.rowNumber)
  return c.json({ message: 'Short code deleted successfully' })
})

api.get('/shorten', async (c) => {
  const { rows } = await listAllRows(c)
  return c.json({ items: rows })
})

export default api
