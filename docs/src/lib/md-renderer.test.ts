import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMd, renderMdRange, extractDemoBlock, demoImage } from './md-renderer.js';

describe('md-renderer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'md-renderer-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('renderMd transforms code blocks, callouts, and external links', async () => {
    const mdContent = `## Title

Paragraph text.

\`\`\`ts
const x = 1;
\`\`\`

> **Note.** Important callout.

[External](https://example.com)
`;
    const mdFile = join(tempDir, 'test.md');
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html).toContain('<h2 id="title"><a class="anchor-link" href="#title">Title</a></h2>');
    expect(html).toContain('<code-block data-bascik-prop-lang="ts">');
    expect(html).toContain('<div class="callout">');
    expect(html).toContain('<a target="_blank" rel="noopener noreferrer" href="https://example.com"');
  });

  it('renderMd gives "See it live" blockquotes the live-demo callout variant and leaves others plain', async () => {
    const mdContent = `> **See it live on Cloudflare Workers.** Open a running deployment:
>
> - [Stream demo](https://demo.example.com/stream)

> **Note.** A plain callout.

> **See it** without the live keyword stays plain.
`;
    const mdFile = join(tempDir, 'live.md');
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html.match(/<div class="callout callout-live">/g)).toHaveLength(1);
    expect(html.match(/<div class="callout">/g)).toHaveLength(2);
    expect(html).not.toContain('<blockquote>');
    expect(html).toContain('<a target="_blank" rel="noopener noreferrer" href="https://demo.example.com/stream"');
  });

  it('generates clean anchor slugs by decoding entities and collapsing hyphens', async () => {
    const mdContent = `## Why does \`--check\` list my third-party web components?

## Isn't BASIC already a programming language?
`;
    const mdFile = join(tempDir, 'slug-test.md');
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html).toContain(
      '<h2 id="why-does-check-list-my-third-party-web-components"><a class="anchor-link" href="#why-does-check-list-my-third-party-web-components">'
    );
    expect(html).toContain(
      '<h2 id="isnt-basic-already-a-programming-language"><a class="anchor-link" href="#isnt-basic-already-a-programming-language">'
    );
  });

  it('renderMd wraps tables in <doc-table> and adds scope="col" to <th> headers', async () => {
    const mdContent = `| Col 1 | Col 2 |\n| --- | --- |\n| Val 1 | Val 2 |\n`;
    const mdFile = join(tempDir, 'table.md');
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html).toContain('<doc-table><table>');
    expect(html).toContain('<th scope="col">Col 1</th>');
    expect(html).toContain('<th scope="col">Col 2</th>');
    expect(html).toContain('</table></doc-table>');
  });

  it('renderMd gives site images lazy loading and the real size of PNG files in src/pages', async () => {
    const mdFile = join(tempDir, 'images.md');
    await writeFile(mdFile, '![Touch icon](/assets/apple-touch-icon.png)\n\n![Missing](/assets/not-there.png)\n');

    const html = await renderMd(mdFile);
    expect(html).toMatch(/<img loading="lazy" decoding="async" width="180" height="180" src="\/assets\/apple-touch-icon\.png" alt="Touch icon"/);
    // A file that does not exist still renders, without invented dimensions.
    expect(html).toMatch(/<img loading="lazy" decoding="async" src="\/assets\/not-there\.png"/);
  });

  it('renderMd reads WebP headers and halves the size of @2x files', async () => {
    // 1x and 2x copies of the same 8x4 lossy WebP header: only the file name differs.
    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8 ', 12, 'latin1');
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    // The renderer resolves site paths from process.cwd(), so point it at a temporary site.
    const assets = join(tempDir, 'src/pages/assets');
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, 'plain.webp'), webp);
    await writeFile(join(assets, 'dense@2x.webp'), webp);
    const mdFile = join(tempDir, 'webp.md');
    await writeFile(mdFile, '![Plain](/assets/plain.webp)\n\n![Dense](/assets/dense@2x.webp)\n');

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    try {
      const html = await renderMd(mdFile);
      expect(html).toMatch(/width="40" height="20" src="\/assets\/plain\.webp"/);
      expect(html).toMatch(/width="20" height="10" src="\/assets\/dense@2x\.webp"/);
    } finally {
      cwd.mockRestore();
    }
  });

  it('renderMd wraps an animated image that has a -still copy in <picture> for reduced motion', async () => {
    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8 ', 12, 'latin1');
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    const assets = join(tempDir, 'src/pages/assets');
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, 'demo@2x.webp'), webp);
    await writeFile(join(assets, 'demo-still@2x.webp'), webp);
    await writeFile(join(assets, 'solo@2x.webp'), webp);
    const mdFile = join(tempDir, 'still.md');
    await writeFile(mdFile, '![Demo](/assets/demo@2x.webp)\n\n![Solo](/assets/solo@2x.webp)\n');

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    try {
      const html = await renderMd(mdFile);
      expect(html).toContain(
        '<picture><source media="(prefers-reduced-motion: reduce)" srcset="/assets/demo-still@2x.webp">' +
          '<img loading="lazy" decoding="async" width="20" height="10" src="/assets/demo@2x.webp" alt="Demo"></picture>',
      );
      // An image with no still copy stays a plain <img>.
      expect(html.match(/<picture>/g)).toHaveLength(1);
      expect(html).toContain('<img loading="lazy" decoding="async" width="20" height="10" src="/assets/solo@2x.webp" alt="Solo">');
    } finally {
      cwd.mockRestore();
    }
  });

  it('demoImage renders like a Markdown image and marks recorded demos without boxing other images', async () => {
    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8 ', 12, 'latin1');
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    await mkdir(join(tempDir, 'src/pages/assets/demos'), { recursive: true });
    await writeFile(join(tempDir, 'src/pages/assets/demos/tour@2x.webp'), webp);
    await writeFile(join(tempDir, 'src/pages/assets/demos/tour-still@2x.webp'), webp);
    await writeFile(join(tempDir, 'src/pages/assets/photo@2x.webp'), webp);

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    try {
      expect(demoImage('/assets/demos/tour@2x.webp', 'A "quoted" tour')).toBe(
        '<picture><source media="(prefers-reduced-motion: reduce)" srcset="/assets/demos/tour-still@2x.webp">' +
          '<img loading="lazy" decoding="async" class="demo-shot" width="20" height="10" ' +
          'src="/assets/demos/tour@2x.webp" alt="A &quot;quoted&quot; tour"></picture>',
      );
      // Only the recorded demos opt out of the default image frame.
      expect(demoImage('/assets/photo@2x.webp', 'Photo')).not.toContain('demo-shot');
    } finally {
      cwd.mockRestore();
    }
  });

  it('demoImage serves a narrow-screen image with its own size, and keeps reduced motion ahead of screen size', async () => {
    const webp = (width: number, height: number) => {
      const header = Buffer.alloc(32);
      header.write('RIFF', 0, 'latin1');
      header.write('WEBP', 8, 'latin1');
      header.write('VP8 ', 12, 'latin1');
      header.writeUInt16LE(width, 26);
      header.writeUInt16LE(height, 28);
      return header;
    };
    const assets = join(tempDir, 'src/pages/assets/demos');
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, 'wide@2x.webp'), webp(1100, 360));
    await writeFile(join(assets, 'wide-still@2x.webp'), webp(1100, 360));
    await writeFile(join(assets, 'tall@2x.webp'), webp(660, 700));
    await writeFile(join(assets, 'tall-still@2x.webp'), webp(660, 700));

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    try {
      const html = demoImage('/assets/demos/wide@2x.webp', 'Tour', { src: '/assets/demos/tall@2x.webp', maxWidth: 760 });
      const sources = [...html.matchAll(/<source [^>]*>/g)].map((match) => match[0]);
      expect(sources).toEqual([
        '<source media="(max-width: 760px) and (prefers-reduced-motion: reduce)" srcset="/assets/demos/tall-still@2x.webp" width="330" height="350">',
        '<source media="(prefers-reduced-motion: reduce)" srcset="/assets/demos/wide-still@2x.webp">',
        '<source media="(max-width: 760px)" srcset="/assets/demos/tall@2x.webp" width="330" height="350">',
      ]);
      // The <img> keeps the default image's own size.
      expect(html).toContain('width="550" height="180" src="/assets/demos/wide@2x.webp"');
    } finally {
      cwd.mockRestore();
    }
  });

  it('renderMd supports skipFirstHeading option', async () => {
    const mdContent = `# Title\n\nSecond heading text.\n\n## Subheading\n\nContent.`;
    const mdFile = join(tempDir, 'skip.md');
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile, { skipFirstHeading: true });
    expect(html).not.toContain('<h2 id="title">');
    expect(html).toContain('<h2 id="subheading">');
  });

  it('renderMd supports skipToFirstH2 option', async () => {
    const mdContent = `# Title\n\nIntro paragraph.\n\n## Section 1\nFirst content.\n\n## Section 2\nSecond content.`;
    const mdFile = join(tempDir, 'skip-h2.md');
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile, { skipToFirstH2: true });
    expect(html).not.toContain('Intro paragraph.');
    expect(html).toContain('<h2 id="section-1">');
    expect(html).toContain('<h2 id="section-2">');
  });

  it('renderMd skipToFirstH2 returns empty when no h2 exists', async () => {
    const mdContent = `# Title\n\nIntro paragraph.`;
    const mdFile = join(tempDir, 'skip-h2-none.md');
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile, { skipToFirstH2: true });
    expect(html).toBe('');
  });

  it('renderMdRange renders content between headings', async () => {
    const mdContent = `
# Title

## Section 1
First content.

## Section 2
Second content.

## Section 3
Third content.
`;
    const mdFile = join(tempDir, 'range.md');
    await writeFile(mdFile, mdContent);

    const html = await renderMdRange(mdFile, { from: 'Section 2', to: 'Section 3' });
    expect(html).toContain('Second content.');
    expect(html).not.toContain('First content.');
    expect(html).not.toContain('Third content.');
  });

  it('renderMdRange throws an error if specified "from" heading is not found', async () => {
    const mdContent = `# Title\n\n## Section 1\nContent.`;
    const mdFile = join(tempDir, 'missing-from.md');
    await writeFile(mdFile, mdContent);

    await expect(renderMdRange(mdFile, { from: 'Nonexistent Section' })).rejects.toThrow(
      '[md-renderer] Heading "from: Nonexistent Section" not found'
    );
  });

  it('renderMdRange throws an error if specified "to" heading is not found', async () => {
    const mdContent = `# Title\n\n## Section 1\nContent.`;
    const mdFile = join(tempDir, 'missing-to.md');
    await writeFile(mdFile, mdContent);

    await expect(renderMdRange(mdFile, { from: 'Section 1', to: 'Nonexistent Section' })).rejects.toThrow(
      '[md-renderer] Heading "to: Nonexistent Section" not found'
    );
  });

  it('extractDemoBlock extracts marked fenced code blocks', async () => {
    const mdContent = `
# Demo Page

<!-- demo:source-html -->
\`\`\`html
<div class="card">
  <p>Hello</p>
</div>
\`\`\`
`;
    const mdFile = join(tempDir, 'demo.md');
    await writeFile(mdFile, mdContent);

    const code = await extractDemoBlock(mdFile, 'source-html');
    expect(code).toBe('&lt;div class="card"&gt;\n  &lt;p&gt;Hello&lt;/p&gt;\n&lt;/div&gt;');
  });

  it('extractDemoBlock returns error comment if marker not found', async () => {
    const mdFile = join(tempDir, 'missing.md');
    await writeFile(mdFile, '# No marker');

    const result = await extractDemoBlock(mdFile, 'missing-marker');
    expect(result).toContain('<!-- demo:missing-marker not found');
  });

  it('renderMd gracefully handles ENOENT for missing files', async () => {
    const result = await renderMd(join(tempDir, 'non-existent.md'));
    expect(result).toContain('callout');
    expect(result).toContain('File not found:');
  });

  it('renderMdRange gracefully handles ENOENT for missing files', async () => {
    const result = await renderMdRange(join(tempDir, 'non-existent.md'), { from: 'Start' });
    expect(result).toContain('callout');
    expect(result).toContain('File not found:');
  });

  it('extractDemoBlock gracefully handles ENOENT for missing files', async () => {
    const result = await extractDemoBlock(join(tempDir, 'non-existent.md'), 'demo');
    expect(result).toContain('<!-- [md-renderer] File not found:');
  });
});
