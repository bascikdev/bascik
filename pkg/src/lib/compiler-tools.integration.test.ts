import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cleanGeneratorEnvironment } from '../../bench/profile-workload.ts';

const run = promisify(execFile);
const pkg = fileURLToPath(new URL('../../', import.meta.url));
const compare = fileURLToPath(new URL('../../bench/compiler-compare.ts', import.meta.url));
const timeline = fileURLToPath(new URL('../../bench/compiler-timeline.ts', import.meta.url));
const roots: string[] = [];

afterEach(async ({ task }) => {
  const created = roots.splice(0);
  if (task.result?.state === 'fail') {
    for (const root of created) console.error(`Private compiler tool diagnostics retained: ${root}`);
    return;
  }
  await Promise.all(created.map(root => rm(root, { recursive: true, force: true })));
});

/** A tiny private project outside the repository: two pages, one of them with a build script. */
async function tinyProject() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bascik-compiler-tools-')));
  roots.push(root);
  const project = join(root, 'site');
  await mkdir(join(project, 'src/pages'), { recursive: true });
  await mkdir(join(project, 'node_modules'));
  const page = (title: string, body: string) => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;
  await writeFile(join(project, 'src/pages/index.html'), page('Home', '<h1>Home</h1>'));
  await writeFile(join(project, 'src/pages/about.html'), page('About', '<h1>About</h1>\n<script data-bascik-build>export default async function () { return "<p>built at compile time</p>"; }</script>'));
  return { root, project };
}

describe('compiler investigation tools on a tiny project', () => {
  it('pairs one compiler against itself at one path and reports byte-identical, complete results', async () => {
    const { root, project } = await tinyProject();
    const reportDir = join(root, 'compare');
    await run(process.execPath, [compare, '--project', project, '--baseline', pkg, '--candidate', pkg, '--report-dir', reportDir, '--rounds', '1', '--site-url', 'https://example.test'], {
      cwd: pkg, timeout: 150_000, env: cleanGeneratorEnvironment(process.env),
    });
    const comparison = JSON.parse(await readFile(join(reportDir, 'comparison.json'), 'utf8'));
    const compiler = await realpath(pkg);
    expect(comparison).toMatchObject({ schemaVersion: 1, mode: 'build', complete: true, byteIdentical: true, failures: [] });
    expect(comparison.compilers.baseline.distSha256).toBe(comparison.compilers.candidate.distSha256);
    expect(comparison.runs.map((entry: { state: string; name: string }) => `${entry.state}-${entry.name}`))
      .toEqual(['cold-baseline', 'cold-candidate', 'warm-baseline', 'warm-candidate']);
    for (const entry of comparison.runs) {
      expect(entry.linkedCompiler).toBe(compiler);
      expect(entry.result.outputs.map((output: { path: string }) => output.path)).toEqual(['about.html', 'index.html']);
    }
    expect(Object.keys(comparison.summary).sort()).toEqual(['baseline-cold', 'baseline-warm', 'candidate-cold', 'candidate-warm']);
    expect(await readFile(join(project, 'dist/about.html'), 'utf8')).toContain('built at compile time');
  }, 180_000);

  it('records a complete control timeline for build and an explicit dev page edit', async () => {
    const { root, project } = await tinyProject();
    const reportDir = join(root, 'timeline');
    await run(process.execPath, [timeline, '--report-dir', reportDir, '--source', project, '--modes', 'build,dev', '--tools', 'control', '--edit-page', 'src/pages/index.html', '--site-url', 'https://example.test'], {
      cwd: pkg, timeout: 150_000, env: cleanGeneratorEnvironment(process.env),
    });
    const manifest = JSON.parse(await readFile(join(reportDir, 'timeline-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ schemaVersion: 1, complete: true, failures: [], source: project, siteUrl: 'https://example.test' });
    expect(manifest.compilerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.editTargets).toEqual([{ kind: 'page', path: 'src/pages/index.html', outputPath: 'dist/index.html' }]);
    expect(manifest.runs.map((entry: { label: string }) => entry.label)).toEqual(['control-build-cold-1', 'control-build-warm-1', 'control-dev-cold-1', 'control-dev-warm-1']);
    for (const entry of manifest.runs) {
      expect(entry.result.schemaVersion).toBe(1);
      expect(entry.result.outputs.length).toBe(2);
      expect(entry.capture.leftoverTraceLogs).toBe(0);
      // Edits apply only in dev; build runs record none.
      expect(entry.result.edits).toHaveLength(entry.mode === 'dev' ? 1 : 0);
    }
    // The authored source is restored after each edited run.
    expect(await readFile(join(project, 'src/pages/index.html'), 'utf8')).not.toContain('timeline-page-');
  }, 180_000);
});
