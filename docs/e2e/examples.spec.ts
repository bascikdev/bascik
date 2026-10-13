// Browser tests for the repo-root examples:
//  - the docs site's example component pages, and add-example.mjs downloading /assets/examples.json from them
//  - a temporary copy of the starter site served with bascik --server, with the test page
//    e2e/fixtures/example-components.html added: two instances of every example component, tested pair by pair,
//    then the starter site's own behavior
import { test, expect, type Locator } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_URL, buildStarterSite, copyExamples, examplesDir, skillsDir, type Workspace } from '../scripts/example-fixtures.ts';

const fixturePage = fileURLToPath(new URL('./fixtures/example-components.html', import.meta.url));
const tabs = (scope: Locator) => scope.getByRole('tab');

test.describe('example component pages', () => {
  test('each component page shows a live preview and the exact component file', async ({ page }) => {
    await page.goto('/example-components/copy-button');
    const preview = page.getByTestId('demo-pane-preview');
    await expect(preview.getByRole('button', { name: 'Copy command' })).toBeVisible();
    await page.getByTestId('demo-tab-code').click();
    const source = readFileSync(join(examplesDir, 'components/copy-button/copy-button.html'), 'utf8');
    await expect(page.getByTestId('demo-pane-code')).toContainText(source.split('\n')[1]);
    await expect(page.getByTestId('demo-tab-output')).toBeHidden();
  });

  test('add-example.mjs downloads the published examples from the docs site', async ({ baseURL }) => {
    const project = mkdtempSync(join(tmpdir(), 'bascik-add-example-'));
    try {
      writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
      const run = (args: string[]) =>
        spawnSync(process.execPath, [join(skillsDir, 'bascik/scripts/add-example.mjs'), ...args], {
          cwd: project,
          encoding: 'utf8',
          env: { ...process.env, BASCIK_DOCS_URL: baseURL! },
          timeout: 30_000,
        });
      const listed = run(['--list']);
      expect(listed.status, listed.stderr).toBe(0);
      expect(listed.stdout).toContain(`${baseURL}/example-components/tab-group`);
      expect(listed.stdout).toContain('https://github.com/bascikdev/bascik/tree/main/examples/starter-site');
      const copied = run(['tab-group']);
      expect(copied.status, copied.stderr).toBe(0);
      expect(readFileSync(join(project, 'src/components/tab-group/tab-group.html'), 'utf8')).toBe(
        readFileSync(join(examplesDir, 'components/tab-group/tab-group.html'), 'utf8'),
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test.describe('built examples', () => {
  test.describe.configure({ mode: 'serial' });

  let ws: Workspace;
  let server: ChildProcess;
  let origin: string;
  let serverLog = '';

  async function freePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    return port;
  }

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ws = copyExamples();
    ws.write('starter-site/src/pages/example-components.html', readFileSync(fixturePage, 'utf8'));
    buildStarterSite(ws);
    const port = await freePort();
    origin = `http://localhost:${port}`;
    server = spawn(process.execPath, [join(ws.dir, 'node_modules/@bascik/bascik/bin/bascik.js'), '--server', '--port', String(port)], {
      cwd: join(ws.dir, 'starter-site'),
      env: { ...process.env, BASCIK_SITE_URL: SITE_URL, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => { serverLog += chunk; });
    server.stderr?.on('data', (chunk) => { serverLog += chunk; });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`bascik --server exited early:\n${serverLog}`);
      try {
        if ((await fetch(`${origin}/`)).ok) return;
      } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`bascik --server did not answer:\n${serverLog}`);
  });

  test.afterAll(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    }
    ws?.remove();
  });

  test.describe('two of every component on one page', () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`${origin}/example-components`);
    });

    test('tab groups switch independently and follow the arrow-key pattern', async ({ page }) => {
      const a = page.getByTestId('tabs-a');
      const b = page.getByTestId('tabs-b');
      await expect(tabs(a)).toHaveText(['Monthly', 'Yearly', 'Lifetime']);
      await expect(tabs(b)).toHaveText(['One', 'Two']);
      await expect(a.getByRole('tablist')).toHaveAccessibleName('Plans A');

      await tabs(a).nth(1).click();
      await expect(tabs(a).nth(1)).toHaveAttribute('aria-selected', 'true');
      await expect(a.getByText('A yearly')).toBeVisible();
      await expect(a.getByText('A monthly')).toBeHidden();
      await expect(b.getByText('B one')).toBeVisible();

      await page.keyboard.press('ArrowRight');
      await expect(tabs(a).nth(2)).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(tabs(a).nth(0)).toBeFocused();
      await page.keyboard.press('End');
      await expect(tabs(a).nth(2)).toHaveAttribute('aria-selected', 'true');
      await expect(a.getByRole('tabpanel')).toHaveAccessibleName('Lifetime');

      const ids = await page.getByRole('tab').evaluateAll((elements) => elements.map((element) => element.id));
      expect(new Set(ids).size).toBe(ids.length);
    });

    test('modal dialogs open from their own trigger, close with Escape, and return focus', async ({ page }) => {
      const trigger = page.getByTestId('dialog-b').getByRole('button', { name: 'Open B' });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Dialog B' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Body B')).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Dialog A' })).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test('popover menus open only their own panel', async ({ page }) => {
      await page.getByTestId('menu-a').getByRole('button', { name: 'Menu A' }).click();
      await expect(page.getByRole('link', { name: 'About A' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Blog B' })).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('link', { name: 'About A' })).toBeHidden();
    });

    test('copy buttons copy their own text and announce the result', async ({ page, context, browserName }) => {
      test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only in Playwright');
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await page.getByTestId('copy-b').getByRole('button', { name: 'Copy B' }).click();
      await expect(page.getByTestId('copy-b').getByRole('status')).toHaveText('Copied');
      await expect(page.getByTestId('copy-a').getByRole('status')).toHaveText('');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('beta text');
    });

    test('filter lists filter only their own items', async ({ page }) => {
      const a = page.getByTestId('filter-a');
      const b = page.getByTestId('filter-b');
      await a.getByLabel('Filter A').fill('an');
      await expect(a.getByRole('listitem').filter({ visible: true })).toHaveText(['Banana']);
      await expect(a.getByText('1 of 3 shown')).toBeVisible();
      await expect(b.getByRole('listitem').filter({ visible: true })).toHaveText(['Red', 'Green']);
    });

    test('contact forms validate, then post JSON with literal field names to the API route', async ({ page }) => {
      const form = page.getByTestId('form-b');
      await form.getByRole('button', { name: 'Send' }).click();
      await expect(form.getByLabel('Name')).toBeFocused();

      await form.getByLabel('Name').fill('Ada');
      await form.getByLabel('Email').fill('ada@example.com');
      await form.getByLabel('Message').fill('Hello from the example components test.');
      const [request] = await Promise.all([
        page.waitForRequest((r) => r.url().endsWith('/api/contact') && r.method() === 'POST'),
        form.getByRole('button', { name: 'Send' }).click(),
      ]);
      expect(request.postDataJSON()).toEqual({ name: 'Ada', email: 'ada@example.com', message: 'Hello from the example components test.' });
      expect((await request.response())?.status()).toBe(201);
      await expect(form.getByRole('status')).toHaveText('Thanks. Your message was sent.');
      await expect(page.getByTestId('form-a').getByRole('status')).toHaveText('');
    });

    test('site headers and footers take their own props and slot, and share the build-time links', async ({ page }) => {
      const b = page.getByTestId('header-b');
      await expect(b.getByRole('link', { name: 'Second Site' })).toHaveAttribute('href', '/');
      await expect(b.getByText('Header B slot')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Example Site' })).toHaveCount(1);
      for (const nav of await page.getByRole('navigation', { name: 'Site' }).all()) {
        await expect(nav.getByRole('link')).toHaveText(['Home', 'About', 'Blog', 'Contact']);
        // This test page is not in links.ts, so no link is current.
        await expect(nav.locator('[aria-current]')).toHaveCount(0);
      }

      const year = String(new Date().getFullYear());
      await expect(page.getByTestId('footer-b').getByText(`${year} Second Holder`)).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Footer' })).toHaveCount(2);
      await expect(page.getByRole('navigation', { name: 'Footer' }).first().getByRole('link')).toHaveText(['About', 'Blog', 'Feed', 'Contact']);
    });

    test('theme toggles switch the page theme and stay in sync with each other', async ({ page }) => {
      const a = page.getByTestId('theme-a').getByRole('button', { name: 'Dark theme' });
      const b = page.getByTestId('theme-b').getByRole('button', { name: 'Dark theme' });
      await expect(a).toHaveAttribute('aria-pressed', 'false');
      await a.click();
      await expect(a).toHaveAttribute('aria-pressed', 'true');
      await expect(b).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    });
  });

  test.describe('starter site', () => {
    test('the contact page posts to the real API route', async ({ page }) => {
      await page.goto(`${origin}/contact`);
      await page.getByLabel('Name').fill('Ada');
      await page.getByLabel('Email').fill('ada@example.com');
      await page.getByLabel('Message').fill('Hello from the starter site test.');
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().endsWith('/api/contact')),
        page.getByRole('button', { name: 'Send' }).click(),
      ]);
      expect(response.status()).toBe(201);
      await expect(page.getByRole('status')).toHaveText('Thanks. Your message was sent.');
    });

    test('the theme choice survives a reload with no flash', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(`${origin}/`);
      const toggle = page.getByRole('button', { name: 'Dark theme' });
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await toggle.click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.reload();
      // theme-init runs in <head>, so the attribute is set before the toggle's script runs at the end of the body.
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(page.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(18, 19, 22)');
    });

    test('navigation marks the current page, the skip link reaches main, and unknown URLs get the 404 page', async ({ page }) => {
      await page.goto(`${origin}/about`);
      const nav = page.getByRole('navigation', { name: 'Site' });
      await expect(nav.getByRole('link', { name: 'About' })).toHaveAttribute('aria-current', 'page');
      await expect(nav.locator('[aria-current]')).toHaveCount(1);
      await page.goto(`${origin}/blog/hello-world/`);
      await expect(nav.getByRole('link', { name: 'Blog' })).toHaveAttribute('aria-current', 'true');
      await page.goto(`${origin}/about`);
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: 'Skip to content' });
      await expect(skip).toBeFocused();
      await skip.press('Enter');
      await expect(page).toHaveURL(/#main$/);

      const response = await page.goto(`${origin}/no-such-page`);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    });
  });
});
