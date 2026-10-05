/**
 * Real-process coverage for `pipeline.onExecError`.
 *
 * Dev keeps running when an exec script fails (it reports a build-error), and
 * a build stops with exit 1. Either can be flipped by the option, including
 * per mode through the `dev` and `build` config exports. Each case spawns the
 * real CLI in a temporary project so the exit code, the output, and the live
 * server are all observed, not mocked.
 */
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

type Phase = 'pre' | 'post';

interface ProjectOptions {
  /** Body of the `pipeline` object, e.g. `onExecError: 'error'`. */
  policy?: string;
  /** Extra named export for the config, e.g. `export const dev = { ... }`. */
  extraExports?: string;
  phase: Phase;
  /** When true, the script fails on every run until `fail-marker` is removed. */
  failFromStart: boolean;
}

async function makeProject(options: ProjectOptions): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bascik-exec-policy-'));
  await mkdir(join(root, 'src/pages'), { recursive: true });
  await mkdir(join(root, 'src/components'), { recursive: true });
  await mkdir(join(root, 'content'), { recursive: true });
  await writeFile(join(root, 'content/a.md'), 'one\n');
  await writeFile(
    join(root, 'bascik.config.ts'),
    `export default {
      generate: { sitemap: false, robots: false },
      minify: { identifiers: false },
      pipeline: {
        ${options.policy ?? ''}
        exec: [{ script: 'scripts/check.mjs', phase: '${options.phase}', watch: ['content/'] }],
      },
    };
    ${options.extraExports ?? ''}`,
  );
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(
    join(root, 'scripts/check.mjs'),
    `import { existsSync } from 'node:fs';
     if (existsSync('fail-marker')) throw new Error('exec failed on purpose');`,
  );
  if (options.failFromStart) await writeFile(join(root, 'fail-marker'), 'x');
  await writeFile(
    join(root, 'src/pages/index.html'),
    '<!DOCTYPE html><html lang="en"><head><title>Policy</title></head><body><p data-testid="ok">ok</p></body></html>',
  );
  return root;
}

interface Running {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
  stop: () => Promise<void>;
}

function run(root: string, args: string[]): Running {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BASCIK_SITE_URL: 'https://example.com' },
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += chunk; });
  child.stderr?.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolve => {
    child.on('exit', code => resolve(code));
    child.on('error', () => resolve(null));
  });
  return {
    child,
    output: () => output,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function startDev(root: string): Promise<{ proc: Running; url: string }> {
  const port = await freePort();
  const proc = run(root, ['--port', String(port), '--host', '127.0.0.1']);
  return { proc, url: `http://127.0.0.1:${port}` };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Poll until `check` is truthy, or fail early if the process exits first. */
async function until(proc: Running, check: () => boolean | Promise<boolean>, what: string, expectAlive = true): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (expectAlive && (proc.child.exitCode !== null || proc.child.signalCode !== null)) {
      throw new Error(`process exited (${proc.child.exitCode}) while waiting for ${what}\n${proc.output()}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}\n${proc.output()}`);
}

async function waitForReady(proc: Running): Promise<void> {
  await until(proc, () => proc.output().includes('Server running at'), 'the dev server to report ready');
}

/** Collect SSE frames from the live-reload endpoint until stopped. */
async function listen(url: string): Promise<{ frames: () => string; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(`${url}/bascik-live-reload`, { signal: controller.signal });
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch { /* aborted */ }
  })();
  return { frames: () => text, close: () => controller.abort() };
}

const cleanup: Array<() => Promise<void>> = [];
test.afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const track = (proc: Running, root: string) => {
  cleanup.push(async () => { await proc.stop(); await rm(root, { recursive: true, force: true }); });
};

test.describe('dev server (default onExecError is warn)', () => {
  for (const phase of ['pre', 'post'] as const) {
    test(`a ${phase} script that fails at startup is reported and the server keeps serving`, async () => {
      const root = await makeProject({ phase, failFromStart: true });
      const { proc, url } = await startDev(root);
      track(proc, root);

      await waitForReady(proc);
      expect(proc.child.exitCode).toBeNull();
      expect(proc.output()).toContain('exec failed on purpose');
      expect(proc.output()).toContain('pipeline.onExecError');
      const response = await fetch(`${url}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data-testid="ok"');
    });
  }

  test('a failure in a later edit reaches open browsers as a build-error, the server stays up, and a fix recovers', async () => {
    const root = await makeProject({ phase: 'post', failFromStart: false });
    const { proc, url } = await startDev(root);
    track(proc, root);
    await waitForReady(proc);

    const events = await listen(url);
    cleanup.push(async () => events.close());

    // Break the script, then trigger a watched edit.
    await writeFile(join(root, 'fail-marker'), 'x');
    await writeFile(join(root, 'content/a.md'), 'two\n');
    await until(proc, () => events.frames().includes('event: build-error'), 'a build-error frame');
    // The overlay names the failing script and its exit code; the script's own
    // stack trace is a stderr line in the terminal, not part of the frame.
    expect(events.frames()).toContain('scripts/check.mjs');
    expect(events.frames()).toContain('exited with code 1');
    expect(proc.output()).toContain('exec failed on purpose');
    expect(proc.child.exitCode).toBeNull();
    expect((await fetch(`${url}/`)).status).toBe(200);

    // Fix it and edit again: the same session recovers without a restart.
    await rm(join(root, 'fail-marker'));
    const offset = proc.output().length;
    await writeFile(join(root, 'content/a.md'), 'three\n');
    await until(proc, () => proc.output().slice(offset).includes('(completed) exec: scripts/check.mjs'), 'the script to succeed again');
    expect(proc.child.exitCode).toBeNull();
  });
});

test.describe('dev server with onExecError: error', () => {
  for (const phase of ['pre', 'post'] as const) {
    test(`a ${phase} script that fails at startup exits 1`, async () => {
      const root = await makeProject({ phase, failFromStart: true, policy: "onExecError: 'error'," });
      const { proc } = await startDev(root);
      track(proc, root);

      const code = await Promise.race([proc.exited, sleep(30_000).then(() => 'timeout' as const)]);
      expect(code, proc.output()).toBe(1);
      expect(proc.output()).toContain('exec failed on purpose');
    });
  }

  test('a failure in a later edit exits 1 after shutting down', async () => {
    const root = await makeProject({ phase: 'post', failFromStart: false, policy: "onExecError: 'error'," });
    const { proc } = await startDev(root);
    track(proc, root);
    await waitForReady(proc);

    await writeFile(join(root, 'fail-marker'), 'x');
    await writeFile(join(root, 'content/a.md'), 'two\n');
    const code = await Promise.race([proc.exited, sleep(30_000).then(() => 'timeout' as const)]);
    expect(code, proc.output()).toBe(1);
    expect(proc.output()).toContain("pipeline.onExecError is 'error'");
  });

  test('the dev config export sets it for dev only', async () => {
    const root = await makeProject({
      phase: 'post',
      failFromStart: true,
      extraExports: "export const dev = { pipeline: { onExecError: 'error' } };",
    });
    const { proc } = await startDev(root);
    track(proc, root);

    const code = await Promise.race([proc.exited, sleep(30_000).then(() => 'timeout' as const)]);
    expect(code, proc.output()).toBe(1);

    // The same project still builds with the build default: a failure stops it too,
    // proving the export did not change build behavior either way.
    const build = run(root, ['--build']);
    cleanup.push(async () => build.stop());
    expect(await build.exited).toBe(1);
  });
});

test.describe('build (default onExecError is error)', () => {
  for (const phase of ['pre', 'post'] as const) {
    test(`a failing ${phase} script stops the build with exit 1 and never claims success`, async () => {
      const root = await makeProject({ phase, failFromStart: true });
      const build = run(root, ['--build']);
      cleanup.push(async () => { await build.stop(); await rm(root, { recursive: true, force: true }); });

      expect(await build.exited, build.output()).toBe(1);
      expect(build.output()).toContain('exec failed on purpose');
      expect(build.output()).not.toContain('Build complete');
    });
  }

  test('onExecError: warn logs the failure and the build still completes with exit 0', async () => {
    const root = await makeProject({ phase: 'post', failFromStart: true, policy: "onExecError: 'warn'," });
    const build = run(root, ['--build']);
    cleanup.push(async () => { await build.stop(); await rm(root, { recursive: true, force: true }); });

    expect(await build.exited, build.output()).toBe(0);
    expect(build.output()).toContain('exec failed on purpose');
    expect(build.output()).toContain("pipeline.onExecError is 'warn'");
    expect(build.output()).toContain('Build complete');
  });

  test('the build config export can make a build tolerate failures while dev keeps its default', async () => {
    const root = await makeProject({
      phase: 'post',
      failFromStart: true,
      extraExports: "export const build = { pipeline: { onExecError: 'warn' } };",
    });
    const build = run(root, ['--build']);
    cleanup.push(async () => { await build.stop(); await rm(root, { recursive: true, force: true }); });
    expect(await build.exited, build.output()).toBe(0);

    const { proc } = await startDev(root);
    track(proc, root);
    await waitForReady(proc);
    expect(proc.child.exitCode).toBeNull();
  });
});
