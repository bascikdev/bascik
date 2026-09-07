// Exec producer (prompt 109): a watched pre-phase generator.
//
// On every run it increments a persistent generation counter (stored in
// `.generation`), writes `dist/generated.json` (out of src/), and prints the
// generation.
//
// Gated mode (BASCIK_GENERATOR_GATE=1): when an `.armed-gate` marker file is
// present, the run writes its output then HOLDS the child process behind an
// HTTP release server on 127.0.0.1:9777 until a test hits /release. Only a
// test-armed re-exec is gated, so the initial startup pre run (no marker)
// completes normally and the server can boot. The gate is event-driven, not a
// sleep.
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, '..');
const outDir = join(projectRoot, 'dist');
const outFile = join(outDir, 'generated.json');
const marker = join(scriptDir, '.generation');
const armedGate = join(scriptDir, '.armed-gate');

// Persist the counter across runs so tests can assert the exact number of
// startup/reexec executions.
let generation = 0;
if (existsSync(marker)) {
  generation = Number(readFileSync(marker, 'utf8')) || 0;
}
generation += 1;
await writeFile(marker, String(generation));

await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify({ value: `generation-${generation}` }), 'utf8');
console.log(`[generator] wrote generation-${generation} to dist/generated.json`);

// ── Armed HTTP release gate ───────────────────────────────────────────────────
const gated = process.env.BASCIK_GENERATOR_GATE === '1' && existsSync(armedGate);
if (gated) {
  const server = createServer((req, res) => {
    if (req.url === '/release') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ released: generation }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(9777, '127.0.0.1', resolve));
  // Hold this child process until the gate is released via /release.
  await new Promise((resolve) => {
    server.on('request', (req) => {
      if (req.url === '/release') resolve();
    });
  });
  server.close();
}