import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DISCOVERY_SCHEMA, collectSkillFiles, listSkillNames, readTar } from '../scripts/skill-bundle.ts';

const docsDir = fileURLToPath(new URL('..', import.meta.url));
const pkgIndex = join(docsDir, '../pkg/dist/index.js');
const skillsDir = join(docsDir, '../skills');
const authored = join(skillsDir, 'bascik/SKILL.md');

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

  test('production server delivers /assets/skills.tar.gz with every skill file byte for byte', async ({ request }) => {
    const response = await request.get('/assets/skills.tar.gz');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('gzip');
    // `curl ... | tar -xz` needs the gzip bytes themselves, never a transfer-decoded body.
    expect(response.headers()['content-encoding'] ?? 'identity').toBe('identity');
    const files = readTar(gunzipSync(await response.body()));
    const sources = await collectSkillFiles(skillsDir);
    expect([...files.keys()]).toEqual(sources.map(file => file.path));
    for (const source of sources) expect(files.get(source.path)?.equals(source.data), source.path).toBe(true);
  });

  test('production server publishes /.well-known/agent-skills/ for `npx skills add https://bascik.dev`', async ({ request }) => {
    const indexResponse = await request.get('/.well-known/agent-skills/index.json');
    expect(indexResponse.status()).toBe(200);
    expect(indexResponse.headers()['content-type']).toContain('application/json');
    const index = await indexResponse.json();
    expect(index.$schema).toBe(DISCOVERY_SCHEMA);
    expect(index.skills.map((skill: { name: string }) => skill.name)).toEqual(await listSkillNames(skillsDir));
    for (const entry of index.skills) {
      // Resolve the way the skills CLI does: relative to the index URL.
      const artifact = await request.get(new URL(entry.url, 'http://x/.well-known/agent-skills/index.json').pathname);
      expect(artifact.status(), entry.url).toBe(200);
      expect(artifact.headers()['content-encoding'] ?? 'identity').toBe('identity');
      const bytes = await artifact.body();
      expect(entry.digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
      const skillMd = readTar(gunzipSync(bytes)).get('SKILL.md');
      expect(skillMd?.equals(await readFile(join(skillsDir, entry.name, 'SKILL.md'))), entry.name).toBe(true);
    }
    for (const hidden of ['/.bascik/manifest.json', '/.well-known/.env', '/assets/.well-known/agent-skills/index.json']) {
      expect((await request.get(hidden)).status(), hidden).toBe(404);
    }
  });

  test('live dev server delivers /assets/SKILL.md byte for byte from its lifecycle producer', async ({ request }) => {
    test.setTimeout(120_000);
    const searchIndexPath = join(docsDir, 'dist/assets/search-index.json');
    const llmsTxtPath = join(docsDir, 'dist/llms.txt');

    const [preSearch, preLlms, preSearchBytes, preLlmsBytes] = await Promise.all([
      request.get('/assets/search-index.json'),
      request.get('/llms.txt'),
      readFile(searchIndexPath),
      readFile(llmsTxtPath),
    ]);
    expect(preSearch.status()).toBe(200);
    expect(preLlms.status()).toBe(200);

    let tmpDir: string | undefined;
    let child: ChildProcess | undefined;

    try {
      tmpDir = await mkdtemp(join(docsDir, '.dist-dev-'));
      const tmpConfigFile = join(tmpDir, 'bascik.config.ts');
      const docsConfigFileUrl = pathToFileURL(join(docsDir, 'bascik.config.ts')).href;
      const isolatedDistDir = join(tmpDir, 'dist');

      const configContent = `import base, { dev, build } from ${JSON.stringify(docsConfigFileUrl)};
export default { ...base, directory: { ...base.directory, out: ${JSON.stringify(isolatedDistDir)} } };
export { dev, build };
`;
      await writeFile(tmpConfigFile, configContent, 'utf8');

      const port = await freePort();
      const output: Buffer[] = [];
      let spawnError: Error | undefined;

      child = spawn(process.execPath, [pkgIndex, '--port', String(port), '--config', tmpConfigFile], {
        cwd: docsDir,
        env: { ...process.env, BASCIK_SITE_URL: 'https://bascik.dev' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout!.on('data', chunk => output.push(chunk));
      child.stderr!.on('data', chunk => output.push(chunk));
      child.on('error', err => {
        spawnError = err;
      });

      const controller = new AbortController();
      child.once('exit', () => controller.abort());

      const response = await download(`http://localhost:${port}/assets/SKILL.md`, 320, controller.signal);
      if (spawnError) {
        throw new Error(`dev server process failed to spawn: ${spawnError.message}`, { cause: spawnError });
      }
      expect(response, `dev server output:\n${Buffer.concat(output).toString('utf8').slice(-4000)}`).toBeDefined();

      const [source, body] = await Promise.all([readFile(authored), response!.arrayBuffer()]);
      expect(Buffer.from(body).equals(source)).toBe(true);
      const control = await fetch(`http://localhost:${port}/content/getting-started.md`, { redirect: 'manual' });
      expect(control.status).not.toBe(200);

      const [postSearch, postLlms, postSearchBytes, postLlmsBytes] = await Promise.all([
        request.get('/assets/search-index.json'),
        request.get('/llms.txt'),
        readFile(searchIndexPath),
        readFile(llmsTxtPath),
      ]);
      expect(postSearch.status()).toBe(200);
      expect(postLlms.status()).toBe(200);
      expect(postSearchBytes.equals(preSearchBytes)).toBe(true);
      expect(postLlmsBytes.equals(preLlmsBytes)).toBe(true);
    } finally {
      let stopError: unknown;
      if (child) {
        try {
          await stop(child);
        } catch (err) {
          stopError = err;
        }
      }
      if (tmpDir) {
        try {
          await rm(tmpDir, { recursive: true, force: true });
        } catch (rmErr) {
          if (!stopError) stopError = rmErr;
        }
      }
      if (stopError) {
        throw stopError;
      }
    }
  });
});
