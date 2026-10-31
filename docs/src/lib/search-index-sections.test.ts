import { describe, expect, it } from "vitest";
import { buildSearchEntries, markdownSearchEntries } from "./search-index.ts";
import { renderMd } from "./md-renderer.ts";
import { DOCS_DIR, routeContentFile } from "./content-path.ts";
import { join } from "node:path";

const sections = (md: string) =>
  markdownSearchEntries(md, "Label", "Section", "/page");

const anchors = (md: string) =>
  sections(md)
    .filter((entry) => entry.heading !== null)
    .map((entry) => entry.path.slice("/page#".length));

describe("search sections follow the rendered headings", () => {
  it("does not treat heading lines inside fenced code as sections", () => {
    const md = [
      "# Page",
      "",
      "Intro.",
      "",
      "## Real",
      "",
      "```md",
      "## Inside a fence",
      "### Also inside",
      "```",
      "",
      "~~~md",
      "## Tilde fence",
      "~~~",
      "",
      "## Next",
    ].join("\n");
    expect(anchors(md)).toEqual(["real", "next"]);
    const real = sections(md).find((entry) => entry.heading === "Real");
    // The fenced lines stay searchable as the section's text.
    expect(real?.text).toContain("Inside a fence");
    expect(real?.text).toContain("Tilde fence");
  });

  it("keeps a shell comment inside a fence as text, not as the page title", () => {
    const md = [
      "# Install",
      "",
      "## Steps",
      "",
      "```sh",
      "# install the frother dependencies",
      "yarn install",
      "```",
    ].join("\n");
    const entries = sections(md);
    expect(entries[0].title).toBe("Install");
    expect(entries.find((entry) => entry.heading === "Steps")?.text).toContain(
      "install the frother dependencies",
    );
  });

  it("anchors and shows a heading written with entities the way the page renders it", () => {
    const md = "# Page\n\n### My page shows &lt;li&gt; as text\n\nBody.\n";
    const [, entry] = sections(md);
    expect(entry.path).toBe("/page#my-page-shows-li-as-text");
    expect(entry.heading).toBe("My page shows <li> as text");
  });

  it("anchors headings with inline code, links, emphasis and punctuation like the renderer", async () => {
    const md = [
      "# Page",
      "",
      "## The `<slot>` element",
      "## Read [the docs](/props) first",
      "### **Bold** and *em* & more",
      "## What's new?",
      "",
      "Setext heading",
      "--------------",
      "",
    ].join("\n");
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "bascik-search-sections-"));
    try {
      const file = join(dir, "page.md");
      await writeFile(file, md);
      const rendered = await renderMd(file);
      const ids = [...rendered.matchAll(/<h[23] id="([^"]*)"/g)].map(
        (match) => match[1],
      );
      expect(anchors(md)).toEqual(ids);
      expect(sections(md).map((entry) => entry.heading)).toEqual([
        null,
        "The <slot> element",
        "Read the docs first",
        "Bold and em & more",
        "What's new?",
        "Setext heading",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A page without an h1 (a forgotten title line) still has searchable sections instead of none.
  it("indexes a page that forgot its h1, titled by its nav label", () => {
    const entries = sections("Intro text.\n\n## Only section\n\nBody.\n");
    expect(entries[0]).toMatchObject({ title: "Label", text: "Intro text." });
    expect(entries[1]).toMatchObject({
      heading: "Only section",
      text: "Body.",
    });
  });
});

describe("every search result lands on a heading the page has", () => {
  it("links each anchored entry to an id the renderer emits for that page", async () => {
    const entries = await buildSearchEntries();
    const ids = new Map<string, Set<string>>();
    const dead: string[] = [];
    for (const entry of entries) {
      const hash = entry.path.indexOf("#");
      if (hash === -1) continue;
      const route = entry.path.slice(0, hash);
      let pageIds = ids.get(route);
      if (!pageIds) {
        const file = routeContentFile(route);
        const html = file ? await renderMd(join(DOCS_DIR, file)) : "";
        pageIds = new Set(
          [...html.matchAll(/<h[23] id="([^"]*)"/g)].map((match) => match[1]),
        );
        ids.set(route, pageIds);
      }
      if (!pageIds.has(entry.path.slice(hash + 1))) dead.push(entry.path);
    }
    expect(dead).toEqual([]);
  });
});
