import { expect, test } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const e2eDir = fileURLToPath(new URL('..', import.meta.url));
const entryPath = join(e2eDir, '../dist/index.js');

const runBuild = (cwd: string): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [entryPath, '--build'], {
    cwd,
    env: { ...process.env, BASCIK_SITE_URL: 'https://example.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (data) => { output += data.toString('utf8'); });
  child.stderr?.on('data', (data) => { output += data.toString('utf8'); });
  child.on('error', reject);
  child.on('close', (code) => {
    code === 0 ? resolve() : reject(new Error(`Build exited with code ${code}:\n${output}`));
  });
});

const pageHtml = `<!doctype html><html><head>
<link rel="stylesheet" href="/styles.css">
<meta property="og:image" content="/share.png">
</head><body>
<a data-testid="fragment" href="#section">Fragment</a>
<a data-testid="mail" href="mailto:test@example.com">Mail</a>
<img data-testid="hero" src="/hero.png" srcset="/hero-small.png 1x, https://cdn.example.com/hero.png 2x">
<script src="https://cdn.example.com/app.js"></script>
<div id="section" style="background:url('/inline.png')"></div>
</body></html>`;

test('static builds rewrite root-relative URLs under a non-root base', async () => {
  const fixtureDir = join(e2eDir, `.base-path-${process.pid}-${Date.now()}`);
  const pagesDir = join(fixtureDir, 'src/pages/nested');
  try {
    await mkdir(join(fixtureDir, 'src/components'), { recursive: true });
    await mkdir(pagesDir, { recursive: true });
    await writeFile(join(fixtureDir, 'bascik.config.ts'), `export default { base: '/sub/' };`);
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(join(pagesDir, 'index.html'), pageHtml);
    await writeFile(join(fixtureDir, 'src/pages/styles.css'), `.hero{background:url(/hero.png)} .icon{mask:url(#icon)}`);
    await writeFile(join(fixtureDir, 'src/pages/site.webmanifest'), JSON.stringify({
      start_url: '/',
      scope: '/',
      icons: [{ src: '/icon.png' }],
    }));

    await runBuild(fixtureDir);

    const output = await readFile(join(fixtureDir, 'dist/nested/index.html'), 'utf8');
    expect(output).toContain('href="/sub/styles.css"');
    expect(output).toContain('content="/sub/share.png"');
    expect(output).toContain('src="/sub/hero.png"');
    expect(output).toContain('srcset="/sub/hero-small.png 1x, https://cdn.example.com/hero.png 2x"');
    expect(output).toContain('url(\'/sub/inline.png\')');
    expect(output).toContain('href="#section"');
    expect(output).toContain('href="mailto:test@example.com"');
    expect(output).toContain('src="https://cdn.example.com/app.js"');

    const css = await readFile(join(fixtureDir, 'dist/styles.css'), 'utf8');
    expect(css).toContain('url(/sub/hero.png)');
    expect(css).toContain('url(#icon)');
    const manifest = JSON.parse(await readFile(join(fixtureDir, 'dist/site.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({
      start_url: '/sub/',
      scope: '/sub/',
      icons: [{ src: '/sub/icon.png' }],
    });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test('an explicit root base produces byte-identical static output', async () => {
  const fixtureDir = join(e2eDir, `.base-root-${process.pid}-${Date.now()}`);
  try {
    await mkdir(join(fixtureDir, 'src/components'), { recursive: true });
    await mkdir(join(fixtureDir, 'src/pages'), { recursive: true });
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    await writeFile(join(fixtureDir, 'src/pages/index.html'), pageHtml);

    await runBuild(fixtureDir);
    const defaultOutput = await readFile(join(fixtureDir, 'dist/index.html'), 'utf8');

    await writeFile(join(fixtureDir, 'bascik.config.ts'), `export default { base: '/' };`);
    await runBuild(fixtureDir);
    const rootBaseOutput = await readFile(join(fixtureDir, 'dist/index.html'), 'utf8');

    expect(rootBaseOutput).toBe(defaultOutput);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});