/**
 * Paired baseline/candidate controls at one private project path.
 *
 * Deterministic instance IDs hash absolute source paths, so emitted HTML is only comparable when both compilers
 * build the same fixture directory. Each build relinks the fixture's `@bascik/bascik` dependency to the compiler
 * under test, so config imports and exec scripts resolve the same snapshot as the compile itself.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { distDigest, encodeEditPlan } from './compiler-timeline.ts';
import { execute } from './profile-runner.ts';
import { cleanGeneratorEnvironment, validatePrivateDirectory } from './profile-workload.ts';

export const COMPARISON_SCHEMA_VERSION = 1;
type BuildName = 'baseline' | 'candidate';
type CacheState = 'cold' | 'warm';
export interface CompareOptions {
  project: string; baseline: string; candidate: string; reportDir: string;
  rounds: number; mode: 'dev' | 'build'; siteUrl?: string;
}

export function parseCompareArguments(args: string[]): CompareOptions {
  const { values } = parseArgs({
    args, strict: true,
    options: {
      project: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' },
      'report-dir': { type: 'string' }, rounds: { type: 'string', default: '3' }, mode: { type: 'string', default: 'build' },
      'site-url': { type: 'string' },
    }
  });
  for (const name of ['project', 'baseline', 'candidate', 'report-dir'] as const) assert(values[name], `--${name} is required`);
  assert(values.mode === 'dev' || values.mode === 'build', 'mode must be dev or build');
  const rounds = Number(values.rounds);
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10, 'rounds must be 1..10');
  return {
    project: values.project!, baseline: values.baseline!, candidate: values.candidate!, reportDir: values['report-dir']!,
    rounds, mode: values.mode, siteUrl: values['site-url'],
  };
}

/** Alternate which build runs first each round so drift (thermal, disk cache, background load) affects both. */
export function pairOrder(round: number): [BuildName, BuildName] {
  return round % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
}

export function summarizeRuns(runs: { name: BuildName; state: CacheState; result: { readyMs: number } }[]) {
  const summary: Record<string, { samples: number[]; median: number; min: number; max: number }> = {};
  for (const name of ['baseline', 'candidate'] as const) for (const state of ['cold', 'warm'] as const) {
    const samples = runs.filter(run => run.name === name && run.state === state).map(run => run.result.readyMs);
    if (!samples.length) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    summary[`${name}-${state}`] = { samples, median, min: sorted[0], max: sorted.at(-1)! };
  }
  return summary;
}

/** Point the fixture's dependency at `compiler`. Refuses to remove anything that is not a symlink. */
export async function relinkCompiler(project: string, compiler: string): Promise<string> {
  const link = join(project, 'node_modules/@bascik/bascik');
  const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  assert(!existing || existing.isSymbolicLink(), `${link} must be a symlink to a compiler snapshot`);
  if (existing) await rm(link);
  await mkdir(join(project, 'node_modules/@bascik'), { recursive: true });
  await symlink(compiler, link);
  const target = await realpath(link);
  assert.equal(target, await realpath(compiler), 'fixture dependency does not resolve the compiler under test');
  return target;
}

async function compilerIdentity(path: string) {
  const compiler = await realpath(path);
  for (const entry of ['dist/index.js', 'bin/bascik.js', 'package.json']) assert((await stat(join(compiler, entry))).isFile(), `compiler snapshot missing ${entry}: ${compiler}`);
  let revision: string | null = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: compiler, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* copied snapshot, not a worktree */ }
  return { path: compiler, distSha256: await distDigest(compiler), revision };
}

export async function runCompilerCompare(options: CompareOptions) {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const root = await validatePrivateDirectory(options.reportDir, [repository]);
  const project = await realpath(options.project);
  const distance = relative(repository, project);
  assert(isAbsolute(distance) || distance === '..' || distance.startsWith('../'), 'project must be private and outside repository');
  assert(!(await lstat(join(project, 'node_modules'))).isSymbolicLink(), 'project cache parent must not be a symlink');
  await mkdir(root, { recursive: true, mode: 0o700 });
  assert.equal((await readdir(root)).length, 0, 'report directory must be empty');
  const compilers = { baseline: await compilerIdentity(options.baseline), candidate: await compilerIdentity(options.candidate) };
  const metadata = {
    schemaVersion: COMPARISON_SCHEMA_VERSION, mode: options.mode, project, rounds: options.rounds, siteUrl: options.siteUrl ?? null,
    compilers, runtime: process.versions, platform: process.platform, arch: process.arch, cores: cpus().length,
    metric: 'readyMs: subject start to runCli resolution',
    limitations: ['Application-cache cold, not OS disk cold', 'Byte identity covers emitted HTML only, not metadata artifacts', 'A warm run reuses the script cache left by the preceding run, which may be the other compiler'],
  };
  const runs: { round: number; state: CacheState; name: BuildName; linkedCompiler: string; result: { readyMs: number; outputs: unknown }; pageMs: number[] }[] = [];
  const failures: { label: string; error: string }[] = [];
  let complete = false;
  let byteIdentical = true;
  const publish = () => writeFile(join(root, 'comparison.json'), JSON.stringify({
    ...metadata, complete, byteIdentical, summary: summarizeRuns(runs), runs, failures,
  }, null, 2), { mode: 0o600 });
  for (let round = 1; round <= options.rounds; round++) for (const state of ['cold', 'warm'] as const) {
    let expected: unknown;
    for (const name of pairOrder(round)) {
      const label = `${round}-${state}-${name}`;
      try {
        if (state === 'cold') await rm(join(project, 'node_modules/.cache'), { recursive: true, force: true });
        const linkedCompiler = await relinkCompiler(project, compilers[name].path);
        const directory = join(root, label);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const resultPath = join(directory, 'subject.json');
        console.log(`Paired ${options.mode} ${label}`);
        await execute([process.execPath, fileURLToPath(new URL('./compiler-timeline-subject.ts', import.meta.url)), compilers[name].path, options.mode, resultPath, encodeEditPlan([])], project, join(directory, 'capture'), {
          ...cleanGeneratorEnvironment(process.env), ...(options.siteUrl ? { BASCIK_SITE_URL: options.siteUrl } : {}),
        });
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        if (expected === undefined) expected = result.outputs;
        else if (!isDeepStrictEqual(result.outputs, expected)) byteIdentical = false;
        const log = await readFile(join(directory, 'capture/process.log'), 'utf8');
        const pageMs = [...log.split('Server running at')[0].matchAll(/^transpiled: (.+) in ([\d.]+)(ms|s)/gm)].map(match => Number(match[2]) * (match[3] === 's' ? 1000 : 1));
        runs.push({ round, state, name, linkedCompiler, result, pageMs });
        await publish();
        assert(byteIdentical, `same-path compiler output changed in ${label}`);
      } catch (error) {
        failures.push({ label, error: String(error) });
        await publish();
        throw error;
      }
    }
  }
  complete = true;
  await publish();
  return { root, byteIdentical, summary: summarizeRuns(runs) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { root, summary } = await runCompilerCompare(parseCompareArguments(process.argv.slice(2)));
  for (const [key, value] of Object.entries(summary)) console.log(`${key}: median ${value.median.toFixed(0)} ms (min ${value.min.toFixed(0)}, max ${value.max.toFixed(0)}, n=${value.samples.length})`);
  console.log(`Comparison: ${join(root, 'comparison.json')}`);
}
