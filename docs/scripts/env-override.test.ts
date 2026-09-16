import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const scriptsDir = join(docsDir, 'scripts');

function runNodeScript(scriptRelativePath: string, customOutDir: string): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(scriptsDir, scriptRelativePath)], {
      cwd: docsDir,
      env: {
        ...process.env,
        BASCIK_OUT_DIR: customOutDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', chunk => stdoutChunks.push(chunk));
    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    child.on('error', rej);
    child.on('close', (code, signal) => {
      res({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
        signal,
      });
    });
  });
}

describe('docs scripts BASCIK_OUT_DIR environment override', () => {
  let isolatedOut: string;

  beforeEach(async () => {
    isolatedOut = await mkdtemp(join(tmpdir(), 'bascik-docs-script-out-'));
  });

  afterEach(async () => {
    await rm(isolatedOut, { recursive: true, force: true });
  });

  it('publish-agent-skill writes only to BASCIK_OUT_DIR without mutating source directories', async () => {
    const srcSkillPath = join(docsDir, 'src/pages/assets/SKILL.md');
    const beforeStat = await stat(srcSkillPath);

    const res = await runNodeScript('publish-agent-skill.ts', isolatedOut);
    expect(res.signal).toBeNull();
    expect(res.code).toBe(0);

    const destSkillPath = join(isolatedOut, 'assets/SKILL.md');
    const [sourceContent, isolatedContent] = await Promise.all([
      readFile(srcSkillPath),
      readFile(destSkillPath),
    ]);
    expect(isolatedContent.equals(sourceContent)).toBe(true);

    const afterStat = await stat(srcSkillPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    // Verify no unexpected root artifacts in isolatedOut
    const isolatedEntries = await readdir(isolatedOut);
    expect(isolatedEntries).toEqual(['assets']);
  });

  it('generate-search-index writes only to BASCIK_OUT_DIR without mutating source directories', async () => {
    const contentDir = join(docsDir, 'content');
    const beforeContent = await readdir(contentDir);

    const res = await runNodeScript('generate-search-index.ts', isolatedOut);
    expect(res.signal).toBeNull();
    expect(res.code).toBe(0);

    const destIndexPath = join(isolatedOut, 'assets/search-index.json');
    const indexRaw = await readFile(destIndexPath, 'utf8');
    const parsed = JSON.parse(indexRaw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const afterContent = await readdir(contentDir);
    expect(afterContent).toEqual(beforeContent);
  });

  it('generate-llms-txt writes only to BASCIK_OUT_DIR without mutating source directories', async () => {
    const res = await runNodeScript('generate-llms-txt.ts', isolatedOut);
    expect(res.signal).toBeNull();
    expect(res.code).toBe(0);

    const destLlmsPath = join(isolatedOut, 'llms.txt');
    const llmsRaw = await readFile(destLlmsPath, 'utf8');
    expect(llmsRaw).toContain('# Bascik');

    const isolatedEntries = await readdir(isolatedOut);
    expect(isolatedEntries).toContain('llms.txt');
  });

  it('generate-og-images writes only to BASCIK_OUT_DIR without mutating source directories', async () => {
    const res = await runNodeScript('generate-og-images.ts', isolatedOut);
    expect(res.signal).toBeNull();
    expect(res.code).toBe(0);

    const ogDir = join(isolatedOut, 'assets', 'og');
    const ogEntries = await readdir(ogDir);
    expect(ogEntries.length).toBeGreaterThan(0);
    expect(ogEntries).toContain('home.jpg');

    const homeJpg = await readFile(join(ogDir, 'home.jpg'));
    expect(homeJpg.length).toBeGreaterThan(0);
    expect(homeJpg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const isolatedAssets = await readdir(join(isolatedOut, 'assets'));
    expect(isolatedAssets).toEqual(['og']);
  }, 30000);
});
