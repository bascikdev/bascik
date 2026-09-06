// Exec producer (prompt 137): a `phase: 'parallel'` generator.
//
// It writes `dist/parallel.json` (out of src/) and, in dev, runs ALONGSIDE the
// dev server instead of blocking boot. It always holds behind an HTTP release
// gate on 127.0.0.1:9778 until a test hits /release, so the test can prove the
// server was already serving while this entry was still running, and that the
// generated value is published exactly once after release. The gate is
// event-driven, not a sleep.
//
// In build mode (BASCIK_BUILD=1) or when BASCIK_PARALLEL_GATE is not set, the
// script completes immediately so the static build and the other dev-exec
// configurations are unaffected.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, '..');
const outDir = join(projectRoot, 'dist');
const outFile = join(outDir, 'parallel.json');

const gated = process.env.BASCIK_PARALLEL_GATE === '1' && process.env.BASCIK_BUILD !== '1';

if (gated) {
  // Hold BEFORE writing so the consumer page can only ever observe the
  // generated value after the gate is released.
  const server = createServer((req, res) => {
    if (req.url === '/release') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ released: true }));
    } else if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ running: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(9778, '127.0.0.1', resolve));
  await new Promise((resolve) => {
    server.on('request', (req) => {
      if (req.url === '/release') resolve();
    });
  });
  server.close();
}

await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify({ value: `parallel-${process.pid}` }), 'utf8');
console.log(`[parallel-generator] wrote parallel-${process.pid} to dist/parallel.json`);
