/** Real dev server coverage for source-owned phase cycles. */
import { test, expect } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = fileURLToPath(new URL('../exec-fixture/', import.meta.url));
const docPath = join(fixtureDir, 'content/doc.md');
const logPath = join(fixtureDir, '.dev-server.log');
const readLog = () => readFile(logPath, 'utf8');
const readGeneration = async () => Number(await readFile(join(fixtureDir, 'dist/.generation'), 'utf8'));
const consumerTranspiled = /transpiled: pages\/consumer\.html/;
const unrelatedTranspiled = /transpiled: pages\/unrelated\.html/;

test.describe('source-owned exec lifecycle', () => {
  test('(gated) overlapping source watches compile once only after pre exits', async ({ page }) => {
    const original = await readFile(docPath, 'utf8');
    const armedGate = join(fixtureDir, 'scripts/.armed-gate');
    const before = await readGeneration();
    try {
      await page.goto('/consumer');
      await writeFile(armedGate, 'armed');
      const offset = (await readLog()).length;
      await writeFile(docPath, original + '\nGated output test\n');
      await expect.poll(() => fetch('http://127.0.0.1:9777/held').then(r => r.status).catch(() => 0)).toBe(404);
      await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before}\\s*`));
      expect((await readLog()).slice(offset)).not.toMatch(consumerTranspiled);
      expect((await readLog()).slice(offset)).not.toContain('(completed) exec: scripts/generator.mjs');
      const releaseOffset = (await readLog()).length;
      await fetch('http://127.0.0.1:9777/release');
      await expect.poll(async () => (await readLog()).slice(releaseOffset)).toContain('(completed) exec: scripts/generator.mjs');
      await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before + 1}\\s*`));
      expect((await readLog()).slice(offset).match(new RegExp(consumerTranspiled, 'g'))).toHaveLength(1);
    } finally {
      await rm(armedGate, { force: true });
      await fetch('http://127.0.0.1:9777/release').catch(() => undefined);
      const offset = (await readLog()).length;
      await writeFile(docPath, original);
      await expect.poll(async () => (await readLog()).slice(offset)).toMatch(consumerTranspiled);
    }
  });

  test('parallel completion does not rebuild, but a later watched source edit does', async ({ page }) => {
    expect(await fetch('http://127.0.0.1:9778/status').then(r => r.json())).toMatchObject({ running: true });
    expect(await readGeneration()).toBe(1);
    await page.goto('/consumer');
    await expect(page.getByTestId('generated-value')).toHaveText(/generation-1\s*/);
    await expect(page.getByTestId('parallel-value')).toHaveText(/missing\s*/);

    const offset = (await readLog()).length;
    await fetch('http://127.0.0.1:9778/release');
    await expect.poll(async () => (await readLog()).slice(offset)).toContain('(completed) exec: scripts/parallel-generator.mjs');
    await page.goto('/consumer');
    await expect(page.getByTestId('parallel-value')).toHaveText(/missing\s*/);
    expect((await readLog()).slice(offset)).not.toMatch(consumerTranspiled);

    const source = join(fixtureDir, 'src/pages/consumer.html');
    const original = await readFile(source, 'utf8');
    try {
      await writeFile(source, original + '\n<!-- normal watched edit -->\n');
      await expect(page.getByTestId('parallel-value')).toHaveText(/parallel-\d+\s*/);
    } finally {
      const restoreOffset = (await readLog()).length;
      await writeFile(source, original);
      await expect.poll(async () => (await readLog()).slice(restoreOffset)).toMatch(consumerTranspiled);
    }
  });

  test('a watched source rebuilds its consumer without watching generated output', async ({ page }) => {
    const original = await readFile(docPath, 'utf8');
    const before = await readGeneration();
    const offset = (await readLog()).length;
    try {
      await page.goto('/consumer');
      await writeFile(docPath, original + '\nGenerated output watch test\n');
      await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before + 1}\\s*`));
      expect(await readGeneration()).toBe(before + 1);
      expect(JSON.parse(await readFile(join(fixtureDir, 'dist/post.json'), 'utf8')).value).toBe(`generation-${before + 1}`);
      expect((await readLog()).slice(offset)).toMatch(consumerTranspiled);
      expect((await readLog()).slice(offset)).not.toMatch(unrelatedTranspiled);
    } finally {
      const restoreOffset = (await readLog()).length;
      await writeFile(docPath, original);
      await expect.poll(readGeneration).toBe(before + 2);
      await expect.poll(async () => (await readLog()).slice(restoreOffset)).toMatch(consumerTranspiled);
    }
  });

  test('(gated) retains a later edit while pre is held, without overlapping producers', async ({ page }) => {
    const original = await readFile(docPath, 'utf8');
    const armedGate = join(fixtureDir, 'scripts/.armed-gate');
    const before = await readGeneration();
    try {
      await page.goto('/consumer');
      await writeFile(armedGate, 'armed');
      await writeFile(docPath, original + '\nfirst edit\n');
      await expect.poll(() => fetch('http://127.0.0.1:9777/held').then(r => r.status).catch(() => 0)).toBe(404);
      await writeFile(docPath, original + '\nsecond edit\n');
      await rm(armedGate, { force: true });
      await fetch('http://127.0.0.1:9777/release');
      await expect.poll(readGeneration).toBe(before + 2);
      await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before + 2}\\s*`));
      expect(await readLog()).not.toContain('EADDRINUSE');
    } finally {
      await rm(armedGate, { force: true });
      await fetch('http://127.0.0.1:9777/release').catch(() => undefined);
      const offset = (await readLog()).length;
      await writeFile(docPath, original);
      await expect.poll(async () => (await readLog()).slice(offset)).toMatch(consumerTranspiled);
    }
  });

  test('failed pre sends no reload or compile, then recovers on the next source edit', async ({ page }) => {
    const original = await readFile(docPath, 'utf8');
    const before = await readGeneration();
    try {
      await page.goto('/consumer');
      await page.evaluate(() => {
        const received: string[] = [];
        Object.assign(globalThis, { execFrames: received });
        const events = new EventSource('/bascik-live-reload');
        events.onmessage = event => received.push(event.data);
      });
      const offset = (await readLog()).length;
      await writeFile(docPath, original + '\nFAIL_EXEC\n');
      await expect.poll(async () => (await readLog()).slice(offset)).toContain('exited with code 1');
      expect((await readLog()).slice(offset)).not.toMatch(consumerTranspiled);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { execFrames: string[] }).execFrames))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^reload(?:\s|$)/)]));
      await writeFile(docPath, original + '\nrecovered\n');
      await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before + 1}\\s*`));
    } finally {
      const offset = (await readLog()).length;
      await writeFile(docPath, original);
      await expect.poll(async () => (await readLog()).slice(offset)).toMatch(consumerTranspiled);
    }
  });

  test('failed post does not publish a success reload, and the next source edit recovers', async ({ page }) => {
    const original = await readFile(docPath, 'utf8');
    const before = await readGeneration();
    try {
      await page.goto('/consumer');
      const offset = (await readLog()).length;
      await writeFile(docPath, original + '\nFAIL_POST\n');
      await expect.poll(async () => (await readLog()).slice(offset)).toContain('exec "scripts/post.mjs" exited with code 1');
      expect((await readLog()).slice(offset)).toMatch(consumerTranspiled);
      await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before}\\s*`));
      await writeFile(docPath, original + '\npost recovered\n');
      await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before + 2}\\s*`));
    } finally {
      const offset = (await readLog()).length;
      await writeFile(docPath, original);
      await expect.poll(async () => (await readLog()).slice(offset)).toContain('(completed) exec: scripts/post.mjs');
    }
  });
});