/** Private real-docs controls. Run with --report-dir <new absolute directory>. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execute, clinicEnvironment } from './profile-runner.ts';
import { cleanGeneratorEnvironment, digest, validateArtifact, validatePrivateDirectory } from './profile-workload.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
export type CompilerTool = 'control' | 'cpu' | 'doctor' | 'bubbleprof' | 'heapprofiler' | '0x' | 'flame';

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

export async function runCompilerTimeline(options: {
  reportDir: string; rounds: number; modes: ('dev' | 'build')[]; tools: CompilerTool[];
  edits: boolean; workers?: boolean; seedCache?: boolean; compilerDirectory?: string;
}) {
  const root = await validatePrivateDirectory(options.reportDir, [repository]);
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
  const expectedPages = (await readdir(join(repository, 'docs/src/pages'), { recursive: true })).filter(path => path.endsWith('.html')).length;
  const metadata = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    runtime: process.versions, platform: process.platform, cores: cpus().length,
    options, compilerHash: digest(await readFile(join(compiler, 'dist/lib/processing.js'))),
    limitations: ['Application-cache cold, not OS disk cold', 'Real-docs subject uses built runCli with explicit shutdown, not bin process exit', 'Profiler overhead is not a benchmark', 'Observer counts cover main isolate only; worker/script-child stacks require separate captures'],
  };
  const publish = () => writeFile(join(root, 'timeline-manifest.json'), JSON.stringify({ ...metadata, runs, failures }, null, 2), { mode: 0o600 });
  for (const mode of options.modes) for (const tool of options.tools) for (let round = 1; round <= options.rounds; round++) {
    const fixtureRoot = join(root, `${tool}-${mode}-${round}`);
    const project = join(fixtureRoot, 'docs');
    await cp(join(repository, 'docs'), project, {
      recursive: true, filter: path => !['dist', 'node_modules', '.cache', '.lighthouseci', '.git', 'hint-report', 'coverage', 'test-results', 'playwright-report'].includes(basename(path)),
    });
    await linkDependencies(join(repository, 'node_modules'), join(project, 'node_modules'), compiler);
    await cp(join(repository, 'CHANGELOG.md'), join(fixtureRoot, 'CHANGELOG.md'));
    for (const path of ['pkg/test-coverage.json', 'pkg/e2e-test-coverage.json', 'create/test-coverage.json', 'extensions/vscode-bascik/test-coverage.json', 'adapters/cloudflare/test-coverage.json', 'lsp/test-coverage.json']) {
      await mkdir(join(fixtureRoot, path, '..'), { recursive: true });
      await cp(join(repository, path), join(fixtureRoot, path));
    }
    if (options.workers !== undefined) {
      const config = join(project, 'bascik.config.ts');
      await cp(config, join(project, 'bascik.profile-input.ts'));
      await writeFile(config, `import base, {dev as inputDev, build as inputBuild} from './bascik.profile-input.ts';\nexport default base;\nexport const dev = {...inputDev, pipeline: {...base.pipeline, ...inputDev.pipeline, workers: ${options.workers}}};\nexport const build = {...inputBuild, pipeline: {...base.pipeline, ...inputBuild.pipeline, workers: ${options.workers}}};\n`);
    }
    const originalCache = join(repository, 'docs/node_modules/.cache/bascik/script-cache');
    if (options.seedCache) {
      await cp(originalCache, join(project, 'node_modules/.cache/bascik/script-cache'), { recursive: true });
    }
    for (const cacheState of options.seedCache ? ['populated', 'warm'] : ['cold', 'warm']) {
      const label = `${tool}-${mode}-${cacheState}-${round}`;
      const directory = join(fixtureRoot, cacheState);
      const profiles = join(directory, 'profiles');
      await mkdir(profiles, { recursive: true, mode: 0o700 });
      const resultPath = join(directory, 'subject.json');
      const subject = [process.execPath, fileURLToPath(new URL('./compiler-timeline-subject.ts', import.meta.url)), compiler, mode, resultPath, String(options.edits)];
      const command = await compilerCommand(tool, subject, profiles);
      const env = { ...(tool === 'control' || tool === 'cpu' || tool === '0x' ? cleanGeneratorEnvironment(process.env) : clinicEnvironment()), BASCIK_SITE_URL: 'https://bascik.dev' };
      try {
        console.log(`Capturing ${label}`);
        await execute(command, project, join(directory, 'capture'), env);
        await validateArtifact(resultPath, 'json');
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        const processLog = await readFile(join(directory, 'capture/process.log'), 'utf8');
        // Worker console output is forwarded by Node, not the main console wrapper.
        const bootLog = processLog.split('Server running at')[0];
        result.pages = [...bootLog.matchAll(/^transpiled: (.+) in ([\d.]+)(ms|s)/gm)].map(match => ({ path: match[1], workMs: Number(match[2]) * (match[3] === 's' ? 1000 : 1) }));
        assert.equal(result.pages.length, expectedPages, 'expected complete current docs workload');
        assert.equal(result.outputs.length, expectedPages, 'expected complete docs output');
        const rawArtifacts = await readdir(profiles, { recursive: true });
        if (tool !== 'control') assert(rawArtifacts.length > 0, 'profiler returned no dataset');
        const dataset = /Output file is (.+)/.exec(processLog)?.[1]?.trim();
        if (['doctor', 'bubbleprof', 'heapprofiler', 'flame'].includes(tool)) {
          assert(dataset && dataset.startsWith(profiles + '/'), 'missing owned main Clinic dataset');
          await execute([process.execPath, require.resolve('clinic/bin.js'), tool, '--visualize-only', dataset, '--open=false', '--dest', profiles], project, join(directory, 'visualize'), clinicEnvironment());
        }
        runs.push({ label, tool, mode, cacheState, round, result, profiles });
      } catch (error) {
        failures.push({ label, error: String(error) });
        await publish();
        throw error; // Stop on an invalid control/capture. Never loop through a broken workload.
      }
      await publish();
      // Restore authored inputs only after the bounded subject and its watchers have exited.
      // A warm boot must not accidentally benchmark the preceding edit's mutated source.
      if (options.edits) for (const path of ['src/pages/index.html', 'content/getting-started.md', 'src/lib/md-renderer.ts']) {
        await cp(join(repository, 'docs', path), join(project, path));
      }
    }
  }
  return { root, runs, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'report-dir': { type: 'string' }, rounds: { type: 'string', default: '1' },
      modes: { type: 'string', default: 'dev,build' }, tools: { type: 'string', default: 'control' },
      edits: { type: 'boolean', default: false }, workers: { type: 'string' }, 'seed-cache': { type: 'boolean', default: false }, compiler: { type: 'string' },
    }
  });
  assert(values['report-dir'], '--report-dir is required');
  const tools = values.tools!.split(',') as CompilerTool[];
  const modes = values.modes!.split(',') as ('dev' | 'build')[];
  assert(tools.every(tool => ['control', 'cpu', 'doctor', 'bubbleprof', 'heapprofiler', '0x', 'flame'].includes(tool)), 'unsupported tool');
  assert(modes.every(mode => ['dev', 'build'].includes(mode)), 'unsupported mode');
  assert(values.workers === undefined || ['true', 'false'].includes(values.workers), 'workers must be true or false');
  await runCompilerTimeline({ reportDir: values['report-dir'], rounds: Number(values.rounds), modes, tools, edits: values.edits!, workers: values.workers === undefined ? undefined : values.workers === 'true', seedCache: values['seed-cache'], compilerDirectory: values.compiler });
}
