import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

for (const workers of [false, true]) {
  for (const fail of [false, true]) {
    test(`build joins parallel after compilation and post, workers=${workers}, failure=${fail}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'bascik-exec-build-'));
      try {
        await mkdir(join(root, 'src/pages'), { recursive: true });
        await mkdir(join(root, 'src/components'), { recursive: true });
        await writeFile(join(root, 'bascik.config.ts'), `export default {
          generate: { sitemap: false, robots: false },
          pipeline: { workers: ${workers}, exec: [
            { script: 'pre.mjs', phase: 'pre' },
            { script: 'parallel.mjs', phase: 'parallel', timeout: 5000 },
            { script: 'post.mjs', phase: 'post' }
          ] }, minify: { identifiers: false }
        };`);
        await writeFile(join(root, 'pre.mjs'), `import { mkdir, writeFile } from 'node:fs/promises';
          await mkdir('dist', { recursive: true }); await writeFile('dist/pre.json', 'ready');`);
        await writeFile(join(root, 'src/pages/index.html'), `<!DOCTYPE html><html lang="en"><head><title>Phases</title></head><body>
          <p data-testid="pre"><script data-bascik-build>import { readFileSync } from 'node:fs'; console.log(readFileSync('dist/pre.json','utf8'));</script></p>
          </body></html>`);
        await writeFile(join(root, 'post.mjs'), `import { readFile, writeFile } from 'node:fs/promises';
          const html = await readFile('dist/index.html','utf8');
          if (!html.includes('ready')) throw new Error('post ran before compile');
          await writeFile('dist/post.json','done');`);
        await writeFile(join(root, 'parallel.mjs'), `import { watch, existsSync } from 'node:fs';
          import { writeFile } from 'node:fs/promises';
          await new Promise(resolve => {
            const watcher = watch('dist', () => { if (existsSync('dist/post.json')) { watcher.close(); resolve(); } });
            if (existsSync('dist/post.json')) { watcher.close(); resolve(); }
          });
          await writeFile('dist/parallel.json','joined');
          ${fail ? "throw new Error('parallel failure after post');" : ''}`);
        const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [entry, '--build'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; });
          child.stderr.on('data', chunk => { output += chunk; });
          child.on('error', reject);
          child.on('exit', code => resolve({ code, output }));
        });
        expect(await readFile(join(root, 'dist/post.json'), 'utf8').catch(() => result.output)).toBe('done');
        expect(await readFile(join(root, 'dist/parallel.json'), 'utf8')).toBe('joined');
        if (fail) {
          expect(result.code).not.toBe(0);
          expect(result.output).toContain('parallel failure after post');
          expect(result.output).not.toContain('Build complete');
        } else {
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain('Build complete');
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}