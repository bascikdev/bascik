import { test, expect } from '@playwright/test';

test.describe('API routes core functionality', () => {
  test('GET /api/health returns JSON response with context.remoteIp', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe('healthy');
    expect(data.remoteIp).toBeDefined();
  });

  test('POST /api/contact receives JSON payload and returns custom 201 status', async ({ request }) => {
    const res = await request.post('/api/contact', {
      data: { name: 'Bascik Developer' },
    });
    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.received.name).toBe('Bascik Developer');
  });

  test('POST /api/contact returns 400 when required payload is missing', async ({ request }) => {
    const res = await request.post('/api/contact', {
      data: {},
    });
    expect(res.status()).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('name is required');
  });

  test('Unexported method returns 405 with accurate Allow header', async ({ request }) => {
    const res = await request.delete('/api/contact');
    expect(res.status()).toBe(405);
    const allow = res.headers()['allow'];
    expect(allow).toContain('POST');
    expect(allow).toContain('OPTIONS');
  });

  test('HEAD request derives from GET with matching headers and empty body', async ({ request }) => {
    const res = await request.head('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toBe('');
  });

  test('OPTIONS request auto-responds 204 with Allow and no CORS headers', async ({ request }) => {
    const res = await request.fetch('/api/contact', {
      method: 'OPTIONS',
    });
    expect(res.status()).toBe(204);
    expect(res.headers()['allow']).toContain('POST');
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('GET /api/users/[id] extracts dynamic route parameter', async ({ request }) => {
    const res = await request.get('/api/users/user-12345');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.userId).toBe('user-12345');
  });

  test('Preserves multiple set-cookie headers across response', async ({ request }) => {
    const res = await request.get('/api/cookies');
    expect(res.status()).toBe(200);
    const headers = res.headersArray();
    const setCookies = headers.filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookies.length).toBe(2);
    expect(setCookies.some((c) => c.value.includes('session=abc123'))).toBe(true);
    expect(setCookies.some((c) => c.value.includes('theme=dark'))).toBe(true);
  });

  test('Streams ReadableStream body to client', async ({ request }) => {
    const res = await request.get('/api/stream');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toBe('part1-part2');
  });

  test('413 on oversized body and handler side effect did not occur', async ({ request }) => {
    // 1 MB limit by default: send 2 MB of data
    const oversizedBody = 'A'.repeat(2 * 1024 * 1024);
    const res = await request.post('/api/body-limit', {
      data: oversizedBody,
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.status()).toBe(413);

    // Verify side effect did not run
    const checkRes = await request.get('/api/body-limit');
    expect(checkRes.status()).toBe(200);
    const checkData = await checkRes.json();
    expect(checkData.sideEffect).toBe(false);
  });

  test('504 Gateway Timeout on hung handler and propagates AbortSignal without leaking internals', async ({ request }) => {
    // 1. Send request to hung handler - must stay pending until Bascik times out and aborts it
    const res = await request.get('/api/timeout');
    expect(res.status()).toBe(504);

    // 2. Response body should be standard Gateway Timeout with no internal stack or secrets leaked
    const body = await res.text();
    expect(body).toBe('Gateway Timeout');
    expect(body).not.toContain('node_modules');
    expect(body).not.toContain('Error:');

    // 3. The handler observed the AbortSignal through a deterministic effect
    const checkAbortRes = await request.post('/api/timeout');
    expect(checkAbortRes.status()).toBe(200);
    const checkAbortData = await checkAbortRes.json();
    expect(checkAbortData.aborted).toBe(true);
    expect(checkAbortData.reason).toContain('timed out');

    // 4. Subsequent request after timeout still succeeds (server remains healthy)
    const healthRes = await request.get('/api/health');
    expect(healthRes.status()).toBe(200);
    const healthData = await healthRes.json();
    expect(healthData.ok).toBe(true);
    expect(healthData.status).toBe('healthy');
  });

  test('500 Internal Server Error hides stack trace and secrets from response body', async ({ request }) => {
    const res = await request.get('/api/fault');
    expect(res.status()).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('SECRET_INTERNAL_DB_PASSWORD_MARKER_98765');
    expect(body).not.toContain('/api/fault');
    expect(body).toBe('Internal Server Error');
  });

  test('Blocks encoded path traversal (%2e%2e%2f)', async ({ request }) => {
    const res = await request.get('/api/%2e%2e%2fadmin');
    expect(res.status()).toBe(400);
  });

  test('Blocks dot-path access to hidden files', async ({ request }) => {
    const res = await request.get('/api/.hidden');
    expect(res.status()).toBe(404);
  });

  test('GET /api/request-origin reconstructs scheme and authority conforming to protocol', async ({ request }) => {
    const res = await request.get('/api/request-origin');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.url).toMatch(/^https?:\/\/[^/]+\/api\/request-origin$/);
    expect(['http:', 'https:']).toContain(data.protocol);
    expect(data.origin).toMatch(/^https?:\/\//);
    expect(data.host).toBeTruthy();
  });
});

test.describe('API catch-all routes ([...path])', () => {
  test('captures one remaining segment as a one element array', async ({ request }) => {
    const res = await request.get('/api/files/readme.txt');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.route).toBe('catch-all');
    expect(data.segments).toEqual(['readme.txt']);
  });

  test('captures many remaining segments preserving boundaries, ignoring the query string', async ({ request }) => {
    const res = await request.get('/api/files/reports/2026/q1.pdf?download=1');
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.segments).toEqual(['reports', '2026', 'q1.pdf']);
  });

  test('ignores one trailing slash', async ({ request }) => {
    const res = await request.get('/api/files/a/b/');
    expect(res.status()).toBe(200);
    expect((await res.json()).segments).toEqual(['a', 'b']);
  });

  test('decodes each segment exactly once', async ({ request }) => {
    const res = await request.get('/api/files/hello%20world/caf%C3%A9/%2541');
    expect(res.status()).toBe(200);
    expect((await res.json()).segments).toEqual(['hello world', 'café', '%41']);
  });

  test('static route beats the catch-all', async ({ request }) => {
    const res = await request.get('/api/files/latest');
    expect(res.status()).toBe(200);
    expect((await res.json()).route).toBe('static');
  });

  test('[param] route beats the catch-all for exactly one segment, catch-all takes deeper paths', async ({ request }) => {
    const param = await request.get('/api/files/v/2');
    expect((await param.json())).toEqual({ route: 'param', version: '2' });

    const deeper = await request.get('/api/files/v/2/extra');
    expect(deeper.status()).toBe(200);
    const data = await deeper.json();
    expect(data.route).toBe('catch-all');
    expect(data.segments).toEqual(['v', '2', 'extra']);
  });

  test('zero remaining segments goes to the index route, not the catch-all', async ({ request }) => {
    const res = await request.get('/api/files');
    expect(res.status()).toBe(200);
    expect((await res.json()).route).toBe('index');
  });

  test('POST dispatches with the captured segments', async ({ request }) => {
    const res = await request.post('/api/files/up/load', { data: 'payload', headers: { 'content-type': 'text/plain' } });
    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.segments).toEqual(['up', 'load']);
    expect(data.echoed).toBe('payload');
  });

  test('unsupported method returns 405 with Allow, OPTIONS and HEAD keep their behavior', async ({ request }) => {
    const put = await request.put('/api/files/a/b');
    expect(put.status()).toBe(405);
    expect(put.headers()['allow']).toBe('GET, HEAD, OPTIONS, POST');

    const options = await request.fetch('/api/files/a/b', { method: 'OPTIONS' });
    expect(options.status()).toBe(204);
    expect(options.headers()['allow']).toBe('GET, HEAD, OPTIONS, POST');
    expect(options.headers()['access-control-allow-origin']).toBeUndefined();

    const head = await request.head('/api/files/a/b');
    expect(head.status()).toBe(200);
    expect(await head.text()).toBe('');
  });

  for (const unsafe of ['/api/files/a%2Fb', '/api/files/a%2fb', '/api/files/a%5Cb', '/api/files/%E0%A4%A', '/api/files/a%00b', '/api/files/a//b']) {
    test(`rejects ${unsafe} with 400 and never runs the handler`, async ({ request }) => {
      const res = await request.get(unsafe);
      expect(res.status()).toBe(400);
      expect(await res.text()).not.toContain('segments');
    });
  }

  test('hidden segments under a catch-all are 404', async ({ request }) => {
    const res = await request.get('/api/files/a/.env');
    expect(res.status()).toBe(404);
  });
});
