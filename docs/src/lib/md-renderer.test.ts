import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  renderMd,
  renderMdRange,
  extractDemoBlock,
  demoImage,
  VERSIONED_IMAGE_FOLDERS,
} from "./md-renderer.js";

const hashOf = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 10);

describe("md-renderer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "md-renderer-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("renderMd transforms code blocks, callouts, and external links", async () => {
    const mdContent = `## Title

Paragraph text.

\`\`\`ts
const x = 1;
\`\`\`

> **Note.** Important callout.

[External](https://example.com)
`;
    const mdFile = join(tempDir, "test.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html).toContain(
      '<h2 id="title"><a class="anchor-link" href="#title">Title</a></h2>',
    );
    expect(html).toContain('<code-block data-bascik-prop-lang="ts">');
    // Highlighted at build time, so the page needs no highlighter script.
    expect(html).toContain(
      '<code-block data-bascik-prop-lang="ts"><span data-code-token="kw">const</span> x = <span data-code-token="num">1</span>;\n</code-block>',
    );
    expect(html).toContain('<div class="callout">');
    expect(html).toContain(
      '<a target="_blank" rel="noopener noreferrer" href="https://example.com"',
    );
  });

  it('renderMd gives "See it live" blockquotes the live-demo callout variant and leaves others plain', async () => {
    const mdContent = `> **See it live on Cloudflare Workers.** Open a running deployment:
>
> - [Stream demo](https://demo.example.com/stream)

> **Note.** A plain callout.

> **See it** without the live keyword stays plain.
`;
    const mdFile = join(tempDir, "live.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html.match(/<div class="callout callout-live">/g)).toHaveLength(1);
    expect(html.match(/<div class="callout">/g)).toHaveLength(2);
    expect(html).not.toContain("<blockquote>");
    expect(html).toContain(
      '<a target="_blank" rel="noopener noreferrer" href="https://demo.example.com/stream"',
    );
  });

  it("generates clean anchor slugs by decoding entities and collapsing hyphens", async () => {
    const mdContent = `## Why does \`--check\` list my third-party web components?

## Isn't BASIC already a programming language?
`;
    const mdFile = join(tempDir, "slug-test.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html).toContain(
      '<h2 id="why-does-check-list-my-third-party-web-components"><a class="anchor-link" href="#why-does-check-list-my-third-party-web-components">',
    );
    expect(html).toContain(
      '<h2 id="isnt-basic-already-a-programming-language"><a class="anchor-link" href="#isnt-basic-already-a-programming-language">',
    );
  });

  it('renderMd wraps tables in <doc-table> and adds scope="col" to <th> headers', async () => {
    const mdContent = `| Col 1 | Col 2 |\n| --- | --- |\n| Val 1 | Val 2 |\n`;
    const mdFile = join(tempDir, "table.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html).toContain("<doc-table><table>");
    expect(html).toContain('<th scope="col">Col 1</th>');
    expect(html).toContain('<th scope="col">Col 2</th>');
    expect(html).toContain("</table></doc-table>");
  });

  // content/lighthouse.md centers its score columns with :---:, which marked writes as <th align="center">.
  it('renderMd adds scope="col" to aligned header cells too, and leaves <thead> and a set scope alone', async () => {
    const mdContent = [
      "| Left | Center | Right | Plain |",
      "| :--- | :----: | ----: | ----- |",
      "| 1 | 2 | 3 | 4 |",
      "",
      '<table><tr><th scope="row">Row</th><td>x</td></tr></table>',
      "",
    ].join("\n");
    const mdFile = join(tempDir, "aligned-table.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile);
    expect(html).toContain('<th scope="col" align="left">Left</th>');
    expect(html).toContain('<th scope="col" align="center">Center</th>');
    expect(html).toContain('<th scope="col" align="right">Right</th>');
    expect(html).toContain('<th scope="col">Plain</th>');
    expect(html).toContain("<thead>");
    expect(html).not.toMatch(/<thead scope/);
    expect(html).toContain('<th scope="row">Row</th>');
    expect(
      html.match(/<th\b[^>]*>/g)?.every((tag) => /\bscope=/.test(tag)),
    ).toBe(true);
  });

  it("renderMd gives site images lazy loading and the real size of PNG files in src/pages", async () => {
    const mdFile = join(tempDir, "images.md");
    await writeFile(
      mdFile,
      // Below the second heading, so neither image is the likely LCP image (see the eager image test).
      "## One\n\n## Two\n\n![Touch icon](/assets/apple-touch-icon.png)\n\n![Missing](/assets/not-there.png)\n",
    );

    const html = await renderMd(mdFile);
    expect(html).toMatch(
      /<img loading="lazy" decoding="async" width="180" height="180" src="\/assets\/apple-touch-icon\.png" alt="Touch icon"/,
    );
    // A file that does not exist still renders, without invented dimensions.
    expect(html).toMatch(
      /<img loading="lazy" decoding="async" src="\/assets\/not-there\.png"/,
    );
  });

  it("renderMd reads WebP headers and halves the size of @2x files", async () => {
    // 1x and 2x copies of the same 8x4 lossy WebP header: only the file name differs.
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8 ", 12, "latin1");
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    // The renderer resolves site paths from process.cwd(), so point it at a temporary site.
    const assets = join(tempDir, "src/pages/assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "plain.webp"), webp);
    await writeFile(join(assets, "dense@2x.webp"), webp);
    const mdFile = join(tempDir, "webp.md");
    await writeFile(
      mdFile,
      "![Plain](/assets/plain.webp)\n\n![Dense](/assets/dense@2x.webp)\n",
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    try {
      const html = await renderMd(mdFile);
      expect(html).toMatch(
        /width="40" height="20" src="\/assets\/plain\.webp"/,
      );
      expect(html).toMatch(
        /width="20" height="10" src="\/assets\/dense%402x\.webp"/,
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("renderMd wraps an animated image that has a -still copy in <picture> for reduced motion", async () => {
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8 ", 12, "latin1");
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    const assets = join(tempDir, "src/pages/assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "demo@2x.webp"), webp);
    await writeFile(join(assets, "demo-still@2x.webp"), webp);
    await writeFile(join(assets, "solo@2x.webp"), webp);
    const mdFile = join(tempDir, "still.md");
    await writeFile(
      mdFile,
      "## One\n\n## Two\n\n![Demo](/assets/demo@2x.webp)\n\n![Solo](/assets/solo@2x.webp)\n",
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    try {
      const html = await renderMd(mdFile);
      expect(html).toContain(
        '<picture><source media="(prefers-reduced-motion: reduce)" srcset="/assets/demo-still%402x.webp">' +
          '<img loading="lazy" decoding="async" width="20" height="10" src="/assets/demo%402x.webp" alt="Demo"></picture>',
      );
      // An image with no still copy stays a plain <img>.
      expect(html.match(/<picture>/g)).toHaveLength(1);
      expect(html).toContain(
        '<img loading="lazy" decoding="async" width="20" height="10" src="/assets/solo%402x.webp" alt="Solo">',
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("renderMd loads the first image above the second heading eagerly, without a fetch priority, and every other image lazily", async () => {
    // getting-started, stream-scripts and sitemap open with a demo recording that is the largest thing on a
    // laptop screen. Lazy loading it delays the Largest Contentful Paint until layout, so it loads eagerly. On a
    // phone the text or code block above it is the largest paint, and fetchpriority="high" made the image's
    // download compete with it (sitemap mobile LCP 1.5 s to 2.4 s), so the browser picks the priority.
    const mdFile = join(tempDir, "lcp.md");
    await writeFile(
      mdFile,
      "# Page\n\nIntro.\n\n## See it in action\n\n![Hero](/assets/hero.png)\n\n" +
        "## Details\n\n![Later](/assets/later.png)\n",
    );
    const html = await renderMd(mdFile);
    const images = [...html.matchAll(/<img [^>]*>/g)].map((match) => match[0]);
    expect(images).toEqual([
      '<img loading="eager" src="/assets/hero.png" alt="Hero">',
      '<img loading="lazy" decoding="async" src="/assets/later.png" alt="Later">',
    ]);
  });

  it("never gives a Markdown image fetchpriority, which competes with the text that is the LCP on a phone", async () => {
    const mdFile = join(tempDir, "code-first.md");
    await writeFile(
      mdFile,
      "# Page\n\n```sh\nnpx bascik --build\n```\n\n![Demo](/assets/demo.png)\n\n## Next\n",
    );
    const html = await renderMd(mdFile);
    expect(html).not.toContain("fetchpriority");
    expect(html).toContain('<img loading="eager" src="/assets/demo.png"');
  });

  it("renderMd makes only one image eager when an author puts several above the fold", async () => {
    const mdFile = join(tempDir, "two-heroes.md");
    await writeFile(
      mdFile,
      "![First](/assets/first.png)\n\n![Second](/assets/second.png)\n\n## Next\n\n![Third](/assets/third.png)\n",
    );
    const html = await renderMd(mdFile);
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    expect(html).toContain('<img loading="eager" src="/assets/first.png"');
    expect(html).toContain(
      '<img loading="lazy" decoding="async" src="/assets/second.png"',
    );
    expect(html).toContain(
      '<img loading="lazy" decoding="async" src="/assets/third.png"',
    );
  });

  it("renderMd keeps every image lazy below the second heading and in a range that starts mid-page", async () => {
    const mdFile = join(tempDir, "deep.md");
    await writeFile(
      mdFile,
      "# Page\n\n## One\n\nText.\n\n## Two\n\n![Deep](/assets/deep.png)\n\n## Three\n\n![Mid](/assets/mid.png)\n",
    );
    expect(await renderMd(mdFile)).not.toContain('loading="eager"');
    // A range that starts at a later heading is rendered lower on its page than the page's own intro.
    const range = await renderMdRange(mdFile, { from: "Three" });
    expect(range).toContain(
      '<img loading="lazy" decoding="async" src="/assets/mid.png"',
    );
    expect(range).not.toContain('loading="eager"');
    // A range from the top of the file is the top of its page.
    const top = await renderMdRange(join(tempDir, "deep.md"), { to: "Three" });
    expect(top).not.toContain('loading="eager"');
  });

  it("renderMd keeps an image lazy when a long stretch of text comes before it, since the text is then the LCP", async () => {
    // developer-experience opens with about 1,700 characters of text before its first recording, so on a
    // laptop the text is the largest paint and an eager image only competes with it.
    const mdFile = join(tempDir, "long-intro.md");
    await writeFile(
      mdFile,
      `# Page\n\n## Flow\n\n${"A sentence of introduction text. ".repeat(40)}\n\n![Late](/assets/late.png)\n`,
    );
    const html = await renderMd(mdFile);
    expect(html).not.toContain('loading="eager"');
    expect(html).toContain(
      '<img loading="lazy" decoding="async" src="/assets/late.png"',
    );
  });

  it("renderMd keeps the reduced-motion still when it makes the first image eager", async () => {
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8 ", 12, "latin1");
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    const assets = join(tempDir, "src/pages/assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "demo@2x.webp"), webp);
    await writeFile(join(assets, "demo-still@2x.webp"), webp);
    const mdFile = join(tempDir, "hero-still.md");
    await writeFile(mdFile, "Intro.\n\n![Demo](/assets/demo@2x.webp)\n");

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    try {
      expect(await renderMd(mdFile)).toContain(
        '<picture><source media="(prefers-reduced-motion: reduce)" srcset="/assets/demo-still%402x.webp">' +
          '<img loading="eager" width="20" height="10" src="/assets/demo%402x.webp" alt="Demo"></picture>',
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("demoImage renders like a Markdown image and marks recorded demos without boxing other images", async () => {
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8 ", 12, "latin1");
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    await mkdir(join(tempDir, "src/pages/assets/demos"), { recursive: true });
    await writeFile(join(tempDir, "src/pages/assets/demos/tour@2x.webp"), webp);
    await writeFile(
      join(tempDir, "src/pages/assets/demos/tour-still@2x.webp"),
      webp,
    );
    await writeFile(join(tempDir, "src/pages/assets/photo@2x.webp"), webp);

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    try {
      const version = hashOf(webp);
      expect(demoImage("/assets/demos/tour@2x.webp", 'A "quoted" tour')).toBe(
        `<picture><source media="(prefers-reduced-motion: reduce)" srcset="/assets/demos/tour-still%402x.webp?v=${version}">` +
          '<img loading="lazy" decoding="async" class="demo-shot" width="20" height="10" ' +
          `src="/assets/demos/tour%402x.webp?v=${version}" alt="A &quot;quoted&quot; tour"></picture>`,
      );
      // Only the recorded demos opt out of the default image frame.
      expect(demoImage("/assets/photo@2x.webp", "Photo")).not.toContain(
        "demo-shot",
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("demoImage serves a narrow-screen image with its own size, and keeps reduced motion ahead of screen size", async () => {
    const webp = (width: number, height: number) => {
      const header = Buffer.alloc(32);
      header.write("RIFF", 0, "latin1");
      header.write("WEBP", 8, "latin1");
      header.write("VP8 ", 12, "latin1");
      header.writeUInt16LE(width, 26);
      header.writeUInt16LE(height, 28);
      return header;
    };
    const assets = join(tempDir, "src/pages/assets/demos");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "wide@2x.webp"), webp(1100, 360));
    await writeFile(join(assets, "wide-still@2x.webp"), webp(1100, 360));
    await writeFile(join(assets, "tall@2x.webp"), webp(660, 700));
    await writeFile(join(assets, "tall-still@2x.webp"), webp(660, 700));

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    try {
      const html = demoImage("/assets/demos/wide@2x.webp", "Tour", {
        src: "/assets/demos/tall@2x.webp",
        maxWidth: 760,
      });
      const sources = [...html.matchAll(/<source [^>]*>/g)].map(
        (match) => match[0],
      );
      const wide = hashOf(webp(1100, 360));
      const tall = hashOf(webp(660, 700));
      expect(sources).toEqual([
        `<source media="(max-width: 760px) and (prefers-reduced-motion: reduce)" srcset="/assets/demos/tall-still%402x.webp?v=${tall}" width="330" height="350">`,
        `<source media="(prefers-reduced-motion: reduce)" srcset="/assets/demos/wide-still%402x.webp?v=${wide}">`,
        `<source media="(max-width: 760px)" srcset="/assets/demos/tall%402x.webp?v=${tall}" width="330" height="350">`,
      ]);
      // The <img> keeps the default image's own size.
      expect(html).toContain(
        `width="550" height="180" src="/assets/demos/wide%402x.webp?v=${wide}"`,
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("versions images in the demo and screenshot folders by content hash, and nothing else", async () => {
    expect(VERSIONED_IMAGE_FOLDERS).toEqual([
      "/assets/demos/",
      "/assets/vscode/",
    ]);
    const bytes = (fill: number) => {
      const header = Buffer.alloc(32, fill);
      header.write("RIFF", 0, "latin1");
      header.write("WEBP", 8, "latin1");
      header.write("VP8 ", 12, "latin1");
      header.writeUInt16LE(40, 26);
      header.writeUInt16LE(20, 28);
      return header;
    };
    await mkdir(join(tempDir, "src/pages/assets/vscode"), { recursive: true });
    await mkdir(join(tempDir, "src/pages/assets/other"), { recursive: true });
    const vscodeFile = join(tempDir, "src/pages/assets/vscode/hover@2x.webp");
    await writeFile(vscodeFile, bytes(1));
    await writeFile(
      join(tempDir, "src/pages/assets/other/photo@2x.webp"),
      bytes(1),
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    try {
      const first = demoImage("/assets/vscode/hover@2x.webp", "Hover");
      expect(first).toContain(
        `src="/assets/vscode/hover%402x.webp?v=${hashOf(bytes(1))}"`,
      );
      // Same bytes give the same URL; different bytes give a different one, even at the same size.
      expect(demoImage("/assets/vscode/hover@2x.webp", "Hover")).toBe(first);
      await writeFile(vscodeFile, bytes(2));
      const second = demoImage("/assets/vscode/hover@2x.webp", "Hover");
      expect(second).toContain(`?v=${hashOf(bytes(2))}`);
      expect(second).not.toBe(first);
      // Folders outside the list are never versioned, because they are not cached forever.
      expect(demoImage("/assets/other/photo@2x.webp", "Photo")).toContain(
        'src="/assets/other/photo%402x.webp"',
      );
      // A missing file renders its plain path instead of throwing.
      expect(demoImage("/assets/vscode/missing@2x.webp", "Gone")).toContain(
        'src="/assets/vscode/missing%402x.webp"',
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("emits image URLs with each path segment percent-encoded, so Workers static assets serves them without a redirect", async () => {
    // Workers static assets 307-redirects any path that differs from its per-segment encodeURIComponent form,
    // so a raw `@` in `demo@2x.webp` would cost every image a round trip. The file on disk keeps its name.
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8 ", 12, "latin1");
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    const demos = join(tempDir, "src/pages/assets/demos");
    await mkdir(demos, { recursive: true });
    await writeFile(join(demos, "tour@2x.webp"), webp);
    await writeFile(join(demos, "tour-still@2x.webp"), webp);
    await writeFile(join(demos, "two words@2x.webp"), webp);
    const mdFile = join(tempDir, "encoded.md");
    await writeFile(
      mdFile,
      "![Tour](/assets/demos/tour@2x.webp)\n\n![Again](/assets/demos/tour%402x.webp)\n",
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    try {
      const version = hashOf(webp);
      const encoded = `/assets/demos/tour%402x.webp?v=${version}`;
      const still = `/assets/demos/tour-still%402x.webp?v=${version}`;
      // Markdown images: the raw name and an already-encoded name give the same URL, never `%2540`.
      const html = await renderMd(mdFile);
      expect(
        html.match(
          new RegExp(
            `src="${encoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
            "g",
          ),
        ),
      ).toHaveLength(2);
      expect(html).toContain(`srcset="${still}"`);
      expect(html).toContain('width="20" height="10"');
      expect(html).not.toContain("%25");
      expect(html).not.toMatch(/(?:src|srcset)="[^"]*@/);
      // demoImage, including an already-encoded argument and a narrow image.
      for (const src of [
        "/assets/demos/tour@2x.webp",
        "/assets/demos/tour%402x.webp",
      ]) {
        const out = demoImage(src, "Tour", {
          src: "/assets/demos/two words@2x.webp",
          maxWidth: 760,
        });
        expect(out).toContain(`src="${encoded}"`);
        expect(out).toContain(`srcset="${still}"`);
        expect(out).toContain(
          `srcset="/assets/demos/two%20words%402x.webp?v=${version}"`,
        );
        expect(out).not.toMatch(/(?:src|srcset)="[^"]*@/);
      }
      // Paths outside versioned folders and missing files are encoded too, just not versioned.
      expect(demoImage("/assets/demos/missing@2x.webp", "Gone")).toContain(
        'src="/assets/demos/missing%402x.webp"',
      );
      // A query string or fragment the author wrote is kept as written, and the path before it is encoded.
      expect(demoImage("/assets/photo@2x.webp?raw#top", "Photo")).toContain(
        'src="/assets/photo%402x.webp?raw#top"',
      );
      // Absolute and protocol-relative URLs are not site paths: they pass through untouched.
      expect(demoImage("https://example.com/a@2x.webp", "Remote")).toContain(
        'src="https://example.com/a@2x.webp"',
      );
      expect(demoImage("//example.com/a@2x.webp", "Remote")).toContain(
        'src="//example.com/a@2x.webp"',
      );
      // A malformed escape is left as written instead of throwing, and an encoded `..` is never resolved.
      expect(demoImage("/assets/demos/bad%E0.webp", "Bad")).toContain(
        'src="/assets/demos/bad%E0.webp"',
      );
      expect(
        demoImage("/assets/demos/%2E%2E/%2E%2E/secret.webp", "Up"),
      ).not.toMatch(/width=|\?v=/);
      // A query string the author wrote is escaped for the attribute it lands in.
      expect(demoImage('/assets/photo.webp?a=1&b="2"', "Photo")).toContain(
        'src="/assets/photo.webp?a=1&amp;b=&quot;2&quot;"',
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it("reads a Markdown image path through marked's HTML escaping, so names with & or ' find their file", async () => {
    // marked writes `&` as `&amp;` and `'` as `&#39;` in the src attribute. Read as a raw URL, the first names a
    // file that does not exist and the `#` of the second starts a fragment that cuts the path short.
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8 ", 12, "latin1");
    webp.writeUInt16LE(40, 26);
    webp.writeUInt16LE(20, 28);
    const demos = join(tempDir, "src/pages/assets/demos");
    await mkdir(demos, { recursive: true });
    await writeFile(join(demos, "a&b@2x.webp"), webp);
    await writeFile(join(demos, "it's@2x.webp"), webp);
    await writeFile(join(demos, "it's-still@2x.webp"), webp);
    const mdFile = join(tempDir, "entities.md");
    await writeFile(
      mdFile,
      "![Amp](/assets/demos/a&b@2x.webp)\n\n![Apostrophe](/assets/demos/it's@2x.webp)\n\n![Literal](/assets/demos/a&amp;b@2x.webp)\n",
    );

    const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
    try {
      const version = hashOf(webp);
      const html = await renderMd(mdFile);
      expect(html).toContain(
        `width="20" height="10" src="/assets/demos/a%26b%402x.webp?v=${version}" alt="Amp"`,
      );
      expect(html).toContain(
        `srcset="/assets/demos/it's-still%402x.webp?v=${version}"`,
      );
      expect(html).toContain(
        `width="20" height="10" src="/assets/demos/it's%402x.webp?v=${version}" alt="Apostrophe"`,
      );
      // CommonMark decodes an entity in a link destination, so `&amp;` written in Markdown also means `&`.
      expect(html).toContain(
        `width="20" height="10" src="/assets/demos/a%26b%402x.webp?v=${version}" alt="Literal"`,
      );
      expect(html).not.toContain("%26amp%3B%402x");
      expect(html).not.toContain("%26%2339%3B");
      expect(html).not.toMatch(/src="[^"]*#/);
    } finally {
      cwd.mockRestore();
    }
  });

  it("renderMd supports skipFirstHeading option", async () => {
    const mdContent = `# Title\n\nSecond heading text.\n\n## Subheading\n\nContent.`;
    const mdFile = join(tempDir, "skip.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile, { skipFirstHeading: true });
    expect(html).not.toContain('<h2 id="title">');
    expect(html).toContain('<h2 id="subheading">');
  });

  it("renderMd supports skipToFirstH2 option", async () => {
    const mdContent = `# Title\n\nIntro paragraph.\n\n## Section 1\nFirst content.\n\n## Section 2\nSecond content.`;
    const mdFile = join(tempDir, "skip-h2.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile, { skipToFirstH2: true });
    expect(html).not.toContain("Intro paragraph.");
    expect(html).toContain('<h2 id="section-1">');
    expect(html).toContain('<h2 id="section-2">');
  });

  it("renderMd skipToFirstH2 returns empty when no h2 exists", async () => {
    const mdContent = `# Title\n\nIntro paragraph.`;
    const mdFile = join(tempDir, "skip-h2-none.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMd(mdFile, { skipToFirstH2: true });
    expect(html).toBe("");
  });

  it("renderMdRange renders content between headings", async () => {
    const mdContent = `
# Title

## Section 1
First content.

## Section 2
Second content.

## Section 3
Third content.
`;
    const mdFile = join(tempDir, "range.md");
    await writeFile(mdFile, mdContent);

    const html = await renderMdRange(mdFile, {
      from: "Section 2",
      to: "Section 3",
    });
    expect(html).toContain("Second content.");
    expect(html).not.toContain("First content.");
    expect(html).not.toContain("Third content.");
  });

  it('renderMdRange throws an error if specified "from" heading is not found', async () => {
    const mdContent = `# Title\n\n## Section 1\nContent.`;
    const mdFile = join(tempDir, "missing-from.md");
    await writeFile(mdFile, mdContent);

    await expect(
      renderMdRange(mdFile, { from: "Nonexistent Section" }),
    ).rejects.toThrow(
      '[md-renderer] Heading "from: Nonexistent Section" not found',
    );
  });

  it('renderMdRange throws an error if specified "to" heading is not found', async () => {
    const mdContent = `# Title\n\n## Section 1\nContent.`;
    const mdFile = join(tempDir, "missing-to.md");
    await writeFile(mdFile, mdContent);

    await expect(
      renderMdRange(mdFile, { from: "Section 1", to: "Nonexistent Section" }),
    ).rejects.toThrow(
      '[md-renderer] Heading "to: Nonexistent Section" not found',
    );
  });

  it("renderMd highlights code exactly as the source reads, after undoing marked's escaping", async () => {
    const mdFile = join(tempDir, "escaped.md");
    await writeFile(
      mdFile,
      '```html\n<a title="x" href=\'y\'>&amp; <b></a>\n```\n\n```text\n<i> & "q"\n```\n\n```\nplain <u>\n```\n',
    );
    const html = await renderMd(mdFile);
    expect(html).toContain(
      '<code-block data-bascik-prop-lang="html">&lt;<span data-code-token="kw">a</span> <span data-code-token="attr">title</span>=<span data-code-token="val">"x"</span> <span data-code-token="attr">href</span>=<span data-code-token="val">\'y\'</span>&gt;&amp;amp; &lt;<span data-code-token="kw">b</span>&gt;&lt;/<span data-code-token="kw">a</span>&gt;\n</code-block>',
    );
    // Text blocks keep marked's escaped text: no tokens.
    expect(html).toContain(
      '<code-block data-bascik-prop-lang="text">&lt;i&gt; &amp; &quot;q&quot;\n</code-block>',
    );
    expect(html).toContain(
      '<code-block data-bascik-prop-lang="text">plain &lt;u&gt;\n</code-block>',
    );
  });

  it("extractDemoBlock highlights the block in the language of its fence", async () => {
    const mdFile = join(tempDir, "demo-css.md");
    await writeFile(
      mdFile,
      "<!-- demo:style -->\n\n```css\n.a { color: red; }\n```\n\n<!-- demo:plain -->\n```\n<b>\n```\n",
    );
    expect(await extractDemoBlock(mdFile, "style")).toBe(
      '<span data-code-token="sel">.a</span> { <span data-code-token="attr">color</span>: <span data-code-token="val">red</span>; }',
    );
    expect(await extractDemoBlock(mdFile, "plain")).toBe("&lt;b&gt;");
  });

  it("extractDemoBlock extracts marked fenced code blocks", async () => {
    const mdContent = `
# Demo Page

<!-- demo:source-html -->
\`\`\`html
<div class="card">
  <p>Hello</p>
</div>
\`\`\`
`;
    const mdFile = join(tempDir, "demo.md");
    await writeFile(mdFile, mdContent);

    const code = await extractDemoBlock(mdFile, "source-html");
    expect(code.replace(/<span data-code-token="[a-z]+">|<\/span>/g, "")).toBe(
      '&lt;div class="card"&gt;\n  &lt;p&gt;Hello&lt;/p&gt;\n&lt;/div&gt;',
    );
    expect(code).toContain('<span data-code-token="kw">div</span>');
  });

  it.each([
    ["directly under the marker", "\n"],
    ["after a blank line, as Prettier writes it", "\n\n"],
  ])("stripDemoBlocks removes a demo block %s", async (_, gap) => {
    const mdFile = join(tempDir, "strip-demo.md");
    await writeFile(
      mdFile,
      `Intro.\n\n<!-- demo:usage -->${gap}\`\`\`html\n<p>demo only</p>\n\`\`\`\n\nOutro.\n`,
    );

    const html = await renderMd(mdFile, { stripDemoBlocks: true });
    expect(html).toContain("Intro.");
    expect(html).toContain("Outro.");
    expect(html).not.toContain("demo only");
  });

  it.each([
    ["directly under the marker", "\n", "\n"],
    ["with blank lines, as Prettier writes it", "\n\n", "\n\n"],
  ])(
    "stripDemoBlocks removes a demo block whose fence follows a prettier-ignore line %s",
    async (_, before, after) => {
      // A verbatim Output block (the request-time pass-through demo) keeps its bytes by telling Prettier to skip
      // the fence. The marker, the prettier-ignore line, and the fence must all leave the page HTML together.
      const mdFile = join(tempDir, "strip-demo-ignore.md");
      await writeFile(
        mdFile,
        `Intro.\n\n<!-- demo:rtc-out -->${before}<!-- prettier-ignore -->${after}\`\`\`html\n<p>verbatim only</p>\n\`\`\`\n\nOutro.\n`,
      );

      const html = await renderMd(mdFile, { stripDemoBlocks: true });
      expect(html).toContain("Intro.");
      expect(html).toContain("Outro.");
      expect(html).not.toContain("verbatim only");
      expect(html).not.toContain("prettier-ignore");
      // readDemoBlock still finds the fence past the prettier-ignore line.
      expect(await extractDemoBlock(mdFile, "rtc-out")).toBe(
        '&lt;<span data-code-token="kw">p</span>&gt;verbatim only&lt;/<span data-code-token="kw">p</span>&gt;',
      );
    },
  );

  it("extractDemoBlock finds a block separated from its marker by a blank line", async () => {
    const mdFile = join(tempDir, "demo-gap.md");
    await writeFile(mdFile, "<!-- demo:usage -->\n\n```html\n<p>x</p>\n```\n");
    expect(await extractDemoBlock(mdFile, "usage")).toBe(
      '&lt;<span data-code-token="kw">p</span>&gt;x&lt;/<span data-code-token="kw">p</span>&gt;',
    );
  });

  it("extractDemoBlock returns error comment if marker not found", async () => {
    const mdFile = join(tempDir, "missing.md");
    await writeFile(mdFile, "# No marker");

    const result = await extractDemoBlock(mdFile, "missing-marker");
    expect(result).toContain("<!-- demo:missing-marker not found");
  });

  // A typo'd marker id in a page shell used to ship an empty code block with no message at all.
  it("extractDemoBlock warns with the file and marker when the marker is missing", async () => {
    const mdFile = join(tempDir, "props.md");
    await writeFile(
      mdFile,
      "# Props\n\n<!-- demo:source-html -->\n\n```html\n<p>x</p>\n```\n",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await extractDemoBlock(mdFile, "source-htlm");
      expect(result).toContain("<!-- demo:source-htlm not found");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /\[md-renderer\].*demo:source-htlm.*props\.md/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("extractDemoBlock warns when the marker has no fenced code block after it", async () => {
    const mdFile = join(tempDir, "nofence.md");
    await writeFile(
      mdFile,
      "# Props\n\n<!-- demo:source-html -->\n\nJust prose.\n",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await extractDemoBlock(mdFile, "source-html");
      expect(result).toContain("<!-- no code block after demo:source-html");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /\[md-renderer\].*no code block after demo:source-html.*nofence\.md/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("extractDemoBlock warns once, not twice, when the file is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await extractDemoBlock(join(tempDir, "gone.md"), "demo");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("extractDemoBlock stays quiet when the block exists", async () => {
    const mdFile = join(tempDir, "ok.md");
    await writeFile(mdFile, "<!-- demo:usage -->\n\n```html\n<p>x</p>\n```\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await extractDemoBlock(mdFile, "usage");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("renderMd gracefully handles ENOENT for missing files", async () => {
    const result = await renderMd(join(tempDir, "non-existent.md"));
    expect(result).toContain("callout");
    expect(result).toContain("File not found:");
  });

  it("renderMdRange gracefully handles ENOENT for missing files", async () => {
    const result = await renderMdRange(join(tempDir, "non-existent.md"), {
      from: "Start",
    });
    expect(result).toContain("callout");
    expect(result).toContain("File not found:");
  });

  it("extractDemoBlock gracefully handles ENOENT for missing files", async () => {
    const result = await extractDemoBlock(
      join(tempDir, "non-existent.md"),
      "demo",
    );
    expect(result).toContain("<!-- [md-renderer] File not found:");
  });
});
