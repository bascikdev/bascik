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
});
