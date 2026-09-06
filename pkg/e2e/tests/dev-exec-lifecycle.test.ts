/**
 * E2E tests for exec producer/consumer lifecycle ownership (prompt 109).
 *
 * The `exec-fixture` wires a watched pre-phase generator to a consumer page:
 *
 *   pipeline.exec: [{ script: 'scripts/generator.mjs', phase: 'pre', watch: ['content/'] }]
 *   pipeline.watchPaths: ['content/']
 *
 * The generator writes `dist/generated.json` (out of src/). The consumer page
 * build script reads that literal path via readFileSync and prints its value.
 *
 * Run with:
 *   npx playwright test --config e2e/playwright.dev-exec.config.ts
 */
import { test, expect } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eDir = fileURLToPath(new URL('..', import.meta.url));
const fixtureDir = join(e2eDir, 'exec-fixture');
const docPath = join(fixtureDir, 'content/doc.md');
const markerPath = join(fixtureDir, 'scripts/.generation');
const armedGatePath = join(fixtureDir, 'scripts/.armed-gate');

const RELEASE_URL = 'http://127.0.0.1:9777/release';

const readGeneration = async (): Promise<number> => {
  const marker = await readFile(markerPath, 'utf8').catch(() => '0');
  return Number(marker.trim()) || 0;
};

test.describe('exec producer/consumer lifecycle ownership', () => {
  let originalDoc: string;

  test.beforeAll(async () => {
    originalDoc = await readFile(docPath, 'utf8');
  });

  test.afterEach(async () => {
    const current = await readFile(docPath, 'utf8').catch(() => null);
    if (current !== originalDoc) {
      await writeFile(docPath, originalDoc, 'utf8');
    }
  });

  test('startup runs the pre producer exactly once and the consumer sees the finished output', async ({ page }) => {
    // The generator runs once at startup (phase pre). A count of two would mean
    // the watched-registration path double-executed already-completed work.
    const startupGeneration = await readGeneration();
    expect(startupGeneration).toBe(1);

    await page.goto('/consumer');
    await expect(page.getByTestId('generated-value')).toHaveText(/generation-1\s*/);
  });

  test('a content edit re-runs the producer once, and the consumer compiles only after the producer finishes', async ({ page }) => {
    const before = await readGeneration();
    await page.goto('/consumer');
    await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before}\\s*`));

    // Write a content edit. The producer and the watch-path consumer both
    // observe `content/`; the consumer must wait for the producer to finish
    // before re-transpiling.
    await writeFile(docPath, `${originalDoc}\n\nEdit marker ${Date.now()}\n`, 'utf8');

    await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before + 1}\\s*`), { timeout: 15000 });
    const after = await readGeneration();
    expect(after).toBe(before + 1);
  });

  test('(gated) the served page keeps last-known-good while the producer is held, then updates on release', async ({ page }) => {
    const before = await readGeneration();
    await page.goto('/consumer');
    await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before}\\s*`));

    // Arm reload observation BEFORE the edit so the producer-gated reload is
    // captured deterministically (prompt 87 contract).
    const reloaded = page.waitForEvent('framenavigated', { timeout: 20000 });

    // Arm the gate so the producer holds its next completion, then write a
    // content edit. The producer and watch-path consumer both observe
    // `content/`; the consumer must wait for the producer to finish.
    await writeFile(armedGatePath, 'armed', 'utf8');
    await writeFile(docPath, `${originalDoc}\n\ngated ${Date.now()}\n`, 'utf8');

    // The producer has started (generation bumped) but not published. The page
    // must still serve the previous known-good generation: no premature reload
    // and no blank/error page.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before}\\s*`));
    await rm(armedGatePath, { force: true });

    // Release the gate; the producer publishes, the consumer re-transpiles,
    // and the reload arrives once with the finished generation.
    await fetch(RELEASE_URL);
    await reloaded;
    await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before + 1}\\s*`), { timeout: 15000 });
  });
});