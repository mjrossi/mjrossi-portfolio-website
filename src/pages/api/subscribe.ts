import type { APIRoute } from 'astro';
import {
  getEnv,
  parseJson,
  jsonError,
  jsonOk,
  methodNotAllowed,
  fetchWithRetry,
} from '../../lib/server';

type SubscribeBody = {
  email?: unknown;
  turnstileToken?: unknown;
  company?: unknown;
};

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

export const GET: APIRoute = () => methodNotAllowed('POST');

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // 8 KB cap — Turnstile tokens alone can be 2-4 KB; plus email (max 254),
  // honeypot, and JSON overhead. 1 KB would have rejected real submissions
  // (which is what was happening — verified empirically when production tokens
  // returned 413).
  const parsed = await parseJson<SubscribeBody>(request, { maxBytes: 8192 });
  if (!parsed.ok) return parsed.response;

  const { email, turnstileToken, company } = parsed.data;

  // Honeypot — real users can't see the field, bots fill anything. Silently
  // drop with a 200 so attackers can't tell the field exists.
  if (typeof company === 'string' && company.length > 0) {
    return jsonOk({ ok: true });
  }

  if (typeof email !== 'string' || email.length === 0 || email.length > MAX_EMAIL_LEN || !EMAIL_RX.test(email)) {
    return jsonError(400, 'invalid_email');
  }

  if (typeof turnstileToken !== 'string' || turnstileToken.length === 0) {
    return jsonError(400, 'missing_turnstile_token');
  }

  const env = getEnv();
  if (!env.TURNSTILE_SECRET_KEY) {
    console.error('subscribe: TURNSTILE_SECRET_KEY is empty on the worker');
    return jsonError(500, 'turnstile_secret_missing');
  }
  if (!env.BUTTONDOWN_API_KEY) {
    console.error('subscribe: BUTTONDOWN_API_KEY is empty on the worker');
    return jsonError(500, 'buttondown_key_missing');
  }

  try {
    const verify = await fetchWithRetry('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: turnstileToken,
        remoteip: clientAddress ?? '',
      }),
    });
    const result = (await verify.json()) as { success?: boolean };
    if (result.success !== true) return jsonError(401, 'turnstile_failed');
  } catch (err) {
    console.error('subscribe: turnstile verify threw', err);
    return jsonError(502, 'turnstile_unreachable');
  }

  // Buttondown's default behavior is double opt-in — the new subscriber gets
  // a confirmation email and isn't active on the list until they click through.
  let bd: Response;
  try {
    bd = await fetchWithRetry('https://api.buttondown.email/v1/subscribers', {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.BUTTONDOWN_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email_address: email, ip_address: clientAddress }),
    });
  } catch (err) {
    console.error('subscribe: buttondown fetch threw', err);
    return jsonError(502, 'upstream_unreachable');
  }

  if (bd.status === 201 || bd.status === 200) {
    return jsonOk({ ok: true });
  }

  // Treat duplicate as success — never confirm or deny that an address is
  // already subscribed (subscriber-enumeration defense).
  if (bd.status === 400) {
    let bodyText = '';
    try {
      bodyText = await bd.text();
    } catch {
      /* ignore */
    }
    if (/already.*subscribed|email_already_exists|already.*exists/i.test(bodyText)) {
      return jsonOk({ ok: true });
    }
    console.error('subscribe: buttondown 400', bodyText);
    return jsonError(400, 'upstream_rejected');
  }

  if (bd.status === 429) {
    return jsonError(429, 'rate_limited');
  }

  console.error('subscribe: buttondown returned', bd.status);
  return jsonError(502, 'upstream');
};
