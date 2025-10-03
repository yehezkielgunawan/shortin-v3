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

/* ----------------------------------------------------------------------------
 * UI Components (hono/jsx) - no React dependency required
 * -------------------------------------------------------------------------- */

type JsonResultProps = { id?: string };
const JsonResult = ({ id = "result" }: JsonResultProps) => (
  <pre
    id={id}
    class="bg-neutral-100 rounded p-4 w-full max-w-xl text-xs sm:text-sm overflow-x-auto min-h-32"
  >
    Submit the form to see the API response here.
  </pre>
);

interface ShortenFormProps {
  action?: string;
  resultId?: string;
}

const ShortenForm = ({
  action = "/shorten",
  resultId = "result",
}: ShortenFormProps) => (
  <form
    class="flex flex-col gap-4 w-full max-w-xl"
    method="post"
    action={action}
    id="shorten-form"
  >
    <div class="flex flex-col gap-2">
      <label class="text-sm font-medium" for="url">
        Long URL
      </label>
      <input
        id="url"
        name="url"
        placeholder="https://example.com/very/long/url"
        class="border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/40"
        required
      />
    </div>

    <div class="flex flex-col gap-2">
      <label class="text-sm font-medium" for="shortCodeInput">
        Custom Short Code (optional)
      </label>
      <input
        id="shortCodeInput"
        name="shortCodeInput"
        placeholder="your-alias"
        class="border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/40"
      />
      <p class="text-xs text-neutral-500">
        3–30 chars. Letters, numbers, underscore, hyphen.
      </p>
    </div>

    <div class="flex items-center gap-4">
      <button
        type="submit"
        class="bg-black text-white rounded px-5 py-2 font-medium hover:bg-neutral-800 transition"
      >
        Shorten
      </button>
      <button
        type="button"
        data-reset
        class="text-sm text-neutral-600 hover:text-black"
      >
        Reset
      </button>
    </div>

    <script
      dangerouslySetInnerHTML={{
        __html: `
        (function(){
          const form = document.getElementById('shorten-form');
          if(!form) return;
          const resultEl = document.getElementById('${resultId}');
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if(!resultEl) return;
            const fd = new FormData(form);
            const body = {
              url: fd.get('url'),
              shortCodeInput: fd.get('shortCodeInput') || undefined
            };
            resultEl.textContent = 'Submitting...';
            try {
              const res = await fetch('${action}', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify(body)
              });
              const json = await res.json();
              resultEl.textContent = JSON.stringify(json, null, 2);
            } catch (err) {
              resultEl.textContent = 'Request failed';
            }
          });
          form.querySelector('[data-reset]')?.addEventListener('click', () => {
            form.reset();
            if(resultEl) resultEl.textContent = 'Cleared.';
          });
        })();
        `,
      }}
    />
  </form>
);

const SectionCard = (props: { title: string; children: any }) => (
  <section class="w-full max-w-4xl bg-white/60 backdrop-blur border rounded-lg p-6 flex flex-col gap-4 shadow-sm">
    <header class="flex items-center justify-between">
      <h2 class="font-semibold text-lg">{props.title}</h2>
    </header>
    <div>{props.children}</div>
  </section>
);

const Layout = (props: { children: any }) => (
  <main class="min-h-screen w-full flex flex-col items-center gap-10 p-6 bg-gradient-to-b from-neutral-50 to-neutral-100 font-sans">
    <header class="w-full max-w-4xl flex flex-col gap-2">
      <h1 class="text-3xl font-bold tracking-tight">Shortin v3</h1>
      <p class="text-neutral-600 text-sm">
        A minimal URL shortener powered by Hono, Google Sheets (edge REST), and
        hono/jsx UI components.
      </p>
      <nav class="flex gap-4 text-sm">
        <a href="/app" class="underline underline-offset-4 hover:text-black">
          Home
        </a>
        <a
          href="https://roadmap.sh/projects/url-shortening-service"
          class="hover:text-black"
          target="_blank"
          rel="noopener noreferrer"
        >
          Idea
        </a>
        <a
          href="https://hono.dev"
          class="hover:text-black"
          target="_blank"
          rel="noopener noreferrer"
        >
          Hono Docs
        </a>
      </nav>
    </header>
    <div class="w-full flex flex-col items-center gap-8">{props.children}</div>
    <footer class="mt-auto w-full max-w-4xl text-xs text-neutral-500 pt-8 pb-4">
      Built with hono/jsx. Data stored in Google Sheets.
    </footer>
  </main>
);

const AppPage = () => (
  <Layout>
    <SectionCard title="Create a Short Link">
      <ShortenForm />
    </SectionCard>
    <SectionCard title="Result">
      <JsonResult />
    </SectionCard>
    <SectionCard title="API Endpoints">
      <ul class="list-disc pl-5 space-y-1 text-sm">
        <li>
          <code class="bg-neutral-200 px-1 rounded">POST /shorten</code> –
          create short URL
        </li>
        <li>
          <code class="bg-neutral-200 px-1 rounded">
            GET /&lt;shortCode&gt;
          </code>{" "}
          – resolve
        </li>
        <li>
          <code class="bg-neutral-200 px-1 rounded">
            GET /shorten/&lt;shortCode&gt;/stats
          </code>{" "}
          – visits
        </li>
        <li>
          <code class="bg-neutral-200 px-1 rounded">
            PUT /shorten/&lt;shortCode&gt;
          </code>{" "}
          – update destination
        </li>
        <li>
          <code class="bg-neutral-200 px-1 rounded">
            DELETE /shorten/&lt;shortCode&gt;
          </code>{" "}
          – delete
        </li>
      </ul>
    </SectionCard>
  </Layout>
);

/* ----------------------------------------------------------------------------
 * App + API
 * -------------------------------------------------------------------------- */

const app = new Hono();

app.use("*", createRateLimiter({ limit: 30, windowMs: 5 * 60 * 1000 }));
app.use(renderer);

/**
 * Root (Welcome)
 */
app.get("/", (c) => c.text("Welcome to the URL Shortener API!"));

// Component-driven UI route
app.get("/app", (c) => c.render(<AppPage />));

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
