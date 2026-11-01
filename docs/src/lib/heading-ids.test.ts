import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";
import { DOCS_DIR } from "./content-path.ts";
import { slugFromHeadingHtml } from "./heading-slug.ts";
import { renderMd } from "./md-renderer.ts";

/** Each h2 and h3 in a Markdown file with its id and the line it starts on. */
function headingIds(
  markdown: string,
): { id: string; text: string; line: number }[] {
  const headings: { id: string; text: string; line: number }[] = [];
  let offset = 0;
  for (const token of marked.lexer(markdown)) {
    if (token.type === "heading" && (token.depth === 2 || token.depth === 3)) {
      const start = markdown.indexOf(token.raw, offset);
      const line = markdown
        .slice(0, start < 0 ? offset : start)
        .split("\n").length;
      headings.push({
        id: slugFromHeadingHtml(
          marked.parseInline(token.text, { async: false }),
        ),
        text: token.text,
        line,
      });
    }
    const at = markdown.indexOf(token.raw, offset);
    if (at >= 0) offset = at + token.raw.length;
  }
  return headings;
}

describe("heading ids", () => {
  // Two headings with one id: the second one's anchor link, its "On this page" entry and its search result
  // all land on the first. Rename one of them.
  it("are unique within every content page", async () => {
    const contentDir = join(DOCS_DIR, "content");
    const files = (await readdir(contentDir, { recursive: true })).filter(
      (file) => file.endsWith(".md"),
    );
    const duplicates: string[] = [];
    for (const file of files) {
      const seen = new Map<string, { text: string; line: number }>();
      const markdown = await readFile(join(contentDir, file), "utf8");
      for (const heading of headingIds(markdown)) {
        const first = seen.get(heading.id);
        if (first)
          duplicates.push(
            `content/${file}:${heading.line} "${heading.text}" has the id #${heading.id} of line ${first.line} "${first.text}"`,
          );
        else seen.set(heading.id, heading);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("finds the line of a repeated heading", () => {
    const markdown = "# T\n\n## Milk Frother\n\nText.\n\n### Milk frother\n";
    expect(headingIds(markdown)).toEqual([
      { id: "milk-frother", text: "Milk Frother", line: 3 },
      { id: "milk-frother", text: "Milk frother", line: 7 },
    ]);
  });
});

describe("renderMd and repeated heading ids", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns with the file and both headings when one render repeats an id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-heading-ids-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const file = join(dir, "dup.md");
      await writeFile(
        file,
        "# Page\n\n## Content-Security-Policy\n\n### Content Security Policy\n",
      );
      await renderMd(file);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /dup\.md.*"Content Security Policy".*#content-security-policy.*"Content-Security-Policy"/,
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not warn when every id is distinct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-heading-ids-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const file = join(dir, "ok.md");
      await writeFile(file, "# Page\n\n## One\n\n### Two\n\n## Three\n");
      await renderMd(file);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
