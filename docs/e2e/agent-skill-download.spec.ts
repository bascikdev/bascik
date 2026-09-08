import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = fileURLToPath(new URL('..', import.meta.url));
const pkgIndex = join(docsDir, '../pkg/dist/index.js');
const authored = join(docsDir, 'src/pages/assets/SKILL.md');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  return port;
}

async function download(url: string, attempts: number, signal: AbortSignal): Promise<Response | undefined> {
  for (let attempt = 0; attempt < attempts && !signal.aborted; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status === 200) return response;
    } catch { /* server not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return undefined;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timer);
}

test.describe('Agent skill download', () => {
  test('production server delivers /assets/SKILL.md byte for byte and serves no other Markdown source', async ({ request }) => {
    const source = await readFile(authored);
    const response = await request.get('/assets/SKILL.md');
    expect(response.status()).toBe(200);
    expect(Buffer.from(await response.body()).equals(source)).toBe(true);
    for (const path of ['/content/getting-started.md', '/getting-started.md', '/assets/../content/getting-started.md']) {
      expect((await request.get(path, { maxRedirects: 0 })).status()).not.toBe(200);
    }
  });

  test('live dev server delivers /assets/SKILL.md byte for byte from its lifecycle producer', async () => {
    test.setTimeout(120_000);
    const port = await freePort();
    const child = spawn(process.execPath, [pkgIndex, '--port', String(port)], {
      cwd: docsDir,
      env: { ...process.env, BASCIK_SITE_URL: 'https://bascik.dev' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    child.stdout!.on('data', chunk => output.push(chunk));
    child.stderr!.on('data', chunk => output.push(chunk));
    const controller = new AbortController();
    child.once('exit', () => controller.abort());
    try {
      const response = await download(`http://localhost:${port}/assets/SKILL.md`, 320, controller.signal);
      expect(response, `dev server output:\n${Buffer.concat(output).toString('utf8').slice(-4000)}`).toBeDefined();
      const [source, body] = await Promise.all([readFile(authored), response!.arrayBuffer()]);
      expect(Buffer.from(body).equals(source)).toBe(true);
      const control = await fetch(`http://localhost:${port}/content/getting-started.md`, { redirect: 'manual' });
      expect(control.status).not.toBe(200);
    } finally {
      await stop(child);
    }
  });
});
