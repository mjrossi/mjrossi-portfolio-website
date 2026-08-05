import { env } from 'cloudflare:workers';

// Shared plumbing for /api/* endpoints. The pattern:
//   1. import { securityHeaders, getEnv, parseJson, jsonError, jsonOk } from '../../lib/server'
//   2. handler returns Responses constructed via the helpers so headers stay consistent
//
// Env access goes through `cloudflare:workers` (Astro v6 + @astrojs/cloudflare
// 13 removed the old `Astro.locals.runtime.env` path; the adapter installs a
// getter on that path that throws an explicit migration error).

export const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

// Single seam for runtime env. Kept as a wrapper rather than re-exporting
// `env` directly so the `as Env` cast lives in one place and we can swap to
// `astro:env/server` (typed, schema-validated) later without touching callers.
export function getEnv(): Env {
  return env as Env;
}

// The fail-closed read. `cloudflare:workers` throws when touched outside the
// worker runtime — during a prerender, or under a test harness — and several
// callers would rather treat that as "no bindings" than 500 the route.
//
// It lives here rather than as a try/catch at each call site so the decision to
// swallow that error is made once, in the module documented as the single seam
// for runtime env. src/middleware.ts reads it once per request and passes the
// individual bindings down; nothing in this codebase should be catching around
// `getEnv()` itself.
export function tryGetEnv(): Env | null {
  try {
    return getEnv();
  } catch {
    return null;
  }
}

/**
 * Refuse a request without reading its body, releasing the body first.
 *
 * Every early return from a POST handler is one of these: a 403 decided from
 * the token, a 415 decided from a header, a 413 decided from Content-Length.
 * None of them needs the bytes, and on production Cloudflare abandoning them
 * costs nothing.
 *
 * `wrangler dev` is where it costs something. Its ProxyWorker sits between the
 * client and the Worker, and an unread request body leaves that hop holding a
 * stream nobody will drain; after enough of them the connection is torn down
 * with "Network connection lost.", wrangler's ProxyController treats that as
 * fatal, and the whole dev server exits. Measured against `/api/galley`: 29
 * unauthorised POSTs killed it, while 400 GETs and 400 POSTs whose body IS
 * parsed left it healthy. That is a local-dev and CI failure, not a production
 * one -- but it takes out `just preview` for anyone whose review link has been
 * revoked, and it was the cause of the galley branch's CI flake.
 *
 * DRAINING, not cancelling, and the difference is the whole fix. Reading bytes
 * we have already decided to ignore looks like the wasteful option, and
 * `request.body.cancel()` looks like the tidy one — but cancelling does not
 * release the proxy hop. Measured on the same probe: with `cancel()` the dev
 * server still died, at request 20 of 400; with `arrayBuffer()` all 400 went
 * through and it stayed up. Don't "optimise" this back to a cancel.
 *
 * Not used by parseJson's 413, which is the one refusal that is ABOUT the body
 * being too big — draining it there would spend exactly what the check exists
 * to refuse to spend. That path keeps the dev-proxy cost knowingly; no client
 * hits it in a loop.
 *
 * Errors are swallowed because every one of them means the body is already
 * gone, which is the desired state.
 */
export async function refuse(request: Request, response: Response): Promise<Response> {
  try {
    await request.arrayBuffer();
  } catch {
    // Already consumed, already errored, or never there. Nothing to release.
  }
  return response;
}

type ParseJsonOk<T> = { ok: true; data: T };
type ParseJsonErr = { ok: false; response: Response };
export type ParseJsonResult<T> = ParseJsonOk<T> | ParseJsonErr;

export async function parseJson<T>(
  request: Request,
  opts: { maxBytes?: number } = {},
): Promise<ParseJsonResult<T>> {
  const maxBytes = opts.maxBytes ?? 1024;
  const ctype = request.headers.get('content-type') || '';
  if (!ctype.toLowerCase().includes('application/json')) {
    return { ok: false, response: await refuse(request, jsonError(415, 'unsupported_media_type')) };
  }
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > maxBytes) {
    // Deliberately NOT drained — see refuse().
    return { ok: false, response: jsonError(413, 'payload_too_large') };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: jsonError(400, 'body_read_failed') };
  }
  if (text.length > maxBytes) {
    return { ok: false, response: jsonError(413, 'payload_too_large') };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, response: jsonError(400, 'invalid_json') };
  }
}

export function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { ...securityHeaders, 'Content-Type': 'application/json' },
  });
}

export function jsonOk(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...securityHeaders, 'Content-Type': 'application/json' },
  });
}

export function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { ...securityHeaders, Allow: allow, 'Content-Type': 'application/json' },
  });
}

// Retry-with-backoff wrapper around fetch. Retries on transient failures
// (network errors and 5xx responses); does NOT retry on 4xx (those are
// deterministic client errors). Default budget: 3 total attempts (initial +
// 2 retries) with 250ms, 500ms exponential backoff — adds at most ~750ms
// to the rare path that genuinely needs retries; zero cost on the happy
// path.
//
// Used by /api/subscribe for the two upstream calls (Turnstile siteverify,
// Buttondown create-subscriber) where occasional 503s have been observed.
export async function fetchWithRetry(
  input: RequestInfo,
  init: RequestInit,
  opts: { retries?: number; baseMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 250;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init);
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
