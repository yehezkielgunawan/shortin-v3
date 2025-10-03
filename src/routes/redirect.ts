import { Hono } from 'hono'
import { findByShortCode, updateRow } from '@/lib/sheets'

const redirect = new Hono()

redirect.get('/:shortCode', async (c) => {
  const code = c.req.param('shortCode')
  if (code === 'api') return c.notFound()
  const found = await findByShortCode(c, code)
  if (!found.row || !found.rowNumber) return c.json({ error: 'Short code not found' }, 404)
  const newCount = (found.row.count || 0) + 1
  await updateRow(c, found.rowNumber, { count: newCount, updatedAt: new Date().toISOString() })
  return c.redirect(found.row.url, 302)
})

export default redirect
