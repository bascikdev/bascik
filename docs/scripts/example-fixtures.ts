/**
 * Throwaway Bascik projects for testing the repo-root examples/ folder and the agent skill scripts against the real
 * compiler. Shared by examples.integration.test.ts, skill-monorepo.integration.test.ts, and e2e/examples.spec.ts.
 *
 * Projects live in a temp directory and link node_modules to this repository's packages, so tests never write into
 * examples/ or any package source.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExamplesBundle } from './examples-bundle.ts';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const skillsDir = join(repoRoot, 'skills');
export const examplesDir = join(repoRoot, 'examples');
export const SITE_URL = 'https://example.com';

export interface Workspace {
  /** Temp root; node_modules lives here, so every project below it resolves Bascik. */
  dir: string;
  /** Run a Node script with `cwd` relative to the workspace root. */
  node(cwd: string, args: string[], env?: Record<string, string>): SpawnSyncReturns<string>;
  /** Run the Bascik CLI with `cwd` relative to the workspace root. */
  bascik(cwd: string, args: string[], env?: Record<string, string>): SpawnSyncReturns<string>;
  /** Write a file relative to the workspace root, creating folders. */
  write(path: string, content: string): void;
  remove(): void;
}

/** Combined stdout and stderr, for assertion messages. */
export const output = (result: { stdout: string; stderr: string }): string => `${result.stdout}\n${result.stderr}`;

/** A temp directory with node_modules linked to this repository's Bascik, language server, and marked. */
export function createWorkspace(prefix = 'bascik-examples-'): Workspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, target] of [
    ['@bascik/bascik', 'pkg'],
    ['@bascik/language-server', 'lsp'],
    ['marked', 'node_modules/marked'],
  ]) {
    mkdirSync(dirname(join(dir, 'node_modules', name)), { recursive: true });
    symlinkSync(join(repoRoot, target), join(dir, 'node_modules', name), 'dir');
  }
  const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, args, {
      cwd: join(dir, cwd),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
      timeout: 120_000,
    });
  return {
    dir,
    node: run,
    bascik: (cwd, args, env) => run(cwd, [join(dir, 'node_modules/@bascik/bascik/bin/bascik.js'), ...args], env),
    write: (path, content) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A workspace holding a copy of examples/ (as `components/` and `starter-site/`), so the starter site resolves
 * `../components` exactly as it does in the repository.
 */
export function copyExamples(prefix?: string): Workspace {
  const workspace = createWorkspace(prefix);
  cpSync(examplesDir, workspace.dir, {
    recursive: true,
    filter: (source) => !/[\\/](dist|node_modules)([\\/]|$)/.test(source.slice(examplesDir.length)),
  });
  return workspace;
}

/** Write the examples bundle that the docs publish as /assets/examples.json, and return its path. */
export async function writeExamplesBundle(dir: string): Promise<string> {
  const path = join(dir, 'examples.json');
  writeFileSync(path, JSON.stringify(await createExamplesBundle(examplesDir)));
  return path;
}

/** Build the copied starter site, throwing with the CLI output when the build fails. */
export function buildStarterSite(workspace: Workspace, env: Record<string, string> = {}): void {
  const built = workspace.bascik('starter-site', ['--build'], { BASCIK_SITE_URL: SITE_URL, ...env });
  if (built.status !== 0) throw new Error(`starter-site build failed:\n${output(built)}`);
}
