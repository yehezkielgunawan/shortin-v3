import { Hono } from "hono";
import { renderer } from "@/renderer";
import { z } from "zod";
import {
  createShortUrl,
  buildShortUrlRecord,
  assertShortCodeAvailable,
  updateDestination,
  deleteShortUrl,
  resolveAndIncrement,
  getStats,
  ConflictError,
  NotFoundError,
} from "@/lib/sheets";
import { generateShortCode } from "@/lib/shortcode";
import createRateLimiter from "@/middleware/rate-limit";

/**
 * Helper to extract Google Sheets env from Cloudflare bindings (or fallback to process.env when present).
 */
function getSheetsEnv(c: any) {
  const source =
    (c && c.env) ||
    (typeof process !== "undefined" ? (process as any).env : {}) ||
    {};
  return {
    SPREADSHEET_ID: source.SPREADSHEET_ID,
    GOOGLE_PROJECT_ID: source.GOOGLE_PROJECT_ID,
    GOOGLE_PRIVATE_KEY_ID: source.GOOGLE_PRIVATE_KEY_ID,
    GOOGLE_PRIVATE_KEY: source.GOOGLE_PRIVATE_KEY,
    GOOGLE_CLIENT_EMAIL: source.GOOGLE_CLIENT_EMAIL,
    GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID,
    GOOGLE_AUTH_URI: source.GOOGLE_AUTH_URI,
    GOOGLE_TOKEN_URI: source.GOOGLE_TOKEN_URI,
    GOOGLE_AUTH_PROVIDER_X509_CERT_URL:
      source.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
    GOOGLE_CLIENT_X509_CERT_URL: source.GOOGLE_CLIENT_X509_CERT_URL,
    GOOGLE_UNIVERSE_DOMAIN: source.GOOGLE_UNIVERSE_DOMAIN,
  };
}

const app = new Hono();

// Rate limiting (30 requests / 5 minutes)
app.use("*", createRateLimiter({ limit: 30, windowMs: 5 * 60 * 1000 }));
app.use(renderer);

/**
 * Root (Welcome)
 */
app.get("/", (c) => c.text("Welcome to the URL Shortener API!"));

// Minimal UI (non-JS graceful fallback posts form-encoded)
app.get("/app", (c) =>
  c.render(
    <main class="min-h-screen flex flex-col items-center justify-center gap-6 p-6">
      <h1 class="text-3xl font-bold">Shortin v3</h1>
      <form
        class="flex flex-col gap-4 w-full max-w-md"
        method="post"
        action="/shorten"
        id="shorten-form"
      >
        <input
          name="url"
          placeholder="https://example.com/very/long/url"
          class="border rounded px-3 py-2"
          required
        />
        <input
          name="shortCodeInput"
          placeholder="Custom code (optional)"
          class="border rounded px-3 py-2"
        />
        <button
          type="submit"
          class="bg-black text-white rounded px-4 py-2 hover:bg-neutral-800"
        >
          Shorten
        </button>
      </form>
      <pre
        id="result"
        class="bg-neutral-100 rounded p-4 w-full max-w-md text-sm overflow-x-auto"
      >
        Paste the JSON response here.
      </pre>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function(){
              const f=document.getElementById('shorten-form');
              const r=document.getElementById('result');
              if(!f)return;
              f.addEventListener('submit',async(e)=>{
                e.preventDefault();
                const fd=new FormData(f);
                const body={
                  url: fd.get('url'),
                  shortCodeInput: fd.get('shortCodeInput')||undefined
                };
                try{
                  const res=await fetch('/shorten',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
                  const json=await res.json();
                  r.textContent=JSON.stringify(json,null,2);
                }catch(err){
                  r.textContent='Request failed';
                }
              });
            })();
          `,
        }}
      />
    </main>,
  ),
);

// Schemas
const shortenSchema = z.object({
  url: z.string().url({ message: "Invalid URL format" }),
  shortCodeInput: z
    .string()
    .regex(/^[A-Za-z0-9_-]{3,30}$/)
    .optional(),
});

const updateSchema = z.object({
  url: z.string().url({ message: "Invalid URL format" }),
});

/**
 * POST /shorten
 */
app.post("/shorten", async (c) => {
  // Accept JSON or form-encoded
  let raw: any = {};
  const contentType = c.req.header("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      raw = await c.req.json();
    } else {
      const form = await c.req.parseBody();
      raw = form;
    }
  } catch {
    return c.json({ error: "Invalid body" }, 400);
  }

  let parsed;
  try {
    parsed = shortenSchema.parse(raw);
  } catch (e: any) {
    return c.json(
      {
        error: "Validation failed",
        details: e?.issues || e?.errors || undefined,
      },
      400,
    );
  }

  const { url, shortCodeInput } = parsed;
  const env = getSheetsEnv(c);

  try {
    let finalShortCode = shortCodeInput;

    if (shortCodeInput) {
      await assertShortCodeAvailable(env, shortCodeInput);
    } else {
      let attempts = 0;
      while (!finalShortCode && attempts < 8) {
        const candidate = generateShortCode({ length: 6 });
        try {
          await assertShortCodeAvailable(env, candidate);
          finalShortCode = candidate;
        } catch {
          attempts++;
        }
      }
      if (!finalShortCode) {
        return c.json({ error: "Failed to generate unique short code" }, 500);
      }
    }

    const record = buildShortUrlRecord({
      url,
      shortCode: finalShortCode!,
    });

    const created = await createShortUrl(env, record);
    return c.json(created, 201);
  } catch (err: any) {
    if (err instanceof ConflictError) {
      return c.json({ error: "Short code already in use" }, 400);
    }
    return c.json({ error: "Failed to create short URL" }, 500);
  }
});

/**
 * DELETE /shorten/:shortCodeInput
 */
app.delete("/shorten/:shortCodeInput", async (c) => {
  const shortCodeInput = c.req.param("shortCodeInput");
  if (!shortCodeInput) {
    return c.json({ error: "Short code is required" }, 400);
  }
  const env = getSheetsEnv(c);
  try {
    await deleteShortUrl(env, shortCodeInput);
    return c.json({ message: "Short code deleted successfully" }, 200);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Short code not found" }, 404);
    }
    return c.json({ error: "Failed to delete short URL" }, 500);
  }
});

/**
 * PUT /shorten/:shortCodeInput
 */
app.put("/shorten/:shortCodeInput", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid body" }, 400);
  }

  let parsed;
  try {
    parsed = updateSchema.parse(body);
  } catch (e: any) {
    return c.json(
      { error: "Validation failed", details: e?.issues || e?.errors },
      400,
    );
  }

  const { url } = parsed;
  const shortCodeInput = c.req.param("shortCodeInput");
  if (!shortCodeInput || !url) {
    return c.json({ error: "Short code and URL are required" }, 400);
  }
  const env = getSheetsEnv(c);
  try {
    await updateDestination(env, shortCodeInput, url);
    return c.json({ message: "Short code updated successfully" }, 200);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Short code not found" }, 404);
    }
    return c.json({ error: "Failed to update short URL" }, 500);
  }
});

/**
 * GET /shorten/:shortCodeInput/stats
 */
app.get("/shorten/:shortCodeInput/stats", async (c) => {
  const shortCodeInput = c.req.param("shortCodeInput");
  if (!shortCodeInput) {
    return c.json({ error: "Short code is required" }, 400);
  }
  const env = getSheetsEnv(c);
  try {
    const count = await getStats(env, shortCodeInput);
    return c.json({ count }, 200);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Short code not found" }, 404);
    }
    return c.json({ error: "Failed to retrieve short URL stats" }, 500);
  }
});

/**
 * GET /:shortCodeInput
 */
app.get("/:shortCodeInput", async (c) => {
  const shortCodeInput = c.req.param("shortCodeInput");
  if (!shortCodeInput) {
    return c.json({ error: "Short code is required" }, 400);
  }
  if (shortCodeInput === "shorten") {
    return c.notFound();
  }

  const env = getSheetsEnv(c);
  try {
    const url = await resolveAndIncrement(env, shortCodeInput);
    return c.json({ url }, 200);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return c.json({ error: "Short code not found" }, 404);
    }
    return c.json({ error: "Failed to retrieve short URL" }, 500);
  }
});

export default app;
