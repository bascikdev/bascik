import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, lstat, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compilerCommand, cpuCoverage, cpuToolLimitation, distDigest, DOCS_EDIT_TARGETS, encodeEditPlan, linkDependencies, pageEditTarget, parseTimelineArguments, recoverBubbleprofTraceJoin, resolveWorkerCpu } from '../../bench/compiler-timeline.ts';
import { pairOrder, parseCompareArguments, relinkCompiler, summarizeRuns } from '../../bench/compiler-compare.ts';
import { sampleProcessGroup } from '../../bench/profile-runner.ts';
import { descendantClinicDatasets, isClinicTraceJoinFailure, joinNodeTraceLogs, mainClinicDataset, nativeWorkerCpuLimitation, profilerFreeEnvironment, traceEventPids, validateDoctorProcessStat } from '../../bench/profile-workload.ts';
import { readdir } from 'node:fs/promises';

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
    expect(parseTimelineArguments(['--report-dir', '/r'])).toMatchObject({ workerCpu: 'auto' });
    expect(parseTimelineArguments(['--report-dir', '/r', '--worker-cpu', 'none'])).toMatchObject({ workerCpu: 'none' });
    expect(parseTimelineArguments(['--report-dir', '/r', '--worker-cpu', 'inspector'])).toMatchObject({ workerCpu: 'inspector' });
    expect(() => parseTimelineArguments(['--report-dir', '/r', '--worker-cpu', 'some'])).toThrow('worker-cpu must be auto, all, first, none, or inspector');
  });

  it('derives explicit page edit targets and rejects paths that escape the project', () => {
    expect(parseTimelineArguments(['--report-dir', '/r', '--edit-page', 'src/pages/guide/intro.html']))
      .toMatchObject({ edits: true, editTargets: [{ kind: 'page', path: 'src/pages/guide/intro.html', outputPath: 'dist/guide/intro.html' }] });
    expect(pageEditTarget('./site/pages/a.html', 'out/a.html')).toEqual({ kind: 'page', path: 'site/pages/a.html', outputPath: 'out/a.html' });
    expect(pageEditTarget('src\\pages\\b.html')).toMatchObject({ path: 'src/pages/b.html', outputPath: 'dist/b.html' });
    expect(() => pageEditTarget('site/pages/a.html')).toThrow('--edit-output is required');
    expect(() => pageEditTarget('../other/src/pages/a.html')).toThrow('without ..');
    expect(() => pageEditTarget('/abs/src/pages/a.html')).toThrow('without ..');
    expect(() => pageEditTarget('C:/src/pages/a.html')).toThrow('without ..');
    expect(() => pageEditTarget('src/pages/a.md')).toThrow('.html page');
    expect(() => pageEditTarget('src/pages/a.html', 'dist/a.txt')).toThrow('.html file');
    expect(() => parseTimelineArguments(['--report-dir', '/r', '--edit-output', 'dist/a.html'])).toThrow('--edit-output requires --edit-page');
  });

  it('encodes edit plans without characters Clinic argument parsing rewrites', async () => {
    for (const targets of [[], DOCS_EDIT_TARGETS]) {
      const encoded = encodeEditPlan(targets);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual(targets);
      const command = await compilerCommand('doctor', [process.execPath, '/private/subject.ts', '/c', 'dev', '/r.json', encoded], '/private/profiles');
      expect(command.join(' ')).not.toMatch(/[[\]]/);
    }
  });

  it('refuses native worker CPU capture where it is known to stall and resolves auto safely', () => {
    const limitation = 'Native page-worker CPU capture stalls';
    expect(cpuToolLimitation({ tools: ['control', 'cpu'], workers: undefined, workerCpu: 'all' }, limitation)).toContain('--worker-cpu none');
    expect(cpuToolLimitation({ tools: ['cpu'], workers: true, workerCpu: 'first' }, limitation)).toContain(limitation);
    expect(cpuToolLimitation({ tools: ['cpu'], workers: false, workerCpu: 'all' }, limitation)).toBeUndefined();
    for (const workerCpu of ['none', 'inspector'] as const) expect(cpuToolLimitation({ tools: ['cpu'], workers: undefined, workerCpu }, limitation)).toBeUndefined();
    expect(cpuToolLimitation({ tools: ['doctor'], workers: undefined, workerCpu: 'all' }, limitation)).toBeUndefined();
    expect(cpuToolLimitation({ tools: ['cpu'], workers: undefined, workerCpu: 'all' }, null)).toBeUndefined();
    expect(resolveWorkerCpu('auto', limitation)).toBe('none');
    expect(resolveWorkerCpu('auto', null)).toBe('all');
    expect(resolveWorkerCpu('first', limitation)).toBe('first');
    expect(nativeWorkerCpuLimitation('darwin', 'v24.21.0')).toMatch(/v24\.21\.0\/macOS/);
    expect(nativeWorkerCpuLimitation('darwin', 'v24.17.0')).toBeDefined();
    expect(nativeWorkerCpuLimitation('linux', 'v24.21.0')).toBeUndefined();
    expect(nativeWorkerCpuLimitation('darwin', 'v25.0.0')).toBeUndefined();
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

  it('counts each inspector-profiled worker thread once across its per-task profiles', async () => {
    await withRoot(async profiles => {
      await writeFile(join(profiles, 'CPU.20261009.120000.4242.0.001.cpuprofile'), cpuProfile);
      const metadata = (threadId: number, pid = 4242) => JSON.stringify({ role: 'page-worker', pid, threadId, task: 'p', profileStartTime: 0, profileEndTime: 10 });
      for (const [name, threadId, pid] of [['page-worker-4242-2-0', 2, 4242], ['page-worker-4242-2-1', 2, 4242], ['page-worker-4242-3-0', 3, 4242], ['page-worker-9999-4-0', 4, 9999]] as const) {
        await writeFile(join(profiles, `${name}.cpuprofile`), cpuProfile);
        await writeFile(join(profiles, `${name}.metadata.json`), metadata(threadId, pid));
      }
      expect(await cpuCoverage(profiles, { pid: 4242, workerStarts: 2 })).toMatchObject({ workerProfiles: 2, workersComplete: true });
      // Metadata must match its profile, or the capture is rejected.
      await writeFile(join(profiles, 'page-worker-4242-3-0.metadata.json'), JSON.stringify({ role: 'page-worker', pid: 4242, threadId: 3, profileStartTime: 1, profileEndTime: 10 }));
      await expect(cpuCoverage(profiles, { pid: 4242, workerStarts: 2 })).rejects.toThrow('CPU metadata start mismatch');
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

describe('rotated Node trace log join', () => {
  const log = (...events: object[]) => `{"traceEvents":[${events.map(event => JSON.stringify(event)).join(',')}]}`;
  const event = (pid: number, name: string) => ({ pid, tid: 1, ts: 1, ph: 'X', cat: 'node.async_hooks', name });

  it('joins rotations numerically into one valid trace and removes the inputs', async () => {
    await withRoot(async root => {
      // Rotation 10 must follow 2, which a lexical sort would reverse. Rotation 3 is empty.
      await writeFile(join(root, 'node_trace.10.log'), `${log(event(7, 'd'))}\n`);
      await writeFile(join(root, 'node_trace.2.log'), log(event(7, 'b'), event(7, 'c $& <html>')));
      await writeFile(join(root, 'node_trace.3.log'), log());
      await writeFile(join(root, 'node_trace.1.log'), log(event(7, 'a')));
      await writeFile(join(root, 'unrelated.log'), 'kept');
      const output = join(root, 'out.traceevent');
      const joined = await joinNodeTraceLogs(root, output, 7);
      expect(joined.files).toEqual(['node_trace.1.log', 'node_trace.2.log', 'node_trace.3.log', 'node_trace.10.log']);
      const parsed = JSON.parse(await readFile(output, 'utf8'));
      expect(parsed.traceEvents.map((entry: { name: string }) => entry.name)).toEqual(['a', 'b', 'c $& <html>', 'd']);
      expect(joined.bytes).toBe((await readFile(output)).length);
      expect((await readdir(root)).sort()).toEqual(['out.traceevent', 'unrelated.log']);
    });
  });

  it('refuses foreign PIDs, truncated logs, and empty directories without removing inputs', async () => {
    await withRoot(async root => {
      await expect(joinNodeTraceLogs(root, join(root, 'out'), 7)).rejects.toThrow('no node_trace logs');
      await writeFile(join(root, 'node_trace.1.log'), log(event(7, 'a')));
      await writeFile(join(root, 'node_trace.2.log'), log(event(8, 'child')));
      await expect(joinNodeTraceLogs(root, join(root, 'out'), 7)).rejects.toThrow('foreign PIDs 8');
      await writeFile(join(root, 'node_trace.2.log'), log(event(7, 'b')).slice(0, -2));
      await expect(joinNodeTraceLogs(root, join(root, 'out'), 7)).rejects.toThrow('node_trace.2.log: incomplete');
      await writeFile(join(root, 'node_trace.2.log'), 'not a trace');
      await expect(joinNodeTraceLogs(root, join(root, 'out'), 7)).rejects.toThrow('not a Node trace log');
      expect((await readdir(root)).sort()).toEqual(['node_trace.1.log', 'node_trace.2.log']);
    });
  });

  it('recovers a Bubbleprof capture only after a completed subject and a Clinic join failure', async () => {
    await withRoot(async root => {
      const directory = join(root, 'cold');
      const project = join(root, 'project');
      const profiles = join(directory, 'profiles');
      const dataset = join(profiles, '7.clinic-bubbleprof');
      const resultPath = join(directory, 'subject.json');
      for (const path of [join(directory, 'capture'), project, dataset]) await mkdir(path, { recursive: true });
      const failure = 'Analysing data\nError: premature close\n    at onclosenexttick (end-of-stream/index.js:55:86)\n';
      await writeFile(join(directory, 'capture/process.log'), failure);
      await writeFile(join(project, 'node_trace.1.log'), log(event(7, 'a')));
      await writeFile(join(project, 'node_trace.2.log'), log(event(7, 'b')));
      await writeFile(join(dataset, '7.clinic-bubbleprof-systeminfo'), '{}');
      await writeFile(join(dataset, '7.clinic-bubbleprof-stacktrace'), 'stack');
      // Clinic's failed join leaves a truncated traceevent that recovery replaces.
      await writeFile(join(dataset, '7.clinic-bubbleprof-traceevent'), '{"traceEvents":[{"pid":7}');
      // No subject result: the subject did not finish, so the original error stands.
      expect(await recoverBubbleprofTraceJoin(directory, project, profiles, resultPath)).toBeUndefined();
      await writeFile(resultPath, JSON.stringify({ pid: 7 }));
      await writeFile(join(directory, 'capture/process.log'), 'Analysing data\nError: ENOSPC\n');
      expect(await recoverBubbleprofTraceJoin(directory, project, profiles, resultPath)).toBeUndefined();
      await writeFile(join(directory, 'capture/process.log'), failure);
      const recovered = await recoverBubbleprofTraceJoin(directory, project, profiles, resultPath);
      expect(recovered).toMatchObject({ dataset, files: ['node_trace.1.log', 'node_trace.2.log'] });
      expect(JSON.parse(await readFile(join(dataset, '7.clinic-bubbleprof-traceevent'), 'utf8')).traceEvents).toHaveLength(2);
      expect(await readdir(project)).toEqual([]);
    });
  });

  it('recognizes only Clinic trace-join failures after a normal target exit', () => {
    const stack = '    at onclosenexttick (/repo/node_modules/end-of-stream/index.js:55:86)\n    at process.processTicksAndRejections (node:internal/process/task_queues:85:11)\n';
    const failure = `✓ Build complete in 28.42s\nAnalysing data\nError: premature close\n${stack}`;
    expect(isClinicTraceJoinFailure(failure)).toBe(true);
    expect(isClinicTraceJoinFailure('Analysing data\nError: premature close\n')).toBe(true);
    expect(isClinicTraceJoinFailure(`process exited with exit code 1\n${failure}`)).toBe(false);
    expect(isClinicTraceJoinFailure(`${failure}Output file is /p/1.clinic-bubbleprof\n`)).toBe(false);
    expect(isClinicTraceJoinFailure('Analysing data\nError: ENOSPC\n')).toBe(false);
    expect(isClinicTraceJoinFailure(`${failure}Another failure\n`)).toBe(false);
    expect(isClinicTraceJoinFailure('Analysing data\r\nError: premature close\r\n    at a (x.js:1:1)\r')).toBe(true);
    // Many frame-like repetitions on one line with a non-matching tail must not backtrack exponentially.
    const started = performance.now();
    expect(isClinicTraceJoinFailure(`Analysing data\nError: premature close\n\tat ${'\tat '.repeat(5000)}\nnot a frame`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('stalled capture sampling', () => {
  it.runIf(process.platform === 'darwin')('samples at most four members of the capture group and journals failures', async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file === '/bin/ps') return { stdout: ' 10 10\n 11 10\n 12 99\n 13 10\n 14 10\n 15 10\n', stderr: '' };
      if (args[0] === '11') throw new Error('sample: permission denied');
      return { stdout: '', stderr: '' };
    };
    const result = await sampleProcessGroup(10, '/private/capture', run as never);
    expect(result).toEqual({
      members: [10, 11, 13, 14],
      samples: [
        { pid: 10, file: '/private/capture/sample-10.txt' },
        { pid: 11, error: 'Error: sample: permission denied' },
        { pid: 13, file: '/private/capture/sample-13.txt' },
        { pid: 14, file: '/private/capture/sample-14.txt' },
      ],
    });
    expect(calls.filter(call => call[0] === '/usr/bin/sample').map(call => call.slice(1, 3))).toEqual([['10', '3'], ['11', '3'], ['13', '3'], ['14', '3']]);
  });
});

describe('Doctor processstat validation', () => {
  const doctorRequire = createRequire(createRequire(import.meta.url).resolve('@clinic/doctor/package.json'));
  const protobuf = doctorRequire('protocol-buffers');
  const ProcessStat = protobuf(readFileSync(join(dirname(doctorRequire.resolve('@clinic/doctor/package.json')), 'format/process-stat.proto'))).ProcessStat;
  const frame = (timestamp: number) => {
    const body: Buffer = ProcessStat.encode({ timestamp, delay: 1, cpu: 0.5, handles: 3, loopUtilization: 10, memory: { rss: 1, heapTotal: 2, heapUsed: 1, external: 0, arrayBuffers: 0 } });
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(body.length);
    return Buffer.concat([prefix, body]);
  };

  it('accepts one sampler stream with a nondecreasing clock', () => {
    expect(validateDoctorProcessStat(Buffer.concat([frame(1000), frame(1010), frame(1010), frame(1020)])))
      .toMatchObject({ frames: 4, firstTimestamp: 1000, lastTimestamp: 1020 });
  });

  it('rejects truncated, empty, misaligned, and interleaved streams with the byte offset', () => {
    const good = Buffer.concat([frame(1000), frame(1010)]);
    expect(() => validateDoctorProcessStat(Buffer.alloc(0))).toThrow('no ProcessStat frames');
    expect(() => validateDoctorProcessStat(good.subarray(0, good.length - 1))).toThrow(/truncated frame at byte \d+ after 1 frames/);
    expect(() => validateDoctorProcessStat(Buffer.concat([good, Buffer.from([0])]))).toThrow('truncated frame prefix');
    // A second sampler under the same PID restarts its own clock between the first writer's frames.
    expect(() => validateDoctorProcessStat(Buffer.concat([frame(2000), frame(1000), frame(2010)]))).toThrow('timestamp moved backwards');
    // A torn write shifts every later prefix, which surfaces as an undecodable or truncated frame.
    const torn = Buffer.concat([frame(1000), frame(1010).subarray(1), frame(1020)]);
    expect(() => validateDoctorProcessStat(torn, 'p.processstat')).toThrow(/^p\.processstat: /);
  });
});
