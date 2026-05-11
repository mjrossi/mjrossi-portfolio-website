import type { APIContext } from 'astro';

// Shared plumbing for /api/* endpoints. The pattern:
//   1. import { securityHeaders, getEnv, parseJson, jsonError, jsonOk } from '../../lib/server'
//   2. handler returns Responses constructed via the helpers so headers stay consistent
//
// All endpoints under src/pages/api/* are on-demand (export const prerender = false);
// these helpers assume the Cloudflare runtime is available on locals.

export const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

export function getEnv(locals: APIContext['locals']): Env {
  const runtime = (locals as App.Locals).runtime;
  if (!runtime?.env) {
    throw new Error('Cloudflare runtime env not available — is this route on-demand?');
  }
  return runtime.env;
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
