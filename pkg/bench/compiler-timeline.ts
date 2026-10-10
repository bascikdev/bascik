/**
 * Private real-project compiler timelines. Run with --report-dir <new absolute directory>.
 * Defaults to the repository docs site; pass --source <project> for another Bascik project.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execute, clinicEnvironment } from './profile-runner.ts';
import { cleanGeneratorEnvironment, descendantClinicDatasets, digest, isClinicTraceJoinFailure, joinNodeTraceLogs, mainClinicDataset, parseCpuProfileFilename, traceEventPids, validateArtifact, validateCpuCaptureArtifacts, nativeWorkerCpuLimitation, validateDoctorProcessStat, validatePrivateDirectory } from './profile-workload.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const repositoryDocs = join(repository, 'docs');
const require = createRequire(import.meta.url);
export const TIMELINE_SCHEMA_VERSION = 1;
export const COMPILER_TOOLS = ['control', 'cpu', 'doctor', 'bubbleprof', 'heapprofiler', '0x', 'flame'] as const;
export type CompilerTool = typeof COMPILER_TOOLS[number];
const CLINIC_TOOLS: readonly CompilerTool[] = ['doctor', 'bubbleprof', 'heapprofiler', 'flame'];
/** Generated trees never belong in a fixture copy; `.lighthouseci` alone can be hundreds of megabytes. */
export const FIXTURE_COPY_EXCLUDES = ['dist', 'node_modules', '.cache', '.lighthouseci', '.git', 'hint-report', 'coverage', 'test-results', 'playwright-report'];

/** One dev-mode source mutation. `helper` edits are authored against the docs Markdown renderer. */
export interface EditTarget { kind: 'page' | 'content' | 'helper'; path: string; outputPath: string }
export const DOCS_EDIT_TARGETS: readonly EditTarget[] = [
  { kind: 'page', path: 'src/pages/index.html', outputPath: 'dist/index.html' },
  { kind: 'content', path: 'content/getting-started.md', outputPath: 'dist/getting-started.html' },
  { kind: 'helper', path: 'src/lib/md-renderer.ts', outputPath: 'dist/getting-started.html' },
];

function projectRelative(path: string, label: string): string {
  const normalized = path.replace(/\\/g, '/');
  assert(!normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..'), `${label} must be a project-relative path without ..`);
  return normalized.replace(/^\.\//, '');
}

/**
 * Clinic parses its own argv with subarg, which turns `[ ... ]` into nested arguments even after `--`.
 * Subject arguments therefore carry the edit plan as base64url JSON, which contains no bracket characters.
 */
export function encodeEditPlan(targets: readonly EditTarget[]): string {
  return Buffer.from(JSON.stringify(targets)).toString('base64url');
}

/** A page edit for any project. The output defaults to the default `src/pages` -> `dist` mapping. */
export function pageEditTarget(page: string, output?: string): EditTarget {
  const path = projectRelative(page, '--edit-page');
  assert(path.endsWith('.html'), '--edit-page must be an .html page');
  const derived = path.startsWith('src/pages/') ? `dist/${path.slice('src/pages/'.length)}` : undefined;
  const outputPath = output === undefined ? derived : projectRelative(output, '--edit-output');
  assert(outputPath, '--edit-output is required when --edit-page is outside src/pages');
  assert(outputPath.endsWith('.html'), '--edit-output must be an .html file');
  return { kind: 'page', path, outputPath };
}

export interface TimelineOptions {
  reportDir: string; rounds: number; modes: ('dev' | 'build')[]; tools: CompilerTool[];
  edits: boolean; workers?: boolean; seedCache?: boolean; compilerDirectory?: string;
  /** Bascik project to copy. Defaults to the repository docs site. */
  source?: string;
  /** BASCIK_SITE_URL for the subject. Defaults to https://bascik.dev for the repository docs site. */
  siteUrl?: string;
  /** Dev edit targets. Defaults to DOCS_EDIT_TARGETS for the repository docs site; required elsewhere. */
  editTargets?: EditTarget[];
  /** How page workers are CPU-profiled for the `cpu` tool. Defaults to auto (see resolveWorkerCpu). */
  workerCpu?: WorkerCpu;
}
export const WORKER_CPU_MODES = ['auto', 'all', 'first', 'none', 'inspector'] as const;
export type WorkerCpu = typeof WORKER_CPU_MODES[number];
export type ResolvedWorkerCpu = Exclude<WorkerCpu, 'auto'>;

/** auto: inherited native --cpu-prof for every worker unless it is known to stall, then main isolate only. */
export function resolveWorkerCpu(mode: WorkerCpu = 'auto', limitation: string | null = nativeWorkerCpuLimitation() ?? null): ResolvedWorkerCpu {
  if (mode !== 'auto') return mode;
  return limitation ? 'none' : 'all';
}

export function parseTimelineArguments(args: string[]): TimelineOptions {
  const { values } = parseArgs({
    args, strict: true,
    options: {
      'report-dir': { type: 'string' }, rounds: { type: 'string', default: '1' },
      modes: { type: 'string', default: 'dev,build' }, tools: { type: 'string', default: 'control' },
      edits: { type: 'boolean', default: false }, workers: { type: 'string' }, 'seed-cache': { type: 'boolean', default: false },
      compiler: { type: 'string' }, source: { type: 'string' }, 'site-url': { type: 'string' },
      'edit-page': { type: 'string' }, 'edit-output': { type: 'string' }, 'worker-cpu': { type: 'string', default: 'auto' },
    }
  });
  const workerCpu = values['worker-cpu'] as WorkerCpu;
  assert((WORKER_CPU_MODES as readonly string[]).includes(workerCpu), 'worker-cpu must be auto, all, first, none, or inspector');
  assert(values['edit-output'] === undefined || values['edit-page'] !== undefined, '--edit-output requires --edit-page');
  const editTargets = values['edit-page'] === undefined ? undefined : [pageEditTarget(values['edit-page'], values['edit-output'])];
  assert(values['report-dir'], '--report-dir is required');
  const tools = values.tools!.split(',') as CompilerTool[];
  const modes = values.modes!.split(',') as ('dev' | 'build')[];
  assert(tools.every(tool => (COMPILER_TOOLS as readonly string[]).includes(tool)), 'unsupported tool');
  assert(modes.every(mode => ['dev', 'build'].includes(mode)), 'unsupported mode');
  assert(values.workers === undefined || ['true', 'false'].includes(values.workers), 'workers must be true or false');
  const rounds = Number(values.rounds);
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, 'rounds must be 1..10');
  return {
    // An explicit edit target implies dev edits.
    reportDir: values['report-dir'], rounds, modes, tools, edits: values.edits! || editTargets !== undefined,
    workers: values.workers === undefined ? undefined : values.workers === 'true',
    seedCache: values['seed-cache'], compilerDirectory: values.compiler, source: values.source, siteUrl: values['site-url'], editTargets, workerCpu,
  };
}

/** The cache directory is real and private, never a symlink into the original project. */
export async function linkDependencies(source: string, target: string, compiler: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.cache' || entry.name === '@bascik') continue;
    await symlink(join(source, entry.name), join(target, entry.name));
  }
  await mkdir(join(target, '@bascik'));
  await symlink(compiler, join(target, '@bascik/bascik'));
}

export async function compilerCommand(tool: CompilerTool, subject: string[], profiles: string): Promise<string[]> {
  if (tool === 'control') return subject;
  if (tool === 'cpu') return [subject[0], '--cpu-prof', `--cpu-prof-dir=${profiles}`, ...subject.slice(1)];
  if (tool === '0x') return [process.execPath, require.resolve('0x/cmd.js'), '--tree-debug', '--output-dir', profiles, '--', ...subject];
  return [process.execPath, require.resolve('clinic/bin.js'), tool, '--collect-only', '--open=false', '--dest', profiles, '--', ...subject];
}

export async function runCompilerTimeline(options: TimelineOptions) {
  const source = resolve(options.source ?? repositoryDocs);
  const isRepositoryDocs = source === resolve(repositoryDocs);
  // Default edit targets and the workers config overlay are authored against the docs site's files and config shape.
  const editTargets = options.edits ? options.editTargets ?? (isRepositoryDocs ? [...DOCS_EDIT_TARGETS] : undefined) : [];
  assert(editTargets, '--edits outside the repository docs site requires --edit-page');
  assert(isRepositoryDocs || options.workers === undefined, '--workers is only supported for the repository docs site');
  const workerCpuLimitation = nativeWorkerCpuLimitation() ?? null;
  const workerCpu = resolveWorkerCpu(options.workerCpu, workerCpuLimitation);
  const cpuLimitation = cpuToolLimitation({ tools: options.tools, workers: options.workers, workerCpu }, workerCpuLimitation);
  assert(!cpuLimitation, cpuLimitation);
  const siteUrl = options.siteUrl ?? (isRepositoryDocs ? 'https://bascik.dev' : undefined);
  const root = await validatePrivateDirectory(options.reportDir, [repository, source]);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await validatePrivateDirectory(root, [repository]);
  assert.equal((await readdir(root)).length, 0, 'report directory must be empty');
  assert(Number.isInteger(options.rounds) && options.rounds >= 1 && options.rounds <= 10, 'rounds must be 1..10');
  const compiler = join(root, 'compiler');
  const inputCompiler = options.compilerDirectory ?? join(repository, 'pkg');
  // Immutable built snapshot, including package.json for config imports and version resolution.
  for (const path of ['dist', 'bin', 'src', 'package.json']) {
    await cp(join(inputCompiler, path), join(compiler, path), { recursive: true });
  }
  await symlink(join(repository, 'node_modules'), join(compiler, 'node_modules'));
  const runs: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  // Dynamic routes make authored page counts a lower bound elsewhere; the docs site has none.
  const expectedPages = isRepositoryDocs ? (await readdir(join(source, 'src/pages'), { recursive: true })).filter(path => path.endsWith('.html')).length : undefined;
  const metadata = {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    runtime: process.versions, platform: process.platform, arch: process.arch, cores: cpus().length,
    options, source, siteUrl: siteUrl ?? null, editTargets, workerCpu, workerCpuLimitation, compilerHash: await distDigest(compiler),
    limitations: ['Application-cache cold, not OS disk cold', 'Subject uses built runCli with explicit shutdown, not bin process exit', 'Profiler overhead is not a benchmark', 'Observer counts cover main isolate only; worker/script-child stacks require separate captures', 'Page workers and script children run without Clinic instrumentation'],
  };
  let complete = false;
  const publish = () => writeFile(join(root, 'timeline-manifest.json'), JSON.stringify({ ...metadata, complete, runs, failures }, null, 2), { mode: 0o600 });
  for (const mode of options.modes) for (const tool of options.tools) for (let round = 1; round <= options.rounds; round++) {
    const fixtureRoot = join(root, `${tool}-${mode}-${round}`);
    const project = join(fixtureRoot, isRepositoryDocs ? 'docs' : basename(source));
    await cp(source, project, { recursive: true, filter: path => !FIXTURE_COPY_EXCLUDES.includes(basename(path)) });
    // Workspace dependencies are hoisted to the repository root for the docs site.
    await linkDependencies(isRepositoryDocs ? join(repository, 'node_modules') : join(source, 'node_modules'), join(project, 'node_modules'), compiler);
    if (isRepositoryDocs) {
      // Docs build scripts read these sibling repository files.
      await cp(join(repository, 'CHANGELOG.md'), join(fixtureRoot, 'CHANGELOG.md'));
      for (const path of ['pkg/test-coverage.json', 'pkg/e2e-test-coverage.json', 'create/test-coverage.json', 'extensions/vscode-bascik/test-coverage.json', 'adapters/cloudflare/test-coverage.json', 'lsp/test-coverage.json']) {
        await mkdir(join(fixtureRoot, path, '..'), { recursive: true });
        await cp(join(repository, path), join(fixtureRoot, path));
      }
    }
    if (options.workers !== undefined) {
      const config = join(project, 'bascik.config.ts');
      await cp(config, join(project, 'bascik.profile-input.ts'));
      await writeFile(config, `import base, {dev as inputDev, build as inputBuild} from './bascik.profile-input.ts';\nexport default base;\nexport const dev = {...inputDev, pipeline: {...base.pipeline, ...inputDev.pipeline, workers: ${options.workers}}};\nexport const build = {...inputBuild, pipeline: {...base.pipeline, ...inputBuild.pipeline, workers: ${options.workers}}};\n`);
    }
    const originalCache = join(source, 'node_modules/.cache/bascik/script-cache');
    if (options.seedCache) {
      await cp(originalCache, join(project, 'node_modules/.cache/bascik/script-cache'), { recursive: true });
    }
    for (const cacheState of options.seedCache ? ['populated', 'warm'] : ['cold', 'warm']) {
      const label = `${tool}-${mode}-${cacheState}-${round}`;
      const directory = join(fixtureRoot, cacheState);
      const profiles = join(directory, 'profiles');
      await mkdir(profiles, { recursive: true, mode: 0o700 });
      const resultPath = join(directory, 'subject.json');
      const subject = [process.execPath, fileURLToPath(new URL('./compiler-timeline-subject.ts', import.meta.url)), compiler, mode, resultPath, encodeEditPlan(editTargets)];
      const command = await compilerCommand(tool, subject, profiles);
      const env = {
        ...(CLINIC_TOOLS.includes(tool) ? clinicEnvironment() : cleanGeneratorEnvironment(process.env)), ...(siteUrl ? { BASCIK_SITE_URL: siteUrl } : {}),
        BASCIK_TIMELINE_WORKER_CPU: workerCpu, BASCIK_TIMELINE_WORKER_PROFILE_DIR: profiles,
      };
      try {
        console.log(`Capturing ${label}`);
        let recoveredJoin: Awaited<ReturnType<typeof recoverBubbleprofTraceJoin>> = undefined;
        try {
          await execute(command, project, join(directory, 'capture'), env);
        } catch (error) {
          recoveredJoin = tool === 'bubbleprof' ? await recoverBubbleprofTraceJoin(directory, project, profiles, resultPath) : undefined;
          if (!recoveredJoin) throw error;
          console.log(`Recovered ${label}: joined ${recoveredJoin.files.length} rotated trace logs after Clinic's join failed`);
        }
        await validateArtifact(resultPath, 'json');
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        const processLog = await readFile(join(directory, 'capture/process.log'), 'utf8');
        // Worker console output is forwarded by Node, not the main console wrapper.
        const bootLog = processLog.split('Server running at')[0];
        result.pages = [...bootLog.matchAll(/^transpiled: (.+) in ([\d.]+)(ms|s)/gm)].map(match => ({ path: match[1], workMs: Number(match[2]) * (match[3] === 's' ? 1000 : 1) }));
        if (expectedPages !== undefined) {
          assert.equal(result.pages.length, expectedPages, 'expected complete current docs workload');
          assert.equal(result.outputs.length, expectedPages, 'expected complete docs output');
        } else assert(result.outputs.length > 0, 'expected emitted HTML output');
        assert(Number.isSafeInteger(result.pid) && result.pid > 0, 'subject did not record its PID');
        const capture: Record<string, unknown> = {};
        const rawArtifacts = await readdir(profiles, { recursive: true });
        if (tool !== 'control') assert(rawArtifacts.length > 0, 'profiler returned no dataset');
        if (CLINIC_TOOLS.includes(tool)) {
          const dataset = recoveredJoin?.dataset ?? mainClinicDataset(processLog, profiles, tool);
          if (recoveredJoin) capture.traceJoin = { recovered: true, files: recoveredJoin.files, bytes: recoveredJoin.bytes };
          assert(basename(dataset).startsWith(`${result.pid}.`), `main Clinic dataset ${basename(dataset)} is not the subject PID ${result.pid}`);
          const descendants = await descendantClinicDatasets(profiles, tool, dataset);
          assert.equal(descendants.length, 0, `instrumented descendants wrote datasets: ${descendants.slice(0, 5).join(', ')}`);
          if (tool === 'doctor' || tool === 'bubbleprof') {
            for (const name of (await readdir(dataset)).filter(name => name.endsWith('traceevent'))) {
              const pids = [...await traceEventPids(join(dataset, name))];
              assert(pids.every(pid => pid === result.pid), `trace events from foreign PIDs: ${pids.filter(pid => pid !== result.pid).slice(0, 5).join(', ')}`);
            }
          }
          if (tool === 'doctor') {
            const statFiles = (await readdir(dataset)).filter(name => name.endsWith('processstat'));
            assert.equal(statFiles.length, 1, 'missing Doctor processstat');
            capture.processStat = validateDoctorProcessStat(await readFile(join(dataset, statFiles[0])), statFiles[0]);
          }
          capture.dataset = dataset;
          await execute([process.execPath, require.resolve('clinic/bin.js'), tool, '--visualize-only', dataset, '--open=false', '--dest', profiles], project, join(directory, 'visualize'), clinicEnvironment());
        }
        if (tool === 'cpu') capture.coverage = await cpuCoverage(profiles, { ...result, workerStarts: result.profiledWorkerStarts ?? result.workerStarts });
        capture.leftoverTraceLogs = (await readdir(project)).filter(name => /^node_trace\.\d+\.log$/.test(name)).length;
        runs.push({ label, tool, mode, cacheState, round, result, profiles, capture });
      } catch (error) {
        failures.push({ label, error: String(error) });
        await publish();
        throw error; // Stop on an invalid control/capture. Never loop through a broken workload.
      }
      await publish();
      // Restore authored inputs only after the bounded subject and its watchers have exited.
      // A warm boot must not accidentally benchmark the preceding edit's mutated source.
      for (const { path } of editTargets) await cp(join(source, path), join(project, path));
    }
  }
  complete = true;
  await publish();
  return { root, runs, failures };
}

/**
 * Clinic Bubbleprof cannot join more than one rotated `node_trace.<n>.log` on Node 24 (see joinNodeTraceLogs).
 * Recover only that failure: the subject must have completed and written its result, and the main dataset must
 * hold its other artifacts. Anything else returns undefined so the original capture error stands.
 */
export async function recoverBubbleprofTraceJoin(directory: string, project: string, profiles: string, resultPath: string) {
  const log = await readFile(join(directory, 'capture/process.log'), 'utf8').catch(() => '');
  if (!isClinicTraceJoinFailure(log)) return undefined;
  const result = await readFile(resultPath, 'utf8').then(text => JSON.parse(text) as { pid?: unknown }, () => undefined);
  if (!result || !Number.isSafeInteger(result.pid)) return undefined;
  const pid = result.pid as number;
  const dataset = join(profiles, `${pid}.clinic-bubbleprof`);
  for (const suffix of ['systeminfo', 'stacktrace']) await validateArtifact(join(dataset, `${pid}.clinic-bubbleprof-${suffix}`), 'binary');
  const joined = await joinNodeTraceLogs(project, join(dataset, `${pid}.clinic-bubbleprof-traceevent`), pid);
  return { dataset, ...joined };
}

/**
 * Native --cpu-prof is inherited by page workers in `all` and `first` modes. Where that is known to stall, refuse
 * before any capture rather than hanging until the subject deadline. `none` and `inspector` remain available.
 */
export function cpuToolLimitation(options: Pick<TimelineOptions, 'tools' | 'workers'> & { workerCpu: ResolvedWorkerCpu }, limitation: string | null = nativeWorkerCpuLimitation() ?? null): string | undefined {
  if (!options.tools.includes('cpu') || options.workers === false || !limitation) return undefined;
  if (options.workerCpu !== 'all' && options.workerCpu !== 'first') return undefined;
  return `${limitation}. Use --worker-cpu none (main isolate only) or --worker-cpu inspector, or --workers false.`;
}

/** Order-independent digest of every file in a compiler snapshot's `dist`. */
export async function distDigest(compiler: string): Promise<string> {
  const files = (await readdir(join(compiler, 'dist'), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  assert(files.length > 0, `compiler snapshot has no dist files: ${compiler}`);
  const lines: string[] = [];
  for (const file of files) lines.push(`${file.slice(join(compiler, 'dist').length + 1)}\0${digest(await readFile(file))}`);
  return digest(lines.join('\n'));
}

/**
 * Native --cpu-prof writes one profile per isolate. The main profile is required; worker coverage is recorded
 * against observed worker starts, and script children are never covered by this tool. Inspector-mode workers
 * write per-task profiles with metadata; each worker thread with at least one such profile counts once.
 */
export async function cpuCoverage(profiles: string, result: { pid: number; workerStarts?: number; childStarts?: number }) {
  const names = await readdir(profiles);
  const files = names.filter(name => name.endsWith('.cpuprofile') || name.endsWith('.metadata.json')).map(name => join(profiles, name));
  await validateCpuCaptureArtifacts(files, result.pid);
  const parsed = files.map(file => parseCpuProfileFilename(basename(file))).filter(entry => entry !== undefined);
  const nativeWorkers = new Set(parsed.filter(entry => entry.pid === result.pid && entry.threadId !== 0).map(entry => entry.threadId));
  const inspectorWorkers = new Set<number>();
  for (const file of files.filter(file => file.endsWith('.metadata.json'))) {
    const entry = JSON.parse(await readFile(file, 'utf8')) as { role?: string; pid?: number; threadId?: number };
    if (entry.role === 'page-worker' && entry.pid === result.pid && typeof entry.threadId === 'number') inspectorWorkers.add(entry.threadId);
  }
  const workerProfiles = new Set([...nativeWorkers, ...inspectorWorkers]).size;
  const workerStarts = result.workerStarts ?? 0;
  return {
    mainProfile: true, workerProfiles, workerStarts, workersComplete: workerProfiles >= workerStarts,
    scriptChildren: result.childStarts ?? 0, scriptChildrenCaptured: 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCompilerTimeline(parseTimelineArguments(process.argv.slice(2)));
}
