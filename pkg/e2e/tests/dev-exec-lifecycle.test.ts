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
 * A second `phase: 'parallel'` producer (`scripts/parallel-generator.mjs`,
 * prompt 137) writes `dist/parallel.json`. Under BASCIK_PARALLEL_GATE=1 it
 * holds behind an HTTP gate on 127.0.0.1:9778 so the suite can prove the dev
 * server serves pages while the parallel entry is still running, and that the
 * generated value is published once through the coordinator on release.
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
const PARALLEL_STATUS_URL = 'http://127.0.0.1:9778/status';
const PARALLEL_RELEASE_URL = 'http://127.0.0.1:9778/release';

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

  test('a parallel entry runs alongside the live dev server and publishes its value once on completion', async ({ page }) => {
    // The parallel producer is still held behind its gate: it has not written
    // dist/parallel.json yet. The dev server must already be serving the
    // consumer page (boot did not wait for the parallel phase), with the pre
    // producer's value present and the parallel value honestly missing.
    const status = await fetch(PARALLEL_STATUS_URL).then((r) => r.json() as Promise<{ running: boolean }>);
    expect(status.running).toBe(true);

    await page.goto('/consumer');
    await expect(page.getByTestId('generated-value')).toHaveText(/generation-\d+\s*/);
    await expect(page.getByTestId('parallel-value')).toHaveText(/missing\s*/);

    // Arm reload observation BEFORE releasing the gate so the coordinated
    // reload for the parallel completion is captured deterministically.
    const reloaded = page.waitForEvent('framenavigated', { timeout: 20000 });
    await fetch(PARALLEL_RELEASE_URL);
    await reloaded;

    // The parallel completion reached the coordinator, the consumer page
    // re-transpiled against the produced bytes, and the browser reloaded once
    // with the generated value.
    await expect(page.getByTestId('parallel-value')).toHaveText(/parallel-\d+\s*/, { timeout: 15000 });
    const published = (await page.getByTestId('parallel-value').textContent())?.trim();
    expect(published).toMatch(/^parallel-\d+$/);

    // A fresh navigation serves the same published generation: the value was
    // published exactly once and is stable, not re-run or reverted.
    await page.goto('/consumer');
    await expect(page.getByTestId('parallel-value')).toHaveText(new RegExp(`${published}\\s*`));
    // The gate server closed after release: the parallel child exited.
    await expect(fetch(PARALLEL_STATUS_URL)).rejects.toThrow();
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

    // Observe the gate signal: the producer has started (generation bumped)
    // and is holding behind its release server, which answers 404 for any
    // path other than /release. No wall-clock wait: this resolves the moment
    // the gate binds.
    await expect
      .poll(() => fetch('http://127.0.0.1:9777/held').then((r) => r.status).catch(() => 0), { timeout: 15000 })
      .toBe(404);
    // The marker is written before the gate binds, so this is a plain read.
    expect(await readGeneration()).toBe(before + 1);

    // The producer has not published. The page must still serve the previous
    // known-good generation: the armed navigation promise must still be
    // pending (race against an already-resolved sentinel), and the DOM must be
    // intact, not blank or an error page.
    const sentinel = Symbol('no-navigation');
    const raced = await Promise.race([reloaded.then(() => 'navigated' as const), Promise.resolve(sentinel)]);
    expect(raced).toBe(sentinel);
    await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before}\\s*`));
    await rm(armedGatePath, { force: true });

    // Release the gate; the producer publishes, the consumer re-transpiles,
    // and the reload arrives once with the finished generation.
    await fetch(RELEASE_URL);
    await reloaded;
    await expect(page.getByTestId('generated-value')).toHaveText(new RegExp(`generation-${before + 1}\\s*`), { timeout: 15000 });
  });
});