// Unit tests for fetchWithRetry. Run via `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from './fetch-retry.js';

/** A fetch that answers from a script and records every call. */
function scripted(...steps) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    const step = steps[calls.length - 1];
    if (step instanceof Error) throw step;
    if (step === 'hang') {
      return new Promise((_, reject) => {
        // AbortSignal.timeout's timer is unref'd in Node; hold the loop open
        // until it fires, as the worker's in-flight request would.
        const keepAlive = setTimeout(() => {}, 10_000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        });
      });
    }
    return new Response(null, { status: step });
  };
  return { fetchImpl, calls };
}

const fast = { baseMs: 0 };

test('a 2xx is returned on the first attempt', async () => {
  const { fetchImpl, calls } = scripted(200);
  const res = await fetchWithRetry('https://x/', {}, { ...fast, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test('a 5xx is retried, and the last response is returned once retries run out', async () => {
  const { fetchImpl, calls } = scripted(503, 503, 503);
  const res = await fetchWithRetry('https://x/', {}, { ...fast, fetchImpl });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 3);
});

test('a 4xx is not retried', async () => {
  const { fetchImpl, calls } = scripted(400, 200);
  const res = await fetchWithRetry('https://x/', {}, { ...fast, fetchImpl });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 1);
});

test('a network error is retried, and rethrown once retries run out', async () => {
  const boom = new TypeError('network');
  const ok = scripted(boom, 200);
  assert.equal((await fetchWithRetry('https://x/', {}, { ...fast, fetchImpl: ok.fetchImpl })).status, 200);

  const dead = scripted(boom, boom, boom);
  await assert.rejects(fetchWithRetry('https://x/', {}, { ...fast, fetchImpl: dead.fetchImpl }), boom);
  assert.equal(dead.calls.length, 3);
});

test('every attempt sends the same body, so an idempotency key in it is reused', async () => {
  // The siteverify fix rests on this: the key is generated once by the caller
  // and must reach Cloudflare unchanged on the retry.
  const body = new URLSearchParams({ response: 'tok', idempotency_key: 'k-1' });
  const { fetchImpl, calls } = scripted(503, 200);
  await fetchWithRetry('https://x/', { method: 'POST', body }, { ...fast, fetchImpl });
  assert.equal(calls.length, 2);
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(new URLSearchParams(init.body.toString()).get('idempotency_key'), 'k-1');
  }
});

test('an attempt that hangs is aborted and retried', async () => {
  const { fetchImpl, calls } = scripted('hang', 200);
  const res = await fetchWithRetry('https://x/', {}, { ...fast, timeoutMs: 20, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  // Each attempt gets its own signal; a shared one would already be aborted.
  assert.notEqual(calls[0].init.signal, calls[1].init.signal);
});
