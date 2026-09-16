/**
 * Prompt 148: browser TypeScript transformation and the sourceURL boundary.
 *
 * Runs in every e2e lane (static build, dev server, HTTP/1.1 and HTTP/2
 * production servers). The build lanes go through the e2e config's esbuild
 * `minify.js` (loader 'js'), which rejects TypeScript, so a passing page also
 * proves the strip ran before minification. The dev lane runs with minify.js
 * off, so it proves the strip is not a minifier side effect.
 */
import { expect, test } from '@playwright/test';

test.describe('browser TypeScript is stripped on supported paths', () => {
  test('referenced .ts companion, inline text/typescript, and ordinary scripts all execute', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    await page.goto('/ts-strip-test');

    const companion = page.getByTestId('ts-companion-out');
    await expect(companion).toHaveCount(2);
    await expect(companion.first()).toHaveText('companion-typescript-ran');
    await expect(companion.last()).toHaveText('companion-typescript-ran');

    const inline = page.getByTestId('ts-inline-out');
    await expect(inline).toHaveCount(2);
    await expect(inline.first()).toHaveText('inline-typescript-ran:1');
    await expect(inline.last()).toHaveText('inline-typescript-ran:1');

    const plain = page.getByTestId('ts-plain-out');
    await expect(plain.first()).toHaveText('plain-javascript-ran');
    await expect(plain.last()).toHaveText('plain-javascript-ran');

    await expect(page.getByTestId('ts-page-out')).toHaveText('page-typescript-ran:2');

    expect(pageErrors, pageErrors.map((e) => e.message).join('\n')).toHaveLength(0);
  });

  test('emitted HTML contains no TypeScript syntax and no same-line sourceURL glue', async ({ request }) => {
    const response = await request.get('/ts-strip-test');
    expect(response.ok()).toBe(true);
    const html = await response.text();

    expect(html).not.toContain('text/typescript');
    expect(html).not.toContain('as HTMLElement');
    expect(html).not.toContain(': number');
    expect(html).not.toContain('interface Tick');
    expect(html).not.toContain('Tick[]');
    expect(html).not.toContain('Tick | undefined');
    expect(html).not.toContain('first!');

    // A directive glued to the end of the closing IIFE line comments out the
    // rest of that line and breaks the script.
    expect(html).not.toContain('})(); //# sourceURL');
    expect(html).not.toMatch(/\)[ \t]*;?[ \t]*\/\/# sourceURL/);

    // Every inline script body in the page must be parseable JavaScript, and
    // any sourceURL directive must be the final line of its script.
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = m[1];
      const body = m[2];
      if (/\bsrc\s*=/.test(attrs)) continue;
      if (/\btype\s*=/.test(attrs) && !/text\/javascript|module/i.test(attrs)) continue;
      expect(() => new Function(body), body.slice(0, 200)).not.toThrow();
      const idx = body.indexOf('//# sourceURL');
      if (idx !== -1) {
        expect(body.slice(idx).trimEnd()).not.toContain('\n');
        expect(body.slice(0, idx).endsWith('\n')).toBe(true);
      }
    }
  });
});
