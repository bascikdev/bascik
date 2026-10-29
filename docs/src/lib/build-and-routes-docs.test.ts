import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DOCS_ROOT = path.resolve(import.meta.dirname, "../..");

async function getMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const parent =
        entry.parentPath ?? (entry as { path?: string }).path ?? dir;
      files.push(path.join(parent, entry.name));
    }
  }
  return files;
}

describe("build and routes script docs contract", () => {
  it("ensures all active <script data-bascik-build> examples use default export and do not use console.log as the content return channel", async () => {
    const contentFiles = await getMarkdownFiles(
      path.join(DOCS_ROOT, "content"),
    );
    const skillFiles = await getMarkdownFiles(
      path.join(DOCS_ROOT, "../skills"),
    );
    expect(skillFiles.length).toBeGreaterThan(0);
    const allFiles = [...contentFiles, ...skillFiles];

    const violations: { file: string; type: string; snippet: string }[] = [];

    const fencedBlockRegex = /```(?:html|js|ts)?\n([\s\S]*?)```/g;
    for (const filePath of allFiles) {
      const relativePath = path.relative(DOCS_ROOT, filePath);
      const content = await readFile(filePath, "utf8");

      let match: RegExpExecArray | null;
      while ((match = fencedBlockRegex.exec(content)) !== null) {
        const block = match[1];
        if (block.includes("data-bascik-build")) {
          // If the block contains an actual executable script tag with data-bascik-build
          const scriptMatch =
            /<script\s+data-bascik-build[^>]*>([\s\S]*?)<\/script>/gi.exec(
              block,
            );
          if (scriptMatch) {
            const scriptBody = scriptMatch[1].trim();
            // Should contain export default
            if (
              !scriptBody.includes("export default") &&
              !scriptMatch[0].includes("src=")
            ) {
              violations.push({
                file: relativePath,
                type: "Missing export default in <script data-bascik-build>",
                snippet: scriptMatch[0].slice(0, 150),
              });
            }
          }
        }

        if (block.includes("data-bascik-routes")) {
          const scriptMatch =
            /<script\s+data-bascik-routes[^>]*>([\s\S]*?)<\/script>/gi.exec(
              block,
            );
          if (scriptMatch) {
            const scriptBody = scriptMatch[1].trim();
            if (
              !scriptBody.includes("export default") &&
              !scriptMatch[0].includes("src=")
            ) {
              violations.push({
                file: relativePath,
                type: "Missing export default in <script data-bascik-routes>",
                snippet: scriptMatch[0].slice(0, 150),
              });
            }
            if (scriptBody.includes("console.log(JSON.stringify")) {
              violations.push({
                file: relativePath,
                type: "Uses console.log(JSON.stringify) in <script data-bascik-routes>",
                snippet: scriptMatch[0].slice(0, 150),
              });
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

/**
 * Request-time component rendering: a server or stream script that returns a
 * component tag gets it rendered with the component's markup and scoped CSS.
 * The rules people need sit beside the worked example on both script pages,
 * the compatibility table carries one row per behavior and per reason a
 * component is left unexpanded (the reason codes `bascik --check` prints), and
 * the FAQ answers the question people ask first.
 */
describe("request-time component rendering docs", () => {
  const read = (relative: string) =>
    readFile(path.join(DOCS_ROOT, "content", relative), "utf8");

  /** The body of the `## heading` section, up to the next h2. */
  const section = (markdown: string, heading: string): string => {
    const lines = markdown.split("\n");
    const start = lines.findIndex((line) => line === `## ${heading}`);
    if (start === -1) return "";
    const end = lines.findIndex(
      (line, index) => index > start && line.startsWith("## "),
    );
    return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
  };

  const UNSUPPORTED_REASONS = [
    "attr-binding-to-scoped-attribute",
    "instance-scoped-server-script",
    "build-script-reads-page-context",
    "attr-src-on-directive-script",
    "scoping-template-unavailable",
  ];

  it.each(["server-scripts.md", "stream-scripts.md"])(
    "%s has a Returning component tags section with the documented rules",
    async (file) => {
      const body = section(await read(file), "Returning component tags");
      expect(body, `${file} needs "## Returning component tags"`).not.toBe("");
      // The worked example returns the site's shared card from a script.
      expect(body).toMatch(/<product-card data-bascik-prop-name=/);
      // Script output is HTML by contract: the tags in it run with the same
      // power as the author's own markup, so outside HTML is sanitized first.
      expect(body).toMatch(/sanitize HTML from a CMS or an API/i);
      expect(body).toContain("no props");
      expect(body).toContain("components.external");
      expect(body).toMatch(/before the first instance/);
      expect(body).toMatch(
        /\[[^\]]+\]\(\/compatibility#request-time-component-rendering\)/,
      );
    },
  );

  it("stream-scripts.md says a nested stream script resolves with its parent", async () => {
    const body = section(
      await read("stream-scripts.md"),
      "Returning component tags",
    );
    expect(body).toMatch(/resolves with (?:its|the) parent/);
  });

  it("compatibility.md has the request-time rows and one row per unsupported reason", async () => {
    const markdown = await read("compatibility.md");
    const body = section(markdown, "Request-Time Component Rendering");
    expect(
      body,
      'compatibility.md needs "## Request-Time Component Rendering"',
    ).not.toBe("");
    const rows = body.split("\n").filter((line) => line.startsWith("| "));
    const rowFor = (needle: string) =>
      rows.find((row) => row.split("|")[1]?.includes(needle));
    for (const capability of [
      "Component tags in server and stream script output",
      "Server and stream scripts inside a returned component",
      "Component CSS from script output",
      "Content Security Policy hashes",
    ]) {
      expect(rowFor(capability), `missing row "${capability}"`).toBeDefined();
    }
    for (const reason of UNSUPPORTED_REASONS) {
      const row = rowFor(`\`${reason}\``);
      expect(row, `missing row for ${reason}`).toBeDefined();
      // Each unsupported row says how to restructure the component.
      expect(row!.split("|")[2]).toContain("Unsupported");
      expect(row!.split("|")[3].length).toBeGreaterThan(80);
    }
  });

  it("compatibility.md no longer says server output never receives element classes", async () => {
    const markdown = await read("compatibility.md");
    expect(markdown).not.toContain(
      "Classes built dynamically at request time (string concatenation, values from a database) are not visible to the build and are not scoped.",
    );
    const row = markdown
      .split("\n")
      .find((line) =>
        line.startsWith(
          "| Class names inside `data-bascik-server` and `data-bascik-stream` script",
        ),
      );
    expect(row).toBeDefined();
    expect(row).toMatch(/element/i);
  });

  it("faq.md answers whether a server script can return a component and links the section", async () => {
    const body = section(
      await read("faq.md"),
      "Can a server script return a component?",
    );
    expect(body).not.toBe("");
    expect(body).toContain("(/server-scripts#returning-component-tags)");
  });

  it("troubleshooting.md carries the request-time component messages", async () => {
    const markdown = await read("testing/troubleshooting.md");
    expect(markdown).toContain(
      "### `Components a server or stream script cannot return`",
    );
    for (const reason of UNSUPPORTED_REASONS)
      expect(markdown).toContain(reason);
    expect(markdown).toMatch(/### .*component instances.*limit/);
    expect(markdown).toMatch(
      /### A component tag in script output reaches the browser as written/,
    );
    // Every RequestRenderError and unexpanded-tag message a user can see,
    // so a search for any of them lands here.
    for (const message of [
      "grew past N characters while expanding components",
      "before rendering, over twice the 4 MiB",
      "would run more than 64 nested component scripts",
      "nests component scripts deeper than 4 levels",
      "collide with each other",
      "is not listed in .bascik/dist/components.json",
    ])
      expect(markdown).toContain(message);
    expect(markdown).toMatch(/### `Rendering <[a-z-]+> .*failed during /);
  });

  it("troubleshooting.md does not send a misspelled tag to bascik --check", async () => {
    const markdown = await read("testing/troubleshooting.md");
    expect(markdown).not.toContain(
      "The production server logs neither, so check in the dev server or with `bascik --check`.",
    );
    expect(markdown).toMatch(/misspelled tag shows only in the dev server log/);
  });

  it("troubleshooting.md's dev log and --check samples name the same line for one component", async () => {
    const markdown = await read("testing/troubleshooting.md");
    const lines = [...markdown.matchAll(/bad-card\/bad-card\.html:(\d+)/g)].map(
      (m) => m[1],
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lines).size).toBe(1);
  });

  it("stream CSS goes to the first slot in document order, not the first to finish", async () => {
    for (const file of ["server-scripts.md", "stream-scripts.md"]) {
      const body = section(await read(file), "Returning component tags");
      expect(body, file).toMatch(
        /first (?:slot )?in document order|first instance in document order/,
      );
      expect(body, file).not.toContain("whichever slot finishes first");
    }
  });

  it("the unexpanded-tag dev log is documented as needing a renderable component", async () => {
    const body = section(
      await read("server-scripts.md"),
      "Returning component tags",
    );
    expect(body).toMatch(
      /at least one component can be rendered at request time/,
    );
  });

  it("scoped-javascript.md does not say class names carry the request-time instance id", async () => {
    const markdown = await read("scoped-javascript.md");
    expect(markdown).not.toContain(
      "Its scoped ids and class names are derived from a request-time instance id.",
    );
  });

  it("internals/server.md names the bounded hasher, not getAttributeNameHash, for the Node host", async () => {
    const markdown = await read("internals/server.md");
    expect(markdown).not.toContain(
      "supplies `getAttributeNameHash` or identity",
    );
    expect(markdown).toContain("createNameHasher");
  });
});

describe("data-bascik-build-once explains why it has no page context", () => {
  const read = (rel: string) =>
    readFile(path.join(DOCS_ROOT, "content", rel), "utf8");

  it("build-scripts.md shows what a page path would do to a run shared by every page", async () => {
    const md = await read("build-scripts.md");
    const section = md.slice(
      md.indexOf("## `data-bascik-build-once`"),
      md.indexOf("## Example Patterns"),
    );
    expect(section).toContain("### Why There Is No Page Path");
    // The failure mode: one run, many pages, so the path would be whichever
    // page happened to be built first, and that varies between builds.
    expect(section).toMatch(/whichever page/i);
    expect(section).toMatch(/in parallel/i);
    expect(section).toMatch(/preload/i);
    expect(section).toContain("data-bascik-build");
  });

  it("environment-variables.md links to the explanation", async () => {
    const md = await read("environment-variables.md");
    expect(md).toContain("/build-scripts#why-there-is-no-page-path");
  });
});
