import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import config from "../../bascik.config.ts";

/**
 * The build-script cache key folds in the script's literal `./` and `@/` dependencies. A script that reads
 * a Markdown file through a computed path (the sidebar's "On this page" list reads content/<route>.md from
 * BASCIK_PAGE_FILE) is invisible to it, so a warm build serves the TOC of an older Markdown file.
 * Such sources must be listed in scripts.cache.exclude.
 */
const srcDir = join(process.cwd(), "src");

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`);
}

describe("script cache excludes", () => {
  it("lists every source that reads Markdown through a computed path", () => {
    const cache = config.scripts?.cache;
    const patterns = typeof cache === "object" ? (cache.exclude ?? []) : [];
    const excludes = patterns.map(globToRegExp);
    const uncovered = htmlFiles(srcDir)
      .filter((file) =>
        /pageContentFile\(|renderPageTableOfContents\(/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => "src/" + relative(srcDir, file).replace(/\\/g, "/"))
      .filter((rel) => !excludes.some((re) => re.test(rel)));
    expect(uncovered).toEqual([]);
  });
});
