#!/usr/bin/env node
/**
 * Collects E2E coverage by running the built Bascik CLI in multiple modes
 * under NODE_V8_COVERAGE, then producing a json-summary report.
 *
 * Steps:
 *   1. --build       (primary transpilation pipeline + sitemap + workers)
 *   2. --help        (help action in index.ts / cli.ts)
 *   3. --version     (readVersion + version action)
 *   4. --check       (checkProject, file-system listPages/listComponents)
 *   5. --build --log (log-path branch, resolveBuildLogPath, tee closures)
 *   6. dev server    (boot → HTTP requests → file-touch watch events → kill)
 *                    Covers mem.ts, pki.ts, http2.ts, server-scripts.ts,
 *                    and processing.ts dev-mode functions
 *   7. --server      (isProdServer=true branches in config.ts; index.ts server action)
 */

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, utimesSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http2 from 'node:http2';

const pkgDir = join(fileURLToPath(import.meta.url), '../..');
const e2eDir = join(pkgDir, 'e2e');
const cli = join(pkgDir, 'dist/index.js');
const covDir = join(pkgDir, 'coverage/e2e');
const repDir = join(pkgDir, 'coverage/e2e-report');
const c8 = join(pkgDir, '..', 'node_modules/.bin/c8');

rmSync(covDir, { recursive: true, force: true });
mkdirSync(covDir, { recursive: true });
mkdirSync(repDir, { recursive: true });

const env = { ...process.env, NODE_V8_COVERAGE: covDir };

const run = (args: string) => {
  try {
    execSync(`node "${cli}" ${args}`, { cwd: e2eDir, env, stdio: 'pipe' });
  } catch { /* non-zero exits still capture coverage */ }
};

console.log('[1/7] --build');
run('--build');

// Create a static CSS file in dist/ so the static-file serving path in http2.ts fires
writeFileSync(join(e2eDir, 'dist/cov-test.css'), '/* bascik coverage */');

// Create a temp page with an unknown component to trigger check.ts error branches
const tempPage = join(e2eDir, 'src/pages/cov-check-temp.html');
writeFileSync(tempPage, '<!DOCTYPE html><html><body><ghost-comp-a></ghost-comp-a><ghost-comp-b></ghost-comp-b></body></html>');

// Run `init` in a throwaway temp dir so initProject() writes its scaffold files
// without touching the e2e fixture. This covers the `init` action branch in index.ts.
const initDir = join(pkgDir, 'coverage/e2e-init-tmp');
rmSync(initDir, { recursive: true, force: true });
mkdirSync(initDir, { recursive: true });
writeFileSync(join(initDir, 'package.json'), '{"name":"cov-init-test"}');
try {
  execSync(`node "${cli}" init`, { cwd: initDir, env, stdio: 'pipe' });
  // Second run: files now exist → covers the "already present, skip" branches in init.ts
  execSync(`node "${cli}" init`, { cwd: initDir, env, stdio: 'pipe' });
} catch { /* any error still captures coverage */ }
rmSync(initDir, { recursive: true, force: true });

console.log('[2/7] --help');
run('--help');

console.log('[3/7] --version');
run('--version');

console.log('[4/7] --check');
run('--check'); // errors expected — covers check.ts error paths and toDisplay

// Remove temp check page immediately after --check so E2E Playwright tests don't see it
if (existsSync(tempPage)) unlinkSync(tempPage);

console.log('[5/7] --build --log');
run(`--build --log "${join(pkgDir, 'coverage/e2e-build.log')}"`);

// ── Step 6: Dev server + HTTP requests + file-touch ──────────────────────────

console.log('[6/7] dev server boot → HTTP requests → watch events');

// HTTP/2 request — bascik's dev server only accepts HTTP/2, not HTTP/1.1
const h2req = (method: string, path: string, port = 9443, extraHeaders: Record<string, string> = {}): Promise<number> => new Promise((resolve) => {
  const client = http2.connect(`https://localhost:${port}`, { rejectUnauthorized: false });
  client.on('error', () => { client.destroy(); resolve(0); });
  const req = client.request({ ':method': method, ':path': path, ...extraHeaders });
  req.on('response', (h) => { req.resume(); resolve(h[':status'] ?? 0); });
  req.on('error', () => resolve(0));
  req.on('end', () => client.close());
  req.setTimeout(4000, () => { req.close(http2.constants.NGHTTP2_CANCEL); resolve(0); });
  req.end();
});

// SSE: connect with referer so mem.trackOpenPage fires, then disconnect after brief delay
const h2sse = (port = 9443): Promise<void> => new Promise((resolve) => {
  const client = http2.connect(`https://localhost:${port}`, { rejectUnauthorized: false });
  client.on('error', () => { client.destroy(); resolve(); });
  const req = client.request({
    ':method': 'GET', ':path': '/bascik-live-reload',
    'referer': `https://localhost:${port}/scope-test`,
  });
  req.on('response', () => { setTimeout(() => { req.close(); client.close(); resolve(); }, 500); });
  req.on('error', () => resolve());
  req.end();
});

await new Promise<void>((resolve) => {
  const devProc = spawn('node', [cli], { cwd: e2eDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let done = false;
  let ready = false;
  const kill = () => { if (!done) { done = true; devProc.kill('SIGTERM'); } };
  const timeout = setTimeout(() => {
    if (!ready) console.warn('  [warn] dev server did not start — run from a normal terminal for full coverage.');
    kill();
  }, 15_000);

  const runRequests = async () => {
    await new Promise(r => setTimeout(r, 400));
    await h2req('GET', '/scope-test');                          // mem.getPage, http2 stream handler
    await h2req('GET', '/');                                     // mem.getPageExact trailing-slash
    await h2req('GET', '/server-scripts-test');                 // server-scripts.ts executeServerScripts
    await h2req('GET', '/nonexistent-xyz');                     // http2 404 page-not-found path
    await h2req('POST', '/scope-test');                          // http2 405 method-not-allowed
    await h2req('HEAD', '/scope-test');                          // http2 HEAD branch
    await h2req('GET', '/cov-test.css');                        // static file serving path
    await h2req('GET', '/missing-file.css');                    // static stat ENOENT → 404
    await h2req('GET', '/../../../etc/shadow.css');             // path traversal → 400
    await h2sse();                                               // mem.trackOpenPage + SSE + untrack
    // Wait for brotli background compression to complete, then request with br encoding
    await new Promise(r => setTimeout(r, 2000));
    await h2req('GET', '/scope-test', 9443, { 'accept-encoding': 'br' }); // brotli branch

    // Touch a component → chokidar → selectivelyProcessPages → pageProcessing
    const comp = join(e2eDir, 'src/components/scope-test/scope-test.html');
    if (existsSync(comp)) { const now = new Date(); utimesSync(comp, now, now); }
    // Touch a page → chokidar → selectivelyProcessPagesForWatchPath
    const page = join(e2eDir, 'src/pages/css-scope-test.html');
    if (existsSync(page)) { const now = new Date(); utimesSync(page, now, now); }
    await new Promise(r => setTimeout(r, 3000)); // let watch events fire + reprocess
    clearTimeout(timeout);
    kill();
  };

  devProc.stdout.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    process.stdout.write(s);
    if (!ready && (s.includes('Server running') || s.includes('https://localhost'))) {
      ready = true;
      runRequests().catch(() => kill());
    }
  });
  devProc.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (!s.includes('SIGTERM') && !s.includes('gracefully')) process.stderr.write(s);
  });
  devProc.on('close', (code: number | null) => {
    clearTimeout(timeout);
    if (!ready) console.warn(`  [warn] dev server exited (code ${code}) before ready.`);
    resolve();
  });
});

// ── Step 7: --server (isProdServer=true branches in config.ts, http2 serve paths) ──

console.log('[7/7] --server + HTTP/2 requests');
await new Promise<void>((resolve) => {
  const serveProc = spawn('node', [cli, '--server'], {
    cwd: e2eDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serveReady = false;
  const timeout = setTimeout(() => serveProc.kill('SIGTERM'), 25_000);

  const serveRequests = async () => {
    await new Promise(r => setTimeout(r, 300));
    // Get the ETag from the first response, then reuse it for a 304 conditional GET
    const etag = await new Promise<string>((res) => {
      const c = http2.connect('https://localhost:9443', { rejectUnauthorized: false });
      c.on('error', () => { c.destroy(); res(''); });
      const r = c.request({ ':method': 'GET', ':path': '/scope-test' });
      r.on('response', (h) => { r.resume(); c.close(); res((h['etag'] as string) ?? ''); });
      r.on('error', () => res(''));
      r.end();
    });
    if (etag) await h2req('GET', '/scope-test', 9443, { 'if-none-match': etag }); // 304 cache hit
    await h2req('GET', '/server-scripts-test');   // server scripts in serve mode
    await h2req('GET', '/bascik-live-reload');     // SSE returns 404 in serve mode
    await h2req('POST', '/scope-test');            // 405 in serve mode
    // Rate-limit flood: 502 requests from the same IP to trigger entry.count > 500 → 429
    for (let i = 0; i < 502; i++) await h2req('GET', '/scope-test');
    clearTimeout(timeout);
    serveProc.kill('SIGTERM');
  };

  serveProc.stdout.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    process.stdout.write(s);
    if (!serveReady && (s.includes('Server running') || s.includes('https://localhost'))) {
      serveReady = true;
      serveRequests().catch(() => serveProc.kill('SIGTERM'));
    }
  });
  serveProc.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (!s.includes('SIGTERM') && !s.includes('gracefully')) process.stderr.write(s);
  });
  serveProc.on('close', () => { clearTimeout(timeout); resolve(); });
});

// ── Report ────────────────────────────────────────────────────────────────────

console.log('\nGenerating coverage report…');
execSync(
  `"${c8}" report --temp-directory "${covDir}" -r json-summary -o "${repDir}"`,
  { cwd: pkgDir, stdio: 'inherit' },
);
const summary = JSON.parse(readFileSync(`${repDir}/coverage-summary.json`, 'utf8'));
const outPath = join(pkgDir, 'e2e-test-coverage.json');
writeFileSync(outPath, JSON.stringify({ total: summary['total'] }, null, 2) + '\n');
console.log('Done → e2e-test-coverage.json');
