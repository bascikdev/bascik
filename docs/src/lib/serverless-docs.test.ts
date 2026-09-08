/**
 * Prompt 136: the serverless documentation says only what the adapter does.
 *
 * Two kinds of checks:
 * 1. Claims: no page may present handlers as unconditionally portable or list
 *    hosts as if an adapter existed for them; the static-hosting condition
 *    names every request-time feature.
 * 2. Behavior: the commands and code the Cloudflare guide shows are checked
 *    against the shipped CLI parser and the adapter's real context shape, so
 *    the guide cannot drift from the implementation.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NAV } from './nav.ts';

const DOCS_ROOT = path.resolve(import.meta.dirname, '../..');
const PKG_LIB_ROOT = path.resolve(DOCS_ROOT, '../pkg/src/lib');
const importPkgModule = (file: string): Promise<unknown> => import(pathToFileURL(path.join(PKG_LIB_ROOT, file)).href);
const { resolveCliAction, DEPLOY_TARGETS } = (await importPkgModule('cli.ts')) as {
  resolveCliAction: (args: string[]) => { action: string; flags: { target?: string } };
  DEPLOY_TARGETS: readonly string[];
};
const { CLOUDFLARE_COMPATIBILITY_DATE, CLOUDFLARE_COMPATIBILITY_FLAGS } = (await importPkgModule(
  'serverless-artifacts.ts',
)) as {
  CLOUDFLARE_COMPATIBILITY_DATE: string;
  CLOUDFLARE_COMPATIBILITY_FLAGS: readonly string[];
};
const read = (rel: string) => readFile(path.join(DOCS_ROOT, 'content', rel), 'utf8');

const fencedBlocks = (md: string, lang: string): string[] => {
  const out: string[] = [];
  const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
};

describe('serverless docs: claims', () => {
  it('api-routes.md no longer claims unconditional portability or lists hosts without adapters', async () => {
    const md = await read('api-routes.md');
    expect(md).not.toMatch(/completely portable/i);
    expect(md).not.toMatch(/without modification on/i);
    for (const host of ['Fastly Compute', 'Netlify Edge Functions', 'AWS Lambda', 'Google Cloud Functions']) {
      expect(md, host).not.toContain(host);
    }
    expect(md).toContain('/deploying#serverless-hosting');
  });

  it('deploying.md gates static hosting on server scripts, stream scripts, and API routes and links the guide', async () => {
    const md = await read('deploying.md');
    const staticSection = md.slice(md.indexOf('## Static hosting'), md.indexOf('## Serverless hosting'));
    expect(staticSection).toContain('data-bascik-server');
    expect(staticSection).toContain('data-bascik-stream');
    expect(staticSection).toMatch(/API route/);
    expect(md).toContain('## Serverless hosting');
    expect(md).toContain('/how-to/cloudflare');
  });

  it('the guide carries a support matrix that marks other hosts as manual porting, not supported', async () => {
    const md = await read('how-to/cloudflare.md');
    expect(md).toContain('## What runs where');
    expect(md).toMatch(/Other serverless hosts/);
    expect(md).toMatch(/Manual porting/);
    // No blanket claim.
    expect(md).not.toMatch(/runs anywhere/i);
    expect(md).not.toMatch(/any cloud/i);
  });

  it('the guide states remote validation status honestly', async () => {
    const md = await read('how-to/cloudflare.md');
    expect(md).toContain('## Verification status');
    expect(md).toMatch(/pending/i);
    expect(md).not.toMatch(/five nines|99\.999/i);
  });

  it('the guide is in the How-to nav and its h1 matches the nav label', async () => {
    const page = NAV.flatMap((s) => s.pages).find((p) => p.href === '/how-to/cloudflare');
    expect(page?.label).toBe('Cloudflare');
    const md = await read('how-to/cloudflare.md');
    expect(md.split('\n')[0]).toBe('# Cloudflare');
  });
});

describe('serverless docs: commands and code agree with the implementation', () => {
  it('every documented bascik command parses to a build with a known target, and the --only combination is rejected', async () => {
    const md = await read('how-to/cloudflare.md');
    const shBlocks = fencedBlocks(md, 'sh').join('\n');
    const bascikLines = shBlocks.split('\n').filter((l) => l.trim().startsWith('bascik ') || l.includes('npx bascik'));
    expect(bascikLines.length).toBeGreaterThan(0);
    for (const line of bascikLines) {
      const args = line.trim().replace(/^npx\s+/, '').split(/\s+/).slice(1);
      const decision = resolveCliAction(args);
      expect(decision.action, line).toBe('build');
      expect(decision.flags.target, line).toBeDefined();
      expect(DEPLOY_TARGETS as readonly string[]).toContain(decision.flags.target!);
    }
    expect(resolveCliAction(['--build', '--target', 'cloudflare-pages', '--only', 'x.html']).action).toBe('error');
  });

  it('the documented wrangler preview uses the exact compatibility date and flags the Worker declares', async () => {
    const md = await read('how-to/cloudflare.md');
    expect(md).toContain(`--compatibility-date=${CLOUDFLARE_COMPATIBILITY_DATE}`);
    for (const flag of CLOUDFLARE_COMPATIBILITY_FLAGS) expect(md).toContain(flag);
    // Only the pinned date appears; a stale hard-coded one would be a drift.
    const dates = [...md.matchAll(/compatibility-date=(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    expect(new Set(dates)).toEqual(new Set([CLOUDFLARE_COMPATIBILITY_DATE]));
  });

  it('the documented output tree names the files the emitter writes', async () => {
    const md = await read('how-to/cloudflare.md');
    for (const name of ['_worker.js', '_routes.json', 'build-info.json', 'wrangler.jsonc', 'worker.js']) {
      expect(md, name).toContain(name);
    }
  });

  it('the binding example executes against the adapter context shape and degrades on Node', async () => {
    const md = await read('how-to/cloudflare.md');
    const [tsBlock] = fencedBlocks(md, 'ts');
    expect(tsBlock).toContain('context.platform');
    // Compile the snippet by stripping type annotations the way Node does,
    // then run the handler with a Cloudflare-shaped and a Node-shaped context.
    const source = tsBlock.replace(/^\/\/.*$/m, '');
    const dataUrl = `data:text/typescript,${encodeURIComponent(source)}`;
    let mod: { GET: (r: Request, c: unknown) => Promise<Response> };
    try {
      mod = await import(dataUrl);
    } catch {
      // Older Node without data: TypeScript support: strip types with the
      // built-in amaro stripper instead.
      const { stripTypeScriptTypes } = await import('node:module');
      const js = stripTypeScriptTypes(source);
      mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
    }
    const req = new Request('https://example.com/api/greeting');
    const kv = { get: async (key: string) => (key === 'hello' ? 'Hi from KV' : null) };
    const cloudflare = await mod.GET(req, { params: {}, remoteIp: '', platform: { name: 'cloudflare', env: { GREETINGS: kv } } });
    expect(await cloudflare.json()).toEqual({ text: 'Hi from KV', host: 'cloudflare' });
    const node = await mod.GET(req, { params: {}, remoteIp: '127.0.0.1', platform: { name: 'node' } });
    expect(await node.json()).toEqual({ text: 'Hello', host: 'node' });
  });
});
