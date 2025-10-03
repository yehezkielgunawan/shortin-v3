/**
 * ShortenApp.tsx
 * Interactive URL shortener form using hono/jsx/dom (no external React dependency).
 *
 * Features:
 *  - Accessible form (labels, aria-live for status)
 *  - Keyboard friendly (Enter & Space triggers)
 *  - Copy to clipboard with feedback
 *  - Responsive layout (utility classes rely on existing Tailwind setup)
 *  - Clean state management via hono/jsx/dom hooks
 *
 * Expected server endpoint: POST /api/shorten
 * Body: { url: string, shortCodeInput?: string }
 * Response: { shortCode: string, url: string, ... }
 *
 * Usage (server-side):
 *   import { ShortenApp } from "@/client/ShortenApp"
 *   ...
 *   c.render(<ShortenApp />)
 */
import { Fragment } from "hono/jsx";
import { useEffect, useRef, useState } from "hono/jsx/dom";

type ApiSuccess = {
  id: string;
  url: string;
  shortCode: string;
  createdAt: string;
  updatedAt: string;
  count: number;
  baseUrl?: string; // optional BASE_URL returned by API
};

type ApiError = {
  error: string;
  message?: string;
  details?: unknown;
};

interface ShortenAppProps {
  apiEndpoint?: string;
  class?: string;
}

/**
 * Utility: Build the base URL (origin + slash)
 */
function getOriginBase(): string {
  if (typeof window === "undefined") return "/";
  return window.location.origin + "/";
}

/**
 * Accessible status announcer (sr-only) + visual region.
 */
const StatusRegion = ({ status }: { status: string }) => (
  <div class="flex flex-col gap-1">
    <p
      id="status-msg"
      class="text-sm text-neutral-600 min-h-[1.25rem]"
      aria-live="polite"
    >
      {status}
    </p>
  </div>
);

export const ShortenApp = ({
  apiEndpoint = "/api/shorten",
  class: outerClass = "",
}: ShortenAppProps) => {
  const [longUrl, setLongUrl] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [shortUrl, setShortUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [base, setBase] = useState(getOriginBase());
  const copyBtnRef = useRef<HTMLButtonElement | null>(null);
  const shortenBtnRef = useRef<HTMLButtonElement | null>(null);
  const longInputRef = useRef<HTMLInputElement | null>(null);

  // Keep base updated on mount (and in case of dynamic environment changes)
  useEffect(() => {
    setBase(getOriginBase());
  }, []);

  // Focus the copy button after a successful shorten
  useEffect(() => {
    if (shortUrl && copyBtnRef.current) {
      copyBtnRef.current.focus();
    }
  }, [shortUrl]);

  function resetResult() {
    setShortUrl(null);
    setStatus("");
  }

  async function handleSubmit(e?: Event) {
    if (e) e.preventDefault();
    resetResult();

    const trimmed = longUrl.trim();
    if (!trimmed) {
      setStatus("Please provide a valid URL.");
      return;
    }

    setLoading(true);
    setStatus("Creating short link...");

    try {
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: trimmed,
          shortCodeInput: customCode.trim() || undefined,
        }),
      });

      const data: ApiSuccess | ApiError = await res.json();
      if (!res.ok || (data as ApiError).error) {
        const err = data as ApiError;
        setStatus(err.error || "Failed to shorten URL.");
        setShortUrl(null);
        setLoading(false);
        return;
      }

      const success = data as ApiSuccess;
      // If API returns baseUrl (from BASE_URL env), prefer it & normalize trailing slash
      if (success.baseUrl) {
        const normalized = success.baseUrl.endsWith("/")
          ? success.baseUrl
          : success.baseUrl + "/";
        setBase(normalized);
      }
      const effectiveBase = success.baseUrl
        ? success.baseUrl.endsWith("/")
          ? success.baseUrl
          : success.baseUrl + "/"
        : base;
      const final = effectiveBase + success.shortCode;
      setShortUrl(final);
      setStatus("Short link created!");
    } catch (err) {
      setStatus("Request failed. Please try again.");
      setShortUrl(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!shortUrl) {
      setStatus("Nothing to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(shortUrl);
      setStatus("Copied to clipboard!");
    } catch {
      setStatus("Copy failed.");
    }
  }

  function handleKeyActivateSubmit(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleKeyActivateCopy(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleCopy();
    }
  }

  return (
    <div class={`w-full flex flex-col items-center ${outerClass}`}>
      <form
        class="w-full max-w-5xl flex flex-col gap-10"
        onSubmit={handleSubmit}
        aria-describedby="status-msg"
      >
        {/* Long URL Input */}
        <div class="flex flex-col gap-3">
          <label for="long-url" class="font-semibold text-lg">
            Long URL
          </label>
          <input
            ref={longInputRef}
            id="long-url"
            name="long-url"
            type="url"
            placeholder="https://example.com/very/long/url"
            class="w-full border rounded-md px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-black/60"
            required
            value={longUrl}
            onInput={(e) => {
              setLongUrl((e.target as HTMLInputElement).value);
              if (shortUrl) resetResult();
            }}
          />
        </div>

        {/* Shortened URL Construction */}
        <div class="flex flex-col gap-3">
          <label class="font-semibold text-lg">Shortened URL</label>
          <div class="flex flex-col md:flex-row gap-3">
            <input
              aria-label="Generated base domain"
              id="short-base"
              disabled
              class="md:w-1/3 w-full border rounded-md px-4 py-3 bg-neutral-100 text-neutral-500 font-medium select-all"
              value={base}
            />
            <input
              id="custom-code"
              name="custom-code"
              placeholder="custom-alias (optional)"
              class="flex-1 border rounded-md px-4 py-3 bg-white focus:outline-none focus:ring-2 focus:ring-black/60"
              value={customCode}
              onInput={(e) => {
                setCustomCode((e.target as HTMLInputElement).value);
                if (shortUrl) resetResult();
              }}
              pattern="^[A-Za-z0-9_-]{0,30}$"
              title="Letters, numbers, underscore, hyphen. Up to 30 characters."
            />
          </div>
          <p class="text-xs text-neutral-500">
            Allowed: letters, numbers, underscore, hyphen (max 30). Leave blank
            for auto generation.
          </p>
        </div>

        {/* Result */}
        <div
          id="result-wrapper"
          class={`${
            shortUrl ? "flex" : "hidden"
          } flex-col gap-3 transition-opacity opacity-100`}
          aria-live="polite"
        >
          <label class="font-semibold text-lg">Result</label>
          <div class="flex flex-col md:flex-row gap-3 items-stretch">
            <input
              id="final-url"
              readOnly
              class="w-full border rounded-md px-4 py-3 bg-neutral-100 font-medium select-all"
              value={shortUrl || ""}
              aria-label="Shortened URL output"
            />
            <button
              ref={copyBtnRef}
              type="button"
              disabled={!shortUrl}
              onClick={handleCopy}
              onKeyDown={handleKeyActivateCopy}
              class={`md:w-40 w-full border rounded-md px-4 py-3 font-medium transition
                  focus:outline-none focus:ring-2 focus:ring-black/60 focus:ring-offset-2
                  cursor-pointer ${
                    shortUrl
                      ? "bg-black text-white hover:bg-neutral-800 hover:shadow active:scale-[0.98]"
                      : "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                  }`}
              aria-disabled={!shortUrl}
            >
              Copy
            </button>
          </div>
        </div>

        <StatusRegion status={status} />

        {/* Action Button */}
        <div>
          <button
            ref={shortenBtnRef}
            id="shorten-btn"
            type="submit"
            disabled={loading}
            onKeyDown={handleKeyActivateSubmit}
            class={`w-full border rounded-md px-4 py-4 font-semibold text-lg transition
              focus:outline-none focus:ring-2 focus:ring-black/60 focus:ring-offset-2
              cursor-pointer ${
                loading
                  ? "bg-neutral-300 text-neutral-500 cursor-progress"
                  : "bg-black text-white hover:bg-neutral-800 hover:shadow active:scale-[0.99]"
              }`}
            aria-busy={loading}
          >
            {loading ? "Shortening..." : "Shorten URL"}
          </button>
        </div>
      </form>
      <noscript class="mt-8 text-sm text-red-600">
        JavaScript is required for creating a short link.
      </noscript>
    </div>
  );
};

export default ShortenApp;
