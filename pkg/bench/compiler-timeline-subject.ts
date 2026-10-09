/** Runs only in private copied docs, inside the runner's bounded owned process group. */
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import type { WorkerOptions } from 'node:worker_threads';
import { digest, profilerFreeEnvironment } from './profile-workload.ts';

// Bump when subject.json fields change meaning. This module is a process entry point and is never imported.
const SUBJECT_SCHEMA_VERSION = 1;

const [compiler, mode, resultPath, editFlag] = process.argv.slice(2);
assert(['dev', 'build'].includes(mode));
process.argv = [process.execPath, join(compiler, 'bin/bascik.js'), ...(mode === 'build' ? ['--build'] : [])];
// Reuse docs authoring/config without TLS setup or conflicts with existing servers.
const reservation = net.createServer();
await new Promise<void>((resolveReady, reject) => { reservation.once('error', reject); reservation.listen(0, 'localhost', resolveReady); });
process.env.BASCIK_SERVER_PORT = String((reservation.address() as net.AddressInfo).port);
await new Promise<void>((resolveClosed, reject) => reservation.close(error => error ? reject(error) : resolveClosed()));
process.env.BASCIK_ENABLE_TLS = 'false';
delete process.env.BASCIK_BUILD;
delete process.env.BASCIK_SERVER;
const require = createRequire(import.meta.url);
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const children = require('node:child_process') as typeof import('node:child_process');
const operations: Record<string, { count: number; elapsedMs: number }> = {};
for (const name of ['readFile', 'stat', 'readdir'] as const) {
  const original = fs[name];
  Object.assign(fs, {
    [name]: new Proxy(original, {
      apply(target, receiver, args) {
        const start = performance.now();
        const metric = operations[name] ??= { count: 0, elapsedMs: 0 };
        metric.count++;
        return Promise.resolve(Reflect.apply(target, receiver, args)).finally(() => { metric.elapsedMs += performance.now() - start; });
      }
    })
  });
}
let childStarts = 0;
children.execFile = new Proxy(children.execFile, {
  apply(target, receiver, args) {
    childStarts++;
    // execFile(file[, args][, options][, callback]): profiler preloads must not reach script children.
    const index = Array.isArray(args[1]) ? 2 : 1;
    const options = args[index];
    if (options && typeof options === 'object') args[index] = { ...options, env: profilerFreeEnvironment((options as { env?: NodeJS.ProcessEnv }).env ?? process.env) };
    else args.splice(index, 0, { env: profilerFreeEnvironment(process.env) });
    return Reflect.apply(target, receiver, args);
  }
});
// A Worker parses NODE_OPTIONS from its env, so without an explicit env every page worker would load the
// profiler's sampler under the main PID and write into the main dataset. execArgv is untouched: --cpu-prof
// remains inherited through WorkerPool's execArgv for the `cpu` tool.
const threads = require('node:worker_threads') as typeof import('node:worker_threads');
const OriginalWorker = threads.Worker;
let workerStarts = 0;
threads.Worker = class extends OriginalWorker {
  constructor(filename: string | URL, options: WorkerOptions = {}) {
    assert(typeof options.env !== 'symbol', 'SHARE_ENV workers cannot be isolated from profiler instrumentation');
    super(filename, { ...options, env: profilerFreeEnvironment((options.env as NodeJS.ProcessEnv | undefined) ?? process.env) });
    workerStarts++;
  }
};
syncBuiltinESMExports();
const pages: { path: string; workMs: number; atMs: number }[] = [];
const log = console.log.bind(console);
let batchMs: number | undefined;
const start = performance.now();
const cpuStart = process.cpuUsage();
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const milliseconds = (value: string, unit: string) => Number(value) * (unit === 's' ? 1000 : 1);
console.log = (...args: unknown[]) => {
  const line = args.join(' ');
  const page = /^transpiled: (.+) in ([\d.]+)(ms|s)/.exec(line);
  if (page) pages.push({ path: page[1], workMs: milliseconds(page[2], page[3]), atMs: performance.now() - start });
  const batch = /✓ \d+ pages? transpiled in ([\d.]+)(ms|s)/.exec(line);
  if (batch) batchMs = milliseconds(batch[1], batch[2]);
  log(...args);
};
const load = (path: string) => import(pathToFileURL(join(compiler, 'dist', path)).href);
const { runCli } = await load('index.js');
const importMs = performance.now() - start;
await runCli(mode === 'build' ? ['--build'] : [], { exitOnFinish: false });
const readyMs = performance.now() - start;
const { pageWriteIdle } = await load('lib/processing.js');
for (const page of pages) await pageWriteIdle(resolve('src', page.path));
const bootPages = [...pages];
const edits: object[] = [];
if (mode === 'dev' && editFlag === 'true') {
  // Visible markers survive Markdown and HTML minification; a comment-only edit is not a content oracle.
  for (const [kind, path] of [['page', 'src/pages/index.html'], ['content', 'content/getting-started.md'], ['helper', 'src/lib/md-renderer.ts']] as const) {
    const before = pages.length;
    const source = await readFile(path, 'utf8');
    const marker = `timeline-${kind}-${Date.now()}`;
    const outputPath = kind === 'page' ? 'dist/index.html' : 'dist/getting-started.html';
    const changed = kind === 'page' ? source.replace('</body>', `<p>${marker}</p></body>`)
      : kind === 'content' ? `${source}\n\n${marker}\n`
        : source.replace("let html = marked.parse(md, { async: false });", `let html = marked.parse(md, { async: false }); html += '<p>${marker}</p>';`);
    assert.notEqual(changed, source, `mutation did not match ${path}`);
    const { eventEmitter } = await load('lib/events.js');
    // Source cycles publish only after compilation, queued disk writes, and post producers settle.
    let published = false;
    const publication = () => { published = true; };
    eventEmitter.once('transpiled', publication);
    const begin = performance.now();
    await writeFile(path, changed);
    const deadline = begin + 60_000;
    let html = '';
    while (performance.now() < deadline) {
      html = await readFile(outputPath, 'utf8').catch(() => '');
      if (published && html.includes(marker) && html.includes('</html>')) break;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    assert(html.includes(marker), `${kind} edit did not reach complete disk output`);
    assert(published, `${kind} edit did not publish a successful source cycle`);
    eventEmitter.removeListener('transpiled', publication);
    const diskMs = performance.now() - begin;
    // Do not start the next edit while a broad dependent-page cycle is still active.
    const { pageWriteIdle: idle } = await load('lib/processing.js');
    for (const page of pages.slice(before)) await idle(resolve('src', page.path));
    edits.push({ kind, path, diskMs, observedPages: pages.slice(before), digest: digest(html), eventListeners: eventEmitter.listenerCount('transpiled') });
  }
}
const outputs: object[] = [];
for (const path of (await readdir('dist', { recursive: true })).filter(path => path.endsWith('.html')).sort()) {
  const html = await readFile(join('dist', path));
  assert(html.includes(Buffer.from('</html>')), `incomplete page ${path}`);
  outputs.push({ path, bytes: html.length, sha256: digest(html) });
}
if (mode === 'build') {
  const { runShutdownHandlers } = await load('lib/events.js');
  await runShutdownHandlers();
}
delay.disable();
await writeFile(resultPath, JSON.stringify({
  schemaVersion: SUBJECT_SCHEMA_VERSION, pid: process.pid, workerStarts,
  mode, importMs, readyMs, batchMs, totalMs: performance.now() - start,
  pages: bootPages, outputs, edits, operations, childStarts, cpu: process.cpuUsage(cpuStart), memory: process.memoryUsage(),
  eventLoopP95Ms: delay.count ? delay.percentile(95) / 1e6 : null,
  limitations: ['Filesystem elapsed sums include async overlap, not CPU time', 'Counts exclude worker isolates', 'Edits observed at disk output, not browser refresh'],
}, null, 2), { mode: 0o600 });
// The server's signal owner closes its listening socket as well as registered resources.
// Calling only runShutdownHandlers leaves the listening HTTP server alive.
if (mode === 'dev') process.kill(process.pid, 'SIGTERM');
