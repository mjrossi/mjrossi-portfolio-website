import { env } from 'cloudflare:workers';

// Shared plumbing for /api/* endpoints: headers, env access, JSON parsing and
// error responses. Env comes from `cloudflare:workers`; the old
// `Astro.locals.runtime.env` path throws under @astrojs/cloudflare 13+.

export const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

// The one place the `as Env` cast lives.
export function getEnv(): Env {
  return env as Env;
}

// The fail-closed read: `cloudflare:workers` throws outside the worker runtime
// (prerender, tests), and callers would rather see "no bindings" than a 500.
// Swallowing that belongs here, not in a try/catch at each call site.
export function tryGetEnv(): Env | null {
  try {
    return getEnv();
  } catch {
    return null;
  }
}

/**
 * Refuse a request, draining its body first.
 *
 * Free on production Cloudflare, but under `wrangler dev` an unread body leaves
 * the proxy hop holding a stream until the dev server dies ("Network connection
 * lost."). Measured on /api/galley: 29 unauthorised POSTs killed it.
 *
 * DRAIN, DON'T CANCEL. `request.body.cancel()` looks tidier and does not
 * release the hop — on the same probe it still died at request 20 of 400, where
 * `arrayBuffer()` survived all 400.
 *
 * Not used by parseJson's 413: draining an oversize body would spend exactly
 * what that check refuses to spend.
 */
export async function refuse(request: Request, response: Response): Promise<Response> {
  try {
    await request.arrayBuffer();
  } catch {
    // Already consumed or never there: nothing to release.
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
    // Not drained — see refuse().
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

// Lives in plain JS so `node --test` can reach it; see src/lib/fetch-retry.js.
export { fetchWithRetry } from './fetch-retry.js';
