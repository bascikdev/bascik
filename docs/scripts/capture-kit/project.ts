/**
 * A throwaway Bascik project for capture scripts: the real starter that `npm create bascik` generates, wired
 * to this repo's own compiler through symlinks, in a temp directory. Capture scripts run the real dev server
 * against it, so what they show is what a new user would see.
 *
 * Nothing here touches `docs/`, so a `yarn docs:dev` that is already running is left alone.
 */
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const bascikBin = join(repoDir, 'pkg/bin/bascik.js');
export const languageServerBin = join(repoDir, 'lsp/dist/bin.js');

export interface StarterProject {
  /** Project root, named like a project a user would create. */
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * Scaffolds the starter with the repo's own `create-bascik` build. Run `yarn workspace create-bascik build`
 * first when the scaffolder changed: this uses `create/dist`.
 */
export async function createStarterProject(name = 'my-site'): Promise<StarterProject> {
  const base = await mkdtemp(join(tmpdir(), 'bascik-demo-'));
  execFileSync(process.execPath, [join(repoDir, 'create/dist/index.js'), name, '-y', '--no-install', '--no-dev'], {
    cwd: base,
    stdio: 'ignore',
  });
  const dir = join(base, name);
  await mkdir(join(dir, 'node_modules/@bascik'), { recursive: true });
  await symlink(join(repoDir, 'pkg'), join(dir, 'node_modules/@bascik/bascik'));
  await symlink(join(repoDir, 'lsp'), join(dir, 'node_modules/@bascik/language-server'));
  return { dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

export interface DevServer {
  url: string;
  stop(): Promise<void>;
}

/** Starts the real dev server and resolves once it reports that it is listening. */
export function startDevServer(projectDir: string, port: number): Promise<DevServer> {
  return new Promise((resolveServer, reject) => {
    const child: ChildProcess = spawn(process.execPath, [bascikBin, '--port', String(port)], {
      cwd: projectDir,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Dev server did not start:\n${output}`)), 30_000);
    const onData = (data: Buffer) => {
      output += data.toString();
      if (output.includes('Server running at')) {
        clearTimeout(timer);
        resolveServer({
          url: `http://localhost:${port}`,
          stop: () =>
            new Promise((done) => {
              child.once('close', () => done());
              child.kill('SIGINT');
            }),
        });
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!output.includes('Server running at')) reject(new Error(`Dev server exited with ${code}:\n${output}`));
    });
  });
}
