import { useState } from "hono/jsx";

export default function App() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [shortUrl, setShortUrl] = useState("");
  const [baseUrl] = useState(() => location.origin + "/");

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const urlInput = form.querySelector<HTMLInputElement>("#url")!;
    const codeInput = form.querySelector<HTMLInputElement>("#code")!;
    const url = urlInput.value.trim();
    const code = codeInput.value.trim();

    if (!url) {
      setMessage("Please enter a valid URL");
      return;
    }

    setLoading(true);
    setMessage("");
    setShortUrl("");
    try {
      const res = await fetch("/api/shorten", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, shortCodeInput: code || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Failed to shorten URL");
      } else {
        const path = `/${data.shortCode}`;
        const full = `${location.origin}${path}`;
        setShortUrl(full);
        setMessage("Short URL created successfully");
      }
    } catch (err) {
      setMessage("Network error");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!shortUrl) return;
    try {
      await navigator.clipboard.writeText(shortUrl);
      setMessage("Copied to clipboard");
    } catch {
      setMessage("Copy failed");
    }
  };

  return (
    <div class="space-y-4">
      <form id="shorten-form" class="space-y-3" onSubmit={onSubmit} novalidate>
        <div class="space-y-1">
          <label for="url" class="block text-sm font-medium">
            Long URL
          </label>
          <input
            id="url"
            name="url"
            type="url"
            required
            placeholder="https://example.com"
            class="w-full rounded border px-3 py-2"
          />
        </div>
        <div class="space-y-1">
          <label for="code" class="block text-sm font-medium">
            Custom code (optional)
          </label>
          <p class="text-xs text-gray-600">Base: <span aria-label="base-url">{baseUrl}</span></p>
          <input
            id="code"
            name="code"
            type="text"
            placeholder="my-alias"
            class="w-full rounded border px-3 py-2"
          />
        </div>
        <button
          type="submit"
          class="rounded bg-black px-4 py-2 text-white transition-colors hover:bg-gray-800"
          disabled={loading}
        >
          {loading ? "Shortening…" : "Shorten"}
        </button>
      </form>
      <div id="result" class="text-sm">
        {message && <p aria-live="polite">{message}</p>}
        {shortUrl && (
          <div class="flex items-center gap-2">
            <span>Short URL:</span>
            <a class="text-blue-600 underline" href={shortUrl}>
              {shortUrl}
            </a>
            <button
              type="button"
              onClick={copy}
              class="rounded border px-2 py-1 transition-colors hover:bg-gray-100"
              aria-label="Copy shortened URL"
            >
              Copy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
