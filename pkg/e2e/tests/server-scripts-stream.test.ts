/**
 * E2E for `data-bascik-stream` (prompts 65-68): a real browser must PAINT the
 * author's placeholder before the slow script resolves, over a real HTTP/1.1
 * chunked body and a real HTTP/2 DATA-frame sequence, and on the dev server.
 *
 * Fixtures:
 *   - src/pages/server-scripts-stream-test.html       one stream script (?delay=)
 *                                                      plus one server script (?second=)
 *   - src/components/stream-dashboard/                  layout with two stream cards
 *   - src/pages/server-scripts-dashboard-test.html      uses it (?sub= ?bill=)
 *
 * Runs under playwright.dev.config.ts, playwright.server.config.ts, and
 * playwright.server-http2.config.ts. Ignored under playwright.config.ts: the
 * static harness serves files and cannot execute server scripts, so it can
 * only fail for the wrong reason.
 *
 * Rules: data-testid via getByTestId only; no waitForTimeout. Ordering is
 * observed with waitUntil: 'commit' followed by locator expectations and
 * synchronous count() checks.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = fileURLToPath(new URL('..', import.meta.url));
const streamFixturePath = join(e2eDir, 'src/pages/server-scripts-stream-test.html');

const collectConsoleErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
};

const isDevServer = async (page: Page): Promise<boolean> => {
  const res = await page.request.get('/server-scripts-stream-test');
  return (await res.text()).includes('bascik-live-reload');
};

test.describe('data-bascik-stream: paint order in a real browser', () => {
  test('skeleton paints before the slow script resolves', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    const t0 = Date.now();
    await page.goto('/server-scripts-stream-test?delay=1500', { waitUntil: 'commit' });
    await expect(page.getByTestId('stream-skeleton')).toBeVisible();
    const tSkeleton = Date.now() - t0;
    expect(await page.getByTestId('stream-result').count()).toBe(0);

    await expect(page.getByTestId('stream-result')).toBeVisible();
    const tResult = Date.now() - t0;

    expect(tSkeleton).toBeLessThan(1000);
    expect(tResult).toBeGreaterThanOrEqual(1500);
    await expect(page.getByTestId('stream-second')).toHaveText('second');
    await expect(page.getByTestId('stream-footer')).toHaveText('footer');
    expect(consoleErrors).toHaveLength(0);
  });

  test('server script output on a mixed page gates the first byte and lands in source order', async ({ page }) => {
    // The `server` script resolved before commit, but its BYTES come after
    // the stream tag in source order, so while the skeleton is visible and
    // the stream result is absent, neither `second` nor the footer is in the
    // DOM yet.
    await page.goto('/server-scripts-stream-test?delay=1500', { waitUntil: 'commit' });
    await expect(page.getByTestId('stream-skeleton')).toBeVisible();
    expect(await page.getByTestId('stream-result').count()).toBe(0);
    expect(await page.getByTestId('stream-second').count()).toBe(0);
    expect(await page.getByTestId('stream-footer').count()).toBe(0);
    await expect(page.getByTestId('stream-result')).toBeVisible();
    await expect(page.getByTestId('stream-second')).toBeVisible();
    await expect(page.getByTestId('stream-footer')).toBeVisible();

    // A slow `server` script delays the FIRST chunk: commit waits for every
    // server job, so the skeleton cannot appear before the server delay.
    const t0 = Date.now();
    await page.goto('/server-scripts-stream-test?delay=0&second=800', { waitUntil: 'commit' });
    await expect(page.getByTestId('stream-skeleton')).toBeVisible();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
  });

  test('document order is preserved regardless of resolution order', async ({ page }) => {
    await page.goto('/server-scripts-stream-test?delay=300');
    await expect(page.getByTestId('stream-result')).toBeVisible();
    const text = await page.evaluate(() => document.body.innerText);
    const order = ['header', 'account loaded', 'second', 'footer'].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('data-bascik-server pages are still buffered; stream pages have no content-length', async ({ request }) => {
    const buffered = await request.get('/server-scripts-test');
    expect(buffered.status()).toBe(200);
    expect(buffered.headers()['content-length']).toBeDefined();

    const streamed = await request.get('/server-scripts-stream-test?delay=50');
    expect(streamed.status()).toBe(200);
    expect(streamed.headers()['content-length']).toBeUndefined();
    expect(streamed.headers()['cache-control']).toBe('private, no-store');
    expect(streamed.headers()['etag']).toBeUndefined();
    expect(streamed.headers()['content-encoding']).toBeUndefined();
  });

  test('fast path renders everything with delay=0', async ({ page }) => {
    await page.goto('/server-scripts-stream-test');
    for (const id of ['stream-header', 'stream-result', 'stream-second', 'stream-footer']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test('HEAD returns 200 with content-length and no body', async ({ request }) => {
    const res = await request.head('/server-scripts-stream-test?delay=300');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-length']).toBeDefined();
    expect((await res.body()).length).toBe(0);
  });

  test('navigating away mid-stream leaves the server healthy', async ({ page, request }) => {
    await page.goto('/server-scripts-stream-test?delay=3000', { waitUntil: 'commit' });
    await expect(page.getByTestId('stream-skeleton')).toBeVisible();
    await page.goto('/scope-test');
    await expect(page.locator('body')).toBeVisible();
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
  });
});

test.describe('data-bascik-stream: dashboard layout', () => {
  test('whole layout paints while two cards load, in visual position, with zero layout shift', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page);
    // Delays are long enough that browser cold-start cannot mask the order:
    // the shell must be visible while BOTH results are still absent. That
    // absence is the proof (a buffered response would deliver the results in
    // the same chunk as the shell); the elapsed time is recorded as evidence
    // only, since first-navigation cost varies by machine.
    // Raw TCP timeline for this URL (recorded while writing the test): chunk 1
    // (nav, usage, footer, subscription placeholder) at 7ms, the subscription
    // result PLUS the billing card at 2010ms, the billing result at 3209ms.
    // Source order is delivery order: the billing card sits after the
    // subscription script in source, so its placeholder cannot arrive before
    // that script resolves. The clock starts at response commit.
    await page.goto('/server-scripts-dashboard-test?sub=2000&bill=3200', { waitUntil: 'commit' });
    const tCommit = Date.now();
    for (const id of ['dash-footer', 'dash-nav', 'dash-usage', 'dash-sub-pending']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    const tShell = Date.now() - tCommit;
    expect(tShell).toBeLessThan(2000);
    expect(await page.getByTestId('dash-sub-result').count()).toBe(0);
    expect(await page.getByTestId('dash-bill').count()).toBe(0);

    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
    const before = { sub: await box('dash-sub'), usage: await box('dash-usage'), footer: await box('dash-footer') };
    // Visual order follows the author's grid (sub above usage above footer),
    // not source order (nav, usage, footer, sub).
    expect(before.sub.y).toBeLessThan(before.usage.y);
    expect(before.usage.y).toBeLessThan(before.footer.y);

    // First card fills; the second card (placeholder) arrives in the same
    // chunk and is still pending.
    await expect(page.getByTestId('dash-sub-result')).toBeVisible();
    await expect(page.getByTestId('dash-bill-pending')).toBeVisible();
    expect(await page.getByTestId('dash-bill-result').count()).toBe(0);
    // Author :has() rule hides the first placeholder (still in the DOM). This
    // is what proves the class in the returned markup was scoped to match the
    // component CSS; under identifier minification a mismatch would leave the
    // placeholder visible.
    await expect(page.getByTestId('dash-sub-pending')).toBeHidden();
    expect(await page.getByTestId('dash-sub-pending').count()).toBe(1);
    const billBox = await box('dash-bill');
    expect(before.usage.y).toBeLessThan(billBox.y);
    expect(billBox.y).toBeLessThan((await box('dash-footer')).y);

    await expect(page.getByTestId('dash-bill-result')).toBeVisible();
    await expect(page.getByTestId('dash-bill-pending')).toBeHidden();

    // Reserved boxes: the static blocks did not move when either result landed.
    const after = { usage: await box('dash-usage'), footer: await box('dash-footer') };
    expect(Math.abs(after.usage.y - before.usage.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.footer.y - before.footer.y)).toBeLessThanOrEqual(1);
    expect(consoleErrors).toHaveLength(0);
  });
});

test.describe('data-bascik-stream: dev server edit round-trip', () => {
  let original: string;

  test.beforeAll(async () => {
    original = await readFile(streamFixturePath, 'utf8');
  });

  test.afterEach(async () => {
    if ((await readFile(streamFixturePath, 'utf8')) !== original) {
      await writeFile(streamFixturePath, original, 'utf8');
    }
  });

  test('editing a stream script recomputes the plan and serves the new output', async ({ page }) => {
    test.skip(!(await isDevServer(page)), 'only the dev server re-stores pages on edit');
    await page.goto('/server-scripts-stream-test');
    await expect(page.getByTestId('stream-result')).toHaveText('account loaded');

    await writeFile(streamFixturePath, original.replace('account loaded', 'account reloaded'), 'utf8');

    // The live-reload client reloads the page when the transpile finishes.
    await expect(page.getByTestId('stream-result')).toHaveText('account reloaded', { timeout: 15000 });
  });
});
