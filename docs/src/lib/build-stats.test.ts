import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countComponents,
  countSourcePages,
  formatSeconds,
  millisecondsPerPage,
  parseBuildLog,
  parseDuration,
  readBuildTimings,
  type BuildRunTimings,
  type BuildTimings,
} from './build-stats.ts';

const run = (wallSeconds: number, pagesSeconds: number): BuildRunTimings => ({
  wallSeconds,
  totalSeconds: wallSeconds - 0.2,
  startupSeconds: 0.2,
  preScriptsSeconds: 0.1,
  pagesSeconds,
  postScriptsSeconds: 0.7,
  otherSeconds: 0.1,
  execScripts: [],
  pageMedianMs: 30,
  slowestPage: { path: 'pages/cli.html', ms: 613 },
});

const timings: BuildTimings = {
  measuredOn: '2026-10-14',
  bascikVersion: '1.0.0',
  nodeVersion: '24.0.0',
  machine: 'Test CPU, 8 cores',
  pages: 4,
  buildScripts: 971,
  cold: run(22.5, 20),
  warm: run(5, 4),
};

const LOG = `
(started) exec: scripts/publish-heading-anchors.ts
(completed) exec: scripts/publish-heading-anchors.ts in 84ms
(started) exec: scripts/generate-og-images.ts
Starting transpiling...
(completed) exec: scripts/generate-og-images.ts in 722ms
transpiled: pages/404.html in 93ms
transpiled: pages/cli.html in 613ms
transpiled: pages/faq.html in 1.2s
copied: assets/x.css

✓ 3 pages transpiled in 19.82s
(started) exec: scripts/generate-git-dates.ts
(completed) exec: scripts/generate-git-dates.ts in 523ms
(completed) exec: scripts/generate-csp-meta.ts in 226ms

✓ Build complete in 20.69s
`;

describe('parseDuration', () => {
  it.each([
    ['84ms', 0.084],
    ['0.4ms', 0.0004],
    ['<0.01ms', 0.00001],
    ['1.25s', 1.25],
    ['5s', 5],
  ])('reads %s', (text, seconds) => {
    expect(parseDuration(text)).toBeCloseTo(seconds, 6);
  });

  it('rejects text that is not a duration', () => {
    expect(() => parseDuration('soon')).toThrow('Cannot read the duration');
  });
});

describe('parseBuildLog', () => {
  const execEntries = [
    { script: 'scripts/publish-heading-anchors.ts', phase: 'pre' as const },
    { script: 'scripts/generate-og-images.ts', phase: 'parallel' as const },
    { script: 'scripts/generate-git-dates.ts', phase: 'post' as const },
    { script: 'scripts/generate-csp-meta.ts', phase: 'post' as const },
  ];

  it('reads the phases, exec scripts, and page timings the CLI prints', () => {
    const parsed = parseBuildLog(LOG, 21.4, execEntries);
    expect(parsed.pages).toBe(3);
    expect(parsed.pagesSeconds).toBe(19.82);
    expect(parsed.totalSeconds).toBe(20.69);
    expect(parsed.wallSeconds).toBe(21.4);
    expect(parsed.startupSeconds).toBe(0.71);
    expect(parsed.preScriptsSeconds).toBe(0.08);
    expect(parsed.postScriptsSeconds).toBe(0.75);
    expect(parsed.execScripts.map((script) => [script.script, script.phase])).toEqual([
      ['scripts/publish-heading-anchors.ts', 'pre'],
      ['scripts/generate-og-images.ts', 'parallel'],
      ['scripts/generate-git-dates.ts', 'post'],
      ['scripts/generate-csp-meta.ts', 'post'],
    ]);
    expect(parsed.slowestPage).toEqual({ path: 'pages/faq.html', ms: 1200 });
    expect(parsed.pageMedianMs).toBe(613);
  });

  it('keeps the phases from adding up to more than the build total', () => {
    const parsed = parseBuildLog(LOG, 21.4, execEntries);
    const sum = parsed.preScriptsSeconds + parsed.pagesSeconds + parsed.postScriptsSeconds + parsed.otherSeconds;
    expect(sum).toBeLessThanOrEqual(parsed.totalSeconds + 0.01);
  });

  it('treats a script the config does not list as parallel, and ignores color codes', () => {
    const colored = LOG.replace('✓ Build complete', '\u001B[32m✓ Build complete\u001B[39m').replace('✓ 3 pages transpiled', '\u001B[32m✓ 3 pages transpiled\u001B[39m');
    const parsed = parseBuildLog(colored, 21.4, []);
    expect(parsed.execScripts.every((script) => script.phase === 'parallel')).toBe(true);
    expect(parsed.pages).toBe(3);
  });

  it('names the missing line when the log is incomplete', () => {
    expect(() => parseBuildLog('nothing here', 1, [])).toThrow('pages transpiled');
    expect(() => parseBuildLog('✓ 3 pages transpiled in 1s', 1, [])).toThrow('Build complete');
  });
});

describe('build-stats', () => {
  let root: string;
  let pagesDir: string;
  let componentDir: string;
  let timingsPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'build-stats-'));
    pagesDir = join(root, 'pages');
    componentDir = join(root, 'components');
    timingsPath = join(root, 'build-timings.json');
    await mkdir(join(pagesDir, 'nested'), { recursive: true });
    await mkdir(join(componentDir, 'card'), { recursive: true });
    for (const file of ['index.html', 'a.html', 'nested/b.html', 'nested/c.html']) {
      await writeFile(join(pagesDir, file), '<p></p>');
    }
    await writeFile(join(pagesDir, 'notes.md'), 'not a page');
    await writeFile(join(componentDir, 'card/card.html'), '<p></p>');
    await writeFile(join(componentDir, 'card/card.css'), 'p{}');
    await writeFile(timingsPath, JSON.stringify(timings));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('counts page sources recursively and ignores other files', async () => {
    expect(await countSourcePages(pagesDir)).toBe(4);
  });

  it('counts component files across folders, and a folder that does not exist counts as none', async () => {
    expect(await countComponents([componentDir, join(root, 'missing')])).toBe(1);
  });

  it('formats seconds with a unit and no trailing decimal', () => {
    expect(formatSeconds(4)).toBe('4s');
    expect(formatSeconds(22.5)).toBe('22.5s');
    expect(formatSeconds(1.04)).toBe('1.0s');
    expect(formatSeconds(0.084)).toBe('84ms');
  });

  it('derives milliseconds per page and guards against zero pages', () => {
    expect(millisecondsPerPage(4, 102)).toBe(39);
    expect(millisecondsPerPage(4, 0)).toBe(0);
  });

  it('reads the recorded timings back unchanged', async () => {
    expect(await readBuildTimings(timingsPath)).toEqual(timings);
  });

  it('names the command that writes the timings when the file is missing', async () => {
    await expect(readBuildTimings(join(root, 'missing.json'))).rejects.toThrow('yarn docs:measure-build');
  });
});

describe('docs/build-timings.json', () => {
  it('is not far behind the live page count; re-run `yarn docs:measure-build` when this fails', async () => {
    const [live, recorded] = await Promise.all([countSourcePages(), readBuildTimings()]);
    expect(Math.abs(live - recorded.pages) / live).toBeLessThanOrEqual(0.25);
  });

  it('has a cold and a warm breakdown whose phases fit inside the build', async () => {
    const recorded = await readBuildTimings();
    for (const timingsRun of [recorded.cold, recorded.warm]) {
      const phases = timingsRun.preScriptsSeconds + timingsRun.pagesSeconds + timingsRun.postScriptsSeconds + timingsRun.otherSeconds;
      expect(phases).toBeLessThanOrEqual(timingsRun.totalSeconds + 0.05);
    }
    expect(recorded.warm.wallSeconds).toBeLessThan(recorded.cold.wallSeconds);
  });
});
