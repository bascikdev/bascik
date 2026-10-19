// The public skills route to docs pages instead of copying them, so every route must land somewhere real.
// Checks each docs path a skill names (read-doc.mjs arguments, backticked /paths, https://bascik.dev links),
// each #fragment against the page's h2/h3 ids, and each add-example.mjs reference against examples/.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { marked, type Tokens } from "marked";
import { slugFromHeadingHtml } from "../src/lib/heading-slug.ts";
import { createExamplesBundle } from "./examples-bundle.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const skillsDir = join(repoRoot, "skills");
const pagesDir = join(repoRoot, "docs/src/pages");
const contentDir = join(repoRoot, "docs/content");

// Backticked paths that are example values, not docs pages.
const NOT_DOCS = new Set(["/about"]);

function skillFiles(dir = skillsDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : skillFiles(path);
    return /\.(md|mjs)$/.test(entry.name) ? [path] : [];
  });
}

type Reference = { file: string; target: string };

function docsReferences(): Reference[] {
  const found: Reference[] = [];
  for (const file of skillFiles()) {
    const text = readFileSync(file, "utf8");
    const add = (target: string) =>
      found.push({ file: relative(repoRoot, file), target });
    for (const [, arg] of text.matchAll(/read-doc\.mjs\s+([^\s`|)]+)/g)) {
      if (arg.startsWith("-") || /[<$]/.test(arg)) continue;
      add(arg.replace(/^https:\/\/bascik\.dev/, "").replace(/^(?!\/)/, "/"));
    }
    // .mjs scripts hold many path-like strings (comments, site paths); only Markdown names docs pages.
    if (!file.endsWith(".md")) continue;
    for (const [, path] of text.matchAll(/`(\/[a-z][a-z0-9/#._-]*)`/g))
      if (!NOT_DOCS.has(path)) add(path);
    for (const [, path] of text.matchAll(
      /https:\/\/bascik\.dev(\/[a-z0-9/#._-]*[a-z0-9_-])/g,
    )) {
      // Published files (assets, llms.txt, .well-known) are checked by their own publishing tests.
      if (!/^\/(assets|\.well-known)\b/.test(path) && !/\.[a-z]+$/.test(path))
        add(path);
    }
  }
  return found;
}

function pageExists(path: string): boolean {
  const clean = path.replace(/\/$/, "") || "/index";
  return (
    existsSync(join(pagesDir, `${clean}.html`)) ||
    existsSync(join(pagesDir, clean, "index.html"))
  );
}

const headingIds = new Map<string, Set<string> | undefined>();
function idsFor(path: string): Set<string> | undefined {
  if (!headingIds.has(path)) {
    const clean = path.replace(/\/$/, "");
    const md = [
      join(contentDir, `${clean}.md`),
      join(contentDir, clean, "index.md"),
    ].find((file) => existsSync(file));
    if (!md) {
      headingIds.set(path, undefined);
    } else {
      const ids = new Set<string>();
      for (const token of marked.lexer(readFileSync(md, "utf8"))) {
        if (token.type === "heading" && (token as Tokens.Heading).depth <= 3) {
          ids.add(
            slugFromHeadingHtml(
              marked.parseInline((token as Tokens.Heading).text) as string,
            ),
          );
        }
      }
      headingIds.set(path, ids);
    }
  }
  return headingIds.get(path);
}

describe("skill links", () => {
  const references = docsReferences();

  it("finds the references it checks", () => {
    expect(references.length).toBeGreaterThan(50);
  });

  it("every docs path a skill names is a docs page", () => {
    const missing = references
      .filter(({ target }) => !pageExists(target.split("#")[0]))
      .map(({ file, target }) => `${file}: ${target}`);
    expect(missing, "fix the link in the skill, or add the page").toEqual([]);
  });

  it("every #fragment a skill names is a heading on that page", () => {
    const broken = references
      .filter(({ target }) => target.includes("#"))
      .filter(({ target }) => {
        const [path, fragment] = target.split("#");
        const ids = idsFor(path);
        return ids === undefined || !ids.has(fragment);
      })
      .map(({ file, target }) => `${file}: ${target}`);
    expect(
      broken,
      "the heading was renamed or the page has no Markdown content",
    ).toEqual([]);
  });

  it("every add-example.mjs reference is a published example file or folder", async () => {
    const bundle = await createExamplesBundle(join(repoRoot, "examples"));
    const byName = new Map(
      bundle.examples.map((example) => [example.name, example]),
    );
    const missing: string[] = [];
    for (const file of skillFiles().filter((f) => f.endsWith(".md"))) {
      for (const [, reference] of readFileSync(file, "utf8").matchAll(
        /add-example\.mjs\s+([a-z][a-z0-9/._-]*[a-z0-9])/g,
      )) {
        const [name, ...rest] = reference.split("/");
        const path = rest.join("/");
        const example = byName.get(name);
        const ok =
          example &&
          (!path ||
            example.files.some(
              (f) =>
                f.path === path ||
                f.path.startsWith(`${path}/`) ||
                f.path.startsWith(`${path}.`),
            ));
        if (!ok) missing.push(`${relative(repoRoot, file)}: ${reference}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
