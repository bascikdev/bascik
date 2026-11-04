import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { articleSchema } from "./article-schema.js";

const schemaData = (html: string): Record<string, unknown> => {
  const body = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  if (!body) throw new Error("Missing JSON-LD script");
  return JSON.parse(body);
};

describe("articleSchema", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "article-schema-test-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns empty string if env vars are missing", async () => {
    delete process.env.BASCIK_PAGE_FILE;
    delete process.env.BASCIK_SITE_URL;
    const result = await articleSchema();
    expect(result).toBe("");
  });

  it("extracts headline and description when name precedes content with double quotes", async () => {
    const pageFile = join(tempDir, "index.html");
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Test Title - Bascik Docs</title>
  <meta name="description" content="A test description for the page." />
</head>
<body></body>
</html>`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const result = String(await articleSchema());
    expect(result).toContain('<script type="application/ld+json">');
    expect(schemaData(result)).toMatchObject({
      headline: "Test Title - Bascik Docs",
      description: "A test description for the page.",
      url: "https://bascik.dev/",
      mainEntityOfPage: "https://bascik.dev/",
      inLanguage: "en-US",
    });
  });

  it("points image at a generated social card, never the removed og-image.jpg", async () => {
    const pageFile = join(tempDir, "components.html");
    await writeFile(
      pageFile,
      `<title>Components - Bascik Docs</title><meta name="description" content="Components." />`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const result = String(await articleSchema());
    expect(schemaData(result).image).toBe(
      "https://bascik.dev/assets/og/components.jpg",
    );
    expect(result).not.toContain("og-image.jpg");
  });

  it("declares the official brand profiles on the publisher", async () => {
    const pageFile = join(tempDir, "topic.html");
    await writeFile(
      pageFile,
      `<title>Topic</title><meta name="description" content="Topic." />`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const result = String(await articleSchema());
    expect(result).toContain('"sameAs"');
    expect(result).toContain("https://github.com/bascikdev/bascik");
    expect(result).toContain("https://www.npmjs.com/package/@bascik/bascik");
  });

  it("extracts description when content precedes name or uses single quotes", async () => {
    const pageFile = join(tempDir, "topic.html");
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Topic Page</title>
  <meta content='Single quote description.' name='description' />
</head>
<body></body>
</html>`,
    );

    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";

    const result = String(await articleSchema());
    expect(schemaData(result)).toMatchObject({
      headline: "Topic Page",
      description: "Single quote description.",
      url: "https://bascik.dev/topic",
    });
  });

  async function schemaDescription(metaTag: string): Promise<unknown> {
    const pageFile = join(tempDir, "topic.html");
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Topic Page</title>
  ${metaTag}
</head>
<body></body>
</html>`,
    );
    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";
    const result = String(await articleSchema());
    const json =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(result);
    return json ? JSON.parse(json[1]).description : undefined;
  }

  it("keeps an apostrophe inside a double-quoted description", async () => {
    expect(
      await schemaDescription(
        `<meta name="description" content="Bascik's build tool compiles components." />`,
      ),
    ).toBe("Bascik's build tool compiles components.");
  });

  it("keeps a double quote inside a single-quoted description, in either attribute order", async () => {
    expect(
      await schemaDescription(
        `<meta content='Say "well-rated" books.' name='description' />`,
      ),
    ).toBe('Say "well-rated" books.');
  });

  it("decodes entities written in the description, so the schema says what the page says", async () => {
    expect(
      await schemaDescription(
        `<meta name="description" content="Titles &amp; authors: Bascik&#39;s books." />`,
      ),
    ).toBe("Titles & authors: Bascik's books.");
  });

  it("decodes an entity in the title for the headline", async () => {
    const pageFile = join(tempDir, "topic.html");
    await writeFile(
      pageFile,
      `<!DOCTYPE html>
<html>
<head>
  <title>Benchmarking &amp; Profiling - Bascik Docs</title>
  <meta name="description" content="Measure the book site build." />
</head>
<body></body>
</html>`,
    );
    process.env.BASCIK_PAGE_FILE = pageFile;
    process.env.BASCIK_PAGES_DIR = tempDir;
    process.env.BASCIK_SITE_URL = "https://bascik.dev";
    const result = String(await articleSchema());
    const json =
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(result);
    expect(JSON.parse(json![1]).headline).toBe(
      "Benchmarking & Profiling - Bascik Docs",
    );
  });
});
