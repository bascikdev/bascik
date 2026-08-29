import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faqSchema } from './faq-schema.js';

describe('faqSchema', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), 'faq-schema-test-'));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses markdown h2 headings into FAQPage JSON-LD schema', async () => {
    const mdContent = `
# FAQ Header

Preamble text...

## What is \`Bascik\`?

Bascik is a **fast** static site generator.

## How does it work?

It transpiles HTML templates at build time.
`;
    const mdFile = join(tempDir, 'faq.md');
    await writeFile(mdFile, mdContent);
    process.chdir(tempDir);

    const result = await faqSchema('faq.md');
    expect(result).toContain('<script type="application/ld+json">');
    expect(result).toContain('"@type": "FAQPage"');

    const parsed = JSON.parse(result.replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
    expect(parsed.mainEntity).toHaveLength(2);
    expect(parsed.mainEntity[0].name).toBe('What is Bascik?');
    expect(parsed.mainEntity[0].acceptedAnswer.text).toBe('Bascik is a fast static site generator.');
    expect(parsed.mainEntity[1].name).toBe('How does it work?');
    expect(parsed.mainEntity[1].acceptedAnswer.text).toBe('It transpiles HTML templates at build time.');
  });

  it('returns empty string if no QA pairs exist', async () => {
    const mdContent = `# Just a title\nNo h2 sections here.`;
    const mdFile = join(tempDir, 'empty.md');
    await writeFile(mdFile, mdContent);
    process.chdir(tempDir);

    const result = await faqSchema('empty.md');
    expect(result).toBe('');
  });

  it('escapes HTML tags (< and >) to &lt; and &gt; to prevent breaking the script tag', async () => {
    const mdContent = `
# FAQ Header

## How do local script references (\`<script src="...">\`) work?

When a component \`.html\` file includes a \`<script src="counter.ts"></script>\` tag.
`;
    const mdFile = join(tempDir, 'faq.md');
    await writeFile(mdFile, mdContent);
    process.chdir(tempDir);

    const result = await faqSchema('faq.md');
    const parsed = JSON.parse(result.replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
    expect(parsed.mainEntity[0].name).toBe('How do local script references (&lt;script src="..."&gt;) work?');
    expect(parsed.mainEntity[0].acceptedAnswer.text).toBe('When a component .html file includes a &lt;script src="counter.ts"&gt;&lt;/script&gt; tag.');
  });
});
