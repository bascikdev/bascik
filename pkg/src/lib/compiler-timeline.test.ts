import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, lstat, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { compilerCommand, cpuCoverage, distDigest, linkDependencies, parseTimelineArguments } from '../../bench/compiler-timeline.ts';
import { pairOrder, parseCompareArguments, relinkCompiler, summarizeRuns } from '../../bench/compiler-compare.ts';
import { descendantClinicDatasets, mainClinicDataset, profilerFreeEnvironment, traceEventPids } from '../../bench/profile-workload.ts';

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bascik-timeline-test-')));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const cpuProfile = JSON.stringify({
  nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0 }, children: [] }],
  samples: [1], timeDeltas: [1], startTime: 0, endTime: 10,
});

describe('private compiler investigation harness', () => {
  it('keeps fixture cache private while linking dependencies and the selected compiler', async () => {
    await withRoot(async root => {
      const source = join(root, 'original');
      const fixture = join(root, 'fixture');
      await mkdir(join(source, '.cache'), { recursive: true });
      await mkdir(join(source, 'dependency'));
      await writeFile(join(source, '.cache/sentinel'), 'untouched');
      await linkDependencies(source, fixture, join(root, 'compiler'));
      expect((await lstat(join(fixture, 'dependency'))).isSymbolicLink()).toBe(true);
      await expect(lstat(join(fixture, '.cache'))).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(join(fixture, '.cache'));
      expect((await lstat(join(fixture, '.cache'))).isSymbolicLink()).toBe(false);
      await rm(join(fixture, '.cache'), { recursive: true });
      expect(await readFile(join(source, '.cache/sentinel'), 'utf8')).toBe('untouched');
    });
  });

  it('uses distinct Clinic Flame and 0x commands with an explicit Node subject', async () => {
    const subject = [process.execPath, '/private/subject.ts', '--build'];
    const flame = await compilerCommand('flame', subject, '/private/profiles');
    expect(flame).toContain('flame');
    expect(flame).toContain('--collect-only');
    expect(flame.slice(flame.indexOf('--') + 1)).toEqual(subject);
    const zero = await compilerCommand('0x', subject, '/private/profiles');
    expect(zero).toContain('--tree-debug');
    expect(zero.slice(zero.indexOf('--') + 1)).toEqual(subject);
  });

  it('parses timeline arguments and rejects unsupported values before any capture', () => {
    expect(parseTimelineArguments(['--report-dir', '/private/r'])).toMatchObject({ rounds: 1, modes: ['dev', 'build'], tools: ['control'], edits: false, workers: undefined });
    expect(parseTimelineArguments(['--report-dir', '/private/r', '--source', '/private/site', '--site-url', 'https://example.test', '--workers', 'false']))
      .toMatchObject({ source: '/private/site', siteUrl: 'https://example.test', workers: false });
    expect(() => parseTimelineArguments([])).toThrow('--report-dir is required');
    expect(() => parseTimelineArguments(['--report-dir', '/r', '--tools', 'control,perf'])).toThrow('unsupported tool');
    expect(() => parseTimelineArguments(['--report-dir', '/r', '--modes', 'serve'])).toThrow('unsupported mode');
    expect(() => parseTimelineArguments(['--report-dir', '/r', '--rounds', '11'])).toThrow('rounds must be 1..10');
    expect(() => parseTimelineArguments(['--report-dir', '/r', '--workers', 'yes'])).toThrow('workers must be true or false');
    expect(() => parseTimelineArguments(['--report-dir', '/r', '--unknown'])).toThrow();
  });

  it('digests every dist file independently of directory order', async () => {
    await withRoot(async root => {
      const compiler = join(root, 'compiler');
      await mkdir(join(compiler, 'dist/lib'), { recursive: true });
      await writeFile(join(compiler, 'dist/index.js'), 'index');
      await writeFile(join(compiler, 'dist/lib/a.js'), 'a');
      const first = await distDigest(compiler);
      expect(await distDigest(compiler)).toBe(first);
      await writeFile(join(compiler, 'dist/lib/a.js'), 'changed');
      const changed = await distDigest(compiler);
      expect(changed).not.toBe(first);
      // Same bytes under a different path are a different snapshot.
      await rm(join(compiler, 'dist/lib/a.js'));
      await writeFile(join(compiler, 'dist/lib/b.js'), 'changed');
      expect(await distDigest(compiler)).not.toBe(changed);
      await rm(join(compiler, 'dist'), { recursive: true });
      await mkdir(join(compiler, 'dist'));
      await expect(distDigest(compiler)).rejects.toThrow('no dist files');
    });
  });

  it('records worker CPU coverage against observed worker starts and requires the main profile', async () => {
    await withRoot(async profiles => {
      await expect(cpuCoverage(profiles, { pid: 4242, workerStarts: 0 })).rejects.toThrow('missing main CPU profile');
      await writeFile(join(profiles, 'CPU.20261009.120000.4242.0.001.cpuprofile'), cpuProfile);
      await writeFile(join(profiles, 'CPU.20261009.120000.4242.1.002.cpuprofile'), cpuProfile);
      // Another process's profile is not the subject's worker.
      await writeFile(join(profiles, 'CPU.20261009.120000.9999.0.003.cpuprofile'), cpuProfile);
      expect(await cpuCoverage(profiles, { pid: 4242, workerStarts: 2, childStarts: 5 })).toEqual({
        mainProfile: true, workerProfiles: 1, workerStarts: 2, workersComplete: false, scriptChildren: 5, scriptChildrenCaptured: 0,
      });
      expect(await cpuCoverage(profiles, { pid: 4242, workerStarts: 1 })).toMatchObject({ workersComplete: true });
    });
  });
});

describe('paired same-path compiler comparison', () => {
  it('requires every path argument and rejects removed edit mode', () => {
    const required = ['--project', '/p', '--baseline', '/b', '--candidate', '/c', '--report-dir', '/r'];
    expect(parseCompareArguments(required)).toMatchObject({ rounds: 3, mode: 'build', siteUrl: undefined });
    expect(() => parseCompareArguments(required.slice(2))).toThrow('--project is required');
    expect(() => parseCompareArguments([...required, '--mode', 'serve'])).toThrow('mode must be dev or build');
    expect(() => parseCompareArguments([...required, '--rounds', '0'])).toThrow('rounds must be 1..10');
    // Byte-equivalence controls require unchanged authored sources.
    expect(() => parseCompareArguments([...required, '--edits'])).toThrow();
  });

  it('alternates which compiler runs first each round', () => {
    expect([1, 2, 3, 4].map(pairOrder)).toEqual([
      ['baseline', 'candidate'], ['candidate', 'baseline'], ['baseline', 'candidate'], ['candidate', 'baseline'],
    ]);
  });

  it('summarizes medians per compiler and cache state', () => {
    const run = (name: 'baseline' | 'candidate', state: 'cold' | 'warm', readyMs: number) => ({ name, state, result: { readyMs } });
    const summary = summarizeRuns([run('baseline', 'cold', 30), run('baseline', 'cold', 10), run('baseline', 'cold', 20), run('candidate', 'warm', 4), run('candidate', 'warm', 2)]);
    expect(summary['baseline-cold']).toEqual({ samples: [30, 10, 20], median: 20, min: 10, max: 30 });
    expect(summary['candidate-warm']).toMatchObject({ median: 3, min: 2, max: 4 });
    expect(summary['baseline-warm']).toBeUndefined();
  });

  it('relinks the fixture dependency to each compiler and never removes a real directory', async () => {
    await withRoot(async root => {
      const project = join(root, 'project');
      const third = join(root, 'third');
      const baseline = join(root, 'baseline');
      for (const path of [third, baseline]) await mkdir(path);
      await mkdir(join(project, 'node_modules/@bascik'), { recursive: true });
      // A fixture prepared by another harness may point at an unrelated snapshot.
      await symlink(third, join(project, 'node_modules/@bascik/bascik'));
      expect(await relinkCompiler(project, baseline)).toBe(baseline);
      expect(await readlink(join(project, 'node_modules/@bascik/bascik'))).toBe(baseline);
      await rm(join(project, 'node_modules/@bascik/bascik'));
      await mkdir(join(project, 'node_modules/@bascik/bascik'));
      await writeFile(join(project, 'node_modules/@bascik/bascik/sentinel'), 'kept');
      await expect(relinkCompiler(project, baseline)).rejects.toThrow('must be a symlink');
      expect(await readFile(join(project, 'node_modules/@bascik/bascik/sentinel'), 'utf8')).toBe('kept');
    });
  });
});

describe('profiler descendant isolation', () => {
  it('selects only the dataset Clinic announced for the main target', async () => {
    await withRoot(async profiles => {
      for (const name of ['10001.clinic-doctor', '58812.clinic-doctor', '58812.clinic-doctor.html']) await mkdir(join(profiles, name));
      const log = `Analysing data\nOutput file is ${profiles}/58812.clinic-doctor\n`;
      const main = mainClinicDataset(log, profiles, 'doctor');
      expect(main).toBe(join(profiles, '58812.clinic-doctor'));
      expect(await descendantClinicDatasets(profiles, 'doctor', main)).toEqual(['10001.clinic-doctor']);
      expect(() => mainClinicDataset('no announcement', profiles, 'doctor')).toThrow('missing or ambiguous');
      expect(() => mainClinicDataset(log, profiles, 'bubbleprof')).toThrow('missing or ambiguous');
      expect(() => mainClinicDataset(`Output file is /elsewhere/58812.clinic-doctor\n`, profiles, 'doctor')).toThrow('missing or ambiguous');
      expect(() => mainClinicDataset(`${log}Output file is ${profiles}/10001.clinic-doctor\n`, profiles, 'doctor')).toThrow('missing or ambiguous');
      // A repeated announcement of the same path is still one dataset.
      expect(mainClinicDataset(`${log}${log}`, profiles, 'doctor')).toBe(main);
    });
  });

  it('removes profiler preloads and inject paths from descendant environments only', () => {
    const inject = '/repo/node_modules/@clinic/doctor/injects';
    const environment = profilerFreeEnvironment({
      NODE_OPTIONS: '-r sampler.js --trace-events-enabled', NODE_CLINIC_DOCTOR_DATA_PATH: '/private/profiles', HEAP_PROFILER_PRELOADER_DISABLED: '1',
      NODE_PATH: `${inject}${delimiter}/site/lib`, PATH: '/bin', BASCIK_SITE_URL: 'https://example.test',
    });
    expect(environment).toEqual({ NODE_PATH: '/site/lib', PATH: '/bin', BASCIK_SITE_URL: 'https://example.test' });
    expect(profilerFreeEnvironment({ NODE_PATH: inject })).toEqual({});
  });

  it('reads trace-event PIDs across stream chunk boundaries', async () => {
    await withRoot(async root => {
      const path = join(root, 'traceevent');
      // Place a pid field across the default 64 KiB read boundary.
      const head = '{"traceEvents":[{"pid":11,"name":"a"},';
      const field = '{"pid":';
      const body = `${head}${' '.repeat(65_536 - 3 - head.length - field.length)}${field}424242,"name":"b"},{"pid" : 11}]}`;
      await writeFile(path, body);
      expect(body.indexOf('424242')).toBeLessThan(65_536);
      expect(body.indexOf('424242') + 6).toBeGreaterThan(65_536);
      expect([...await traceEventPids(path)].sort((a, b) => a - b)).toEqual([11, 424242]);
    });
  });
});
