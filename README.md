### Shortin v3 (Hono + Cloudflare Workers)

Shortin v3 is a full-stack URL shortener built on Hono. It provides API routes under `/api` and a minimal frontend using `hono/jsx` with client interactivity via `hono/jsx/dom`. Data is stored in Google Sheets using a Service Account.

## Tech
- Hono (routing, JSX SSR, validator)
- Cloudflare Workers (deploy target)
- Google Sheets (storage via REST + JWT)
- Tailwind CSS v4 + Plus Jakarta Sans
- Rate limiting via `hono-rate-limiter`

## Prerequisites
- pnpm
- Cloudflare Wrangler (`pnpm dlx wrangler --version`)
- A Google Service Account with Sheets API enabled and the sheet shared with the service account email

## Environment
Define the following in Cloudflare environment (Dashboard or `wrangler secret put`):

- `SPREADSHEET_ID`
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY` (PEM, keep line breaks; when setting as secret, use the original multiline key)
- Optional: `SHEET_NAME` (defaults to `Sheet1`)

Note: Locally during dev, these can be provided via your shell environment. This project uses `hono/adapter` to read envs.

## Install & Dev

```bash
pnpm install
pnpm dev
```

Build & Preview locally (Worker-like):

```bash
pnpm cf:preview
```

Deploy to Cloudflare Workers:

```bash
pnpm cf:deploy
```

Type generation for Cloudflare bindings (optional):

```bash
pnpm cf-typegen
```

## Data Model (Google Sheets)
Columns A..F:
- A: id
- B: url
- C: shortCode
- D: createdAt
- E: updatedAt
- F: count

Ensure a header row exists in row 1.

## API
Base path: `/api`

- POST `/api/shorten`
  - Body: `{ url: string, shortCodeInput?: string }`
  - 201 JSON: `{ id, url, shortCode, createdAt, updatedAt, count }`
  - 400 JSON: `{ error: 'Short code already in use' }`

- GET `/api/shorten/:shortCodeInput/stats`
  - 200 JSON: `{ count }`
  - 404 JSON: `{ error }`

- PUT `/api/shorten/:shortCodeInput`
  - Body: `{ url: string }`
  - 200 JSON: `{ message }`
  - 404 JSON: `{ error }`

- DELETE `/api/shorten/:shortCodeInput`
  - 200 JSON: `{ message }`
  - 404 JSON: `{ error }`

- GET `/api/shorten`
  - 200 JSON: `{ items: ShortUrlRow[] }`

Rate limit: default 5 req/min per IP (headers included via hono-rate-limiter). For distributed production, prefer KV/DO store variant.

## Redirects
- GET `/:shortCode`
  - 302 redirect to original URL and increments visit count

## Frontend
- Route `/` renders a simple form to create short links
- Client interactivity is via `hono/jsx/dom` without extra deps

## Notes
- Environment access uses `hono/adapter` (`env(c)`) so no dotenv is required.
- Keep the private key secret and include proper line breaks.
