import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return port;
}

// Commands run without a shell, so per-site loopback port/host reach a CLI through argument tokens.
export function expandCommand(command, port, host = '127.0.0.1') {
  return command.map((part) => part.replaceAll('{PORT}', String(port)).replaceAll('{HOST}', host));
}

export function launch(command, cwd, env) {
  const child = spawn(command[0], command.slice(1), {
    cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let ended = false;
  const completion = new Promise((accept) => {
    child.once('error', (error) => { ended = true; accept({ error }); });
    child.once('close', (code, signal) => { ended = true; accept({ code, signal }); });
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output = (output + chunk).slice(-16000); });
  }
  const signalGroup = (signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  return {
    child, completion,
    /** The most recent output (stdout and stderr combined). */
    output() {
      return output;
    },
    assertAlive() {
      if (ended) throw new Error(`Process exited before validation: ${output}`);
    },
    async wait(timeoutMs) {
      const result = await Promise.race([
        completion,
        delay(timeoutMs, { timeout: true }, { ref: false }),
      ]);
      if (result.timeout) throw new Error(`Command timed out: ${command.join(' ')}\n${output}`);
      if (result.error || result.code !== 0) {
        throw new Error(`Command failed (${result.code ?? result.error?.message}): ${output}`);
      }
    },
    async stop() {
      signalGroup('SIGTERM');
      const result = await Promise.race([completion, delay(1500, { timeout: true }, { ref: false })]);
      // Also kill descendants after their direct parent exited.
      signalGroup('SIGKILL');
      if (result.timeout) await completion;
    },
  };
}

async function ready(processHandle, url, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    processHandle.assertAlive();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(250) });
      await response.arrayBuffer();
      if (response.ok) {
        processHandle.assertAlive();
        return;
      }
    } catch (error) {
      if (!['TimeoutError', 'TypeError'].includes(error.name)) throw error;
    }
    await delay(25);
  }
  processHandle.assertAlive();
  throw new Error(`Startup timed out: ${url}`);
}

// The callback owns target-specific expectations, not markup or screenshot equality.
export async function runPair({ upstream, bascik, prepare, check, timeoutMs = 10000, observe }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bascik-parity-')));
  const processes = [];
  const sites = {};
  const onSignal = () => controller.abort(new Error('Validation interrupted'));
  const controller = new AbortController();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const ports = new Set();
    for (const [name, spec] of Object.entries({ upstream, bascik })) {
      const cwd = join(directory, name);
      await cp(spec.source, cwd, {
        recursive: true,
        filter: (path) => !['node_modules', 'dist', '_site', '.git', '.upstream'].includes(basename(path)),
      });
      let port;
      do { port = await unusedPort(); } while (ports.has(port));
      ports.add(port);
      const env = { ...process.env, ...spec.env, PORT: String(port), HOST: '127.0.0.1' };
      delete env.NODE_PATH;
      delete env.NODE_OPTIONS;
      const site = { cwd, port, url: `http://127.0.0.1:${port}`, env };
      sites[name] = site;
      if (prepare) await prepare(name, site);
      if (spec.build) {
        const build = launch(expandCommand(spec.build, port), cwd, env);
        processes.push(build);
        await build.wait(timeoutMs);
        await build.stop();
      }
      const server = launch(expandCommand(spec.serve, port), cwd, env);
      processes.push(server);
      site.pid = server.child.pid;
      observe?.({ name, ...site });
      await ready(server, `${site.url}${spec.readyPath ?? '/'}`, timeoutMs, controller.signal);
    }
    const abort = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      if (controller.signal.aborted) reject(controller.signal.reason);
    });
    const exited = processes.filter((handle) => handle.child.pid === sites.upstream.pid ||
      handle.child.pid === sites.bascik.pid).map(async (handle) => {
        await handle.completion;
        throw new Error('Server exited during validation');
      });
    await Promise.race([check(sites, controller.signal), abort, ...exited,
    delay(timeoutMs, undefined, { ref: false }).then(() => { throw new Error('Validation timed out'); })]);
    return { directory, upstream: sites.upstream, bascik: sites.bascik };
  } finally {
    controller.abort(new Error('Validation finished'));
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await Promise.all(processes.map((handle) => handle.stop()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function assertOutsideRepository(directory, repository) {
  const path = resolve(directory);
  const root = resolve(repository);
  if (path === root || path.startsWith(root + sep)) throw new Error('Project is inside the repository');
}