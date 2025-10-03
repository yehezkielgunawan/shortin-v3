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
import { ShortenApp } from "@/client/ShortenApp";
import { env as honoEnv } from "hono/adapter";

/**
 * Extract env values using hono/adapter (supports Workers & Node).
 */
function getSheetsEnv(c: any) {
  const source = honoEnv(c) as Record<string, string | undefined>;
  const fallback =
    typeof process !== "undefined"
      ? ((process as any).env as Record<string, string | undefined>)
      : {};
  const pick = (k: string) => source?.[k] ?? fallback?.[k];

  return {
    SPREADSHEET_ID: pick("SPREADSHEET_ID"),
    GOOGLE_PROJECT_ID: pick("GOOGLE_PROJECT_ID"),
    GOOGLE_PRIVATE_KEY_ID: pick("GOOGLE_PRIVATE_KEY_ID"),
    GOOGLE_PRIVATE_KEY: pick("GOOGLE_PRIVATE_KEY"),
    GOOGLE_CLIENT_EMAIL: pick("GOOGLE_CLIENT_EMAIL"),
    GOOGLE_CLIENT_ID: pick("GOOGLE_CLIENT_ID"),
    GOOGLE_AUTH_URI: pick("GOOGLE_AUTH_URI"),
    GOOGLE_TOKEN_URI: pick("GOOGLE_TOKEN_URI"),
    GOOGLE_AUTH_PROVIDER_X509_CERT_URL: pick(
      "GOOGLE_AUTH_PROVIDER_X509_CERT_URL",
    ),
    GOOGLE_CLIENT_X509_CERT_URL: pick("GOOGLE_CLIENT_X509_CERT_URL"),
    GOOGLE_UNIVERSE_DOMAIN: pick("GOOGLE_UNIVERSE_DOMAIN"),
    BASE_URL: pick("BASE_URL"),
  };
}

/* ----------------------------------------------------------------------------
 * Minimal Frontend (hono/jsx) – single page at "/"
 * -------------------------------------------------------------------------- */

const HomePage = () => (
  <main class="min-h-screen font-sans bg-neutral-50 text-neutral-900 flex flex-col items-center px-6 py-12 gap-12">
    <header class="flex flex-col items-center gap-4 mb-4">
      <h1 class="text-4xl font-bold tracking-tight">Shortin</h1>
      <p class="text-lg text-center">Personalized Link Shortener by Yehezgun</p>
    </header>
    <ShortenApp class="w-full" />
    <footer class="mt-auto text-xs text-neutral-500 pt-10">
      Powered by Hono & Google Sheets
    </footer>
  </main>
);

/* ----------------------------------------------------------------------------
 * App Initialization
 * -------------------------------------------------------------------------- */

const app = new Hono();
app.use("*", createRateLimiter({ limit: 30, windowMs: 5 * 60 * 1000 }));
app.use(renderer);

/* ----------------------------------------------------------------------------
 * Frontend Route (Root)
 * -------------------------------------------------------------------------- */
app.get("/", (c) => c.render(<HomePage />));

/* ----------------------------------------------------------------------------
 * Validation Schemas
 * -------------------------------------------------------------------------- */
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

/* ----------------------------------------------------------------------------
 * API Routes (/api/...)
 * -------------------------------------------------------------------------- */
app.get("/api", (c) => c.text("Welcome to the URL Shortener API!"));

app.post("/api/shorten", async (c) => {
  let raw: any = {};
  const ct = c.req.header("content-type") || "";
  try {
    raw = ct.includes("application/json")
      ? await c.req.json()
      : await c.req.parseBody();
  } catch {
    return c.json({ error: "Invalid body" }, 400);
  }

  let parsed;
  try {
    parsed = shortenSchema.parse(raw);
  } catch (e: any) {
    return c.json({ error: "Validation failed", details: e?.issues }, 400);
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

    const record = buildShortUrlRecord({ url, shortCode: finalShortCode! });
    const created = await createShortUrl(env, record);
    const baseUrl =
      env.BASE_URL && env.BASE_URL.trim().length > 0
        ? env.BASE_URL.endsWith("/")
          ? env.BASE_URL
          : env.BASE_URL + "/"
        : new URL(c.req.url).origin + "/";
    return c.json({ ...created, baseUrl }, 201);
  } catch (err: any) {
    if (err instanceof ConflictError) {
      return c.json({ error: "Short code already in use" }, 400);
    }
    return c.json({ error: "Failed to create short URL" }, 500);
  }
});

app.delete("/api/shorten/:shortCodeInput", async (c) => {
  const shortCodeInput = c.req.param("shortCodeInput");
  if (!shortCodeInput) return c.json({ error: "Short code is required" }, 400);
  const env = getSheetsEnv(c);
  try {
    await deleteShortUrl(env, shortCodeInput);
    return c.json({ message: "Short code deleted successfully" }, 200);
  } catch (err) {
    if (err instanceof NotFoundError)
      return c.json({ error: "Short code not found" }, 404);
    return c.json({ error: "Failed to delete short URL" }, 500);
  }
});

app.put("/api/shorten/:shortCodeInput", async (c) => {
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
    return c.json({ error: "Validation failed", details: e?.issues }, 400);
  }

  const shortCodeInput = c.req.param("shortCodeInput");
  if (!shortCodeInput) return c.json({ error: "Short code is required" }, 400);

  const env = getSheetsEnv(c);
  try {
    await updateDestination(env, shortCodeInput, parsed.url);
    return c.json({ message: "Short code updated successfully" }, 200);
  } catch (err) {
    if (err instanceof NotFoundError)
      return c.json({ error: "Short code not found" }, 404);
    return c.json({ error: "Failed to update short URL" }, 500);
  }
});

app.get("/api/shorten/:shortCodeInput/stats", async (c) => {
  const shortCodeInput = c.req.param("shortCodeInput");
  if (!shortCodeInput) return c.json({ error: "Short code is required" }, 400);
  const env = getSheetsEnv(c);
  try {
    const count = await getStats(env, shortCodeInput);
    return c.json({ count }, 200);
  } catch (err) {
    if (err instanceof NotFoundError)
      return c.json({ error: "Short code not found" }, 404);
    return c.json({ error: "Failed to retrieve short URL stats" }, 500);
  }
});

/**
 * Friendly short code resolution with a 3-second delayed redirect
 */
app.get("/:shortCodeInput", async (c) => {
  const shortCodeInput = c.req.param("shortCodeInput");
  if (!shortCodeInput) return c.json({ error: "Short code is required" }, 400);
  if (shortCodeInput === "api") return c.notFound();

  const env = getSheetsEnv(c);
  try {
    const destination = await resolveAndIncrement(env, shortCodeInput);
    return c.render(
      <main class="min-h-screen flex flex-col items-center justify-center font-sans bg-neutral-50 text-neutral-900 px-6 text-center gap-6">
        <div class="flex flex-col gap-4 max-w-xl">
          <h1 class="text-3xl font-bold">Redirecting...</h1>
          <p class="text-lg">
            You will be redirected to:
            <br />
            <a
              href={destination}
              class="underline break-all text-blue-600 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 rounded"
            >
              {destination}
            </a>
          </p>
          <p class="text-sm text-neutral-600">
            If nothing happens in 3 seconds, use the link above.
          </p>
          <div
            aria-label="Loading"
            role="status"
            class="mx-auto w-12 h-12 border-4 border-neutral-300 border-t-black rounded-full animate-spin"
          />
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html: `setTimeout(()=>{window.location.href=${JSON.stringify(
              destination,
            )}},3000);`,
          }}
        />
      </main>,
    );
  } catch (err) {
    if (err instanceof NotFoundError)
      return c.json({ error: "Short code not found" }, 404);
    return c.json({ error: "Failed to retrieve short URL" }, 500);
  }
});

export default app;
