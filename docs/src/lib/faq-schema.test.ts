import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faqSchema } from "./faq-schema.js";

/** The JSON between the opening `<script ...>` tag and the closing tag. */
const jsonLdBody = (html: string): string =>
  html.slice(html.indexOf(">") + 1, html.lastIndexOf("</"));

describe("faqSchema", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "faq-schema-test-"));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses markdown h2 headings into FAQPage JSON-LD schema", async () => {
    const mdContent = `
# FAQ Header

Preamble text...

## What is \`Bascik\`?

Bascik is a **fast** static site generator.

## How does it work?

It transpiles HTML templates at build time.
`;
    const mdFile = join(tempDir, "faq.md");
    await writeFile(mdFile, mdContent);
    process.chdir(tempDir);

    const result = String(await faqSchema("faq.md"));
    expect(result).toContain('<script type="application/ld+json">');

    const parsed = JSON.parse(jsonLdBody(result));
    expect(parsed["@type"]).toBe("FAQPage");
    expect(parsed.mainEntity).toHaveLength(2);
    expect(parsed.mainEntity[0].name).toBe("What is Bascik?");
    expect(parsed.mainEntity[0].acceptedAnswer.text).toBe(
      "Bascik is a fast static site generator.",
    );
    expect(parsed.mainEntity[1].name).toBe("How does it work?");
    expect(parsed.mainEntity[1].acceptedAnswer.text).toBe(
      "It transpiles HTML templates at build time.",
    );
  });

  it("returns empty string if no QA pairs exist", async () => {
    const mdContent = `# Just a title\nNo h2 sections here.`;
    const mdFile = join(tempDir, "empty.md");
    await writeFile(mdFile, mdContent);
    process.chdir(tempDir);

    const result = await faqSchema("empty.md");
    expect(result).toBe("");
  });

  it("preserves literal HTML text while keeping the JSON-LD script safe", async () => {
    const mdContent = `
# FAQ Header

## How do local script references (\`<script src="...">\`) work?

When a component \`.html\` file includes a \`<script src="counter.ts"></script>\` tag.
`;
    const mdFile = join(tempDir, "faq.md");
    await writeFile(mdFile, mdContent);
    process.chdir(tempDir);

    const result = String(await faqSchema("faq.md"));
    const parsed = JSON.parse(jsonLdBody(result));
    expect(parsed.mainEntity[0].name).toBe(
      'How do local script references (<script src="...">) work?',
    );
    expect(parsed.mainEntity[0].acceptedAnswer.text).toBe(
      'When a component .html file includes a <script src="counter.ts"></script> tag.',
    );
  });

  it("uses safe JSON script output without changing literal markup in FAQ text", async () => {
    const mdContent = `
## Can content include \`</script><script>\`?

The answer may contain \`</script><script>alert(1)</script>\`.
`;
    const mdFile = join(tempDir, "faq.md");
    await writeFile(mdFile, mdContent);
    process.chdir(tempDir);

    const result = String(await faqSchema("faq.md"));
    expect(result).not.toContain("</script><script>alert");
    const parsed = JSON.parse(jsonLdBody(result));
    expect(parsed.mainEntity[0].name).toBe(
      "Can content include </script><script>?",
    );
    expect(parsed.mainEntity[0].acceptedAnswer.text).toBe(
      "The answer may contain </script><script>alert(1)</script>.",
    );
  });
});
