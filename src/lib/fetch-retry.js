// fetch with retries, for /api/subscribe's two upstream calls (Turnstile
// siteverify, Buttondown create-subscriber), where occasional 503s have been
// observed. Plain JS so `node --test` can reach it; src/lib/server.ts imports
// `cloudflare:workers` and cannot be loaded outside the worker.
//
// Retries network errors, timeouts and 5xx; never 4xx, which are deterministic.
// Default budget: 3 attempts with 250ms, 500ms backoff.
//
// A retry re-sends the same request, so it is only safe for a call that is
// idempotent or made so. siteverify is not by default — a Turnstile token is
// single-use, and a retry after the first attempt consumed it fails with
// `timeout-or-duplicate` — which is why the caller passes `idempotency_key`.

/**
 * @param {RequestInfo} input
 * @param {RequestInit} init reused unchanged for every attempt
 * @param {{ retries?: number, baseMs?: number, timeoutMs?: number,
 *           fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(input, init, opts = {}) {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 250;
  // Per attempt, so one slow attempt cannot spend the others' time.
  const timeoutMs = opts.timeoutMs ?? 4000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error('fetchWithRetry: exhausted');
}
