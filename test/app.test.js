import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { NotFoundError, UpstreamError } from '../src/lib/errors.js';
import { silentLogger } from './fixtures.js';

/** Start the app on an ephemeral port and return its base URL. */
async function startServer(assistant, options = {}) {
  const app = createApp({ assistant, aiEnabled: true, logger: silentLogger, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, body, raw) =>
  fetch(`${base}/api/advice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });

describe('HTTP API', () => {
  let ctx;
  let lastInput;
  const assistant = {
    async advise(input) {
      lastInput = input;
      if (input.city === 'Atlantis') throw new NotFoundError('No such place');
      if (input.city === 'Outage') throw new UpstreamError();
      if (input.city === 'Crash') throw new Error('secret internal detail');
      return { source: 'gemini', plan: { summary: 'ok' } };
    },
  };

  before(async () => {
    ctx = await startServer(assistant);
  });
  after(() => ctx.server.close());

  it('serves the health check', async () => {
    const res = await fetch(`${ctx.base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });

  it('serves the accessible front end with security headers', async () => {
    const res = await fetch(`${ctx.base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /Skip to main content/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  it('exposes metadata', async () => {
    const res = await fetch(`${ctx.base}/api/meta`);
    const body = await res.json();
    assert.equal(body.aiEnabled, true);
    assert.ok(body.options.commuteMode.includes('metro'));
  });

  it('returns advice for a valid request', async () => {
    const res = await post(ctx.base, { city: 'Delhi', commuteMode: 'metro', commuteKm: 8 });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).source, 'gemini');
    assert.equal(lastInput.commuteMode, 'metro');
  });

  it('rejects invalid input with details', async () => {
    const res = await post(ctx.base, { city: '<script>' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error, 'Invalid request');
    assert.ok(body.details.length > 0);
  });

  it('rejects malformed and oversized JSON', async () => {
    assert.equal((await post(ctx.base, null, '{bad json')).status, 400);
    assert.equal((await post(ctx.base, { city: 'Delhi', pad: 'x'.repeat(20_000) })).status, 413);
  });

  it('maps domain errors to safe status codes', async () => {
    assert.equal((await post(ctx.base, { city: 'Atlantis' })).status, 404);
    assert.equal((await post(ctx.base, { city: 'Outage' })).status, 502);
    const crash = await post(ctx.base, { city: 'Crash' });
    assert.equal(crash.status, 500);
    assert.doesNotMatch(await crash.text(), /secret internal detail/);
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await fetch(`${ctx.base}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  });
});

describe('rate limiting', () => {
  it('limits bursts of API requests', async () => {
    const { server, base } = await startServer({ advise: async () => ({}) }, { rateLimitPerMinute: 2 });
    try {
      const statuses = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await fetch(`${base}/api/meta`)).status);
      assert.deepEqual(statuses, [200, 200, 429]);
    } finally {
      server.close();
    }
  });
});
