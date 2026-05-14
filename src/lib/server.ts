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
    return { ok: false, response: jsonError(415, 'unsupported_media_type') };
  }
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > maxBytes) {
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
