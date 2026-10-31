/**
 * content-path.ts: one definition of which content Markdown file belongs to a docs route.
 *
 * A route's Markdown is content/<route>.md, or content/<route>/index.md when the route is a folder of pages
 * (`/deployment` is content/deployment/index.md). The search index, llms.txt, the OG cards and the sidebar's
 * "On this page" list all read a page's Markdown through this file, so none of them can miss a page the page
 * shell renders fine, and none can fall back to another page's file of the same last segment.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The docs workspace folder (the one holding content/ and src/). */
export const DOCS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * The content Markdown files a route may use, relative to the docs folder, in the order they are tried.
 * Empty for a route that would climb out of content/.
 */
export function routeContentCandidates(route: string): string[] {
  const path = route.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
  if (!path) return ["content/index.md"];
  if (path.split("/").some((segment) => segment === ".." || segment === "."))
    return [];
  return [`content/${path}.md`, `content/${path}/index.md`];
}

/** The content Markdown file for a route, relative to the docs folder, or null when it has none. */
export function routeContentFile(
  route: string,
  docsDir: string = DOCS_DIR,
): string | null {
  return (
    routeContentCandidates(route).find((file) =>
      existsSync(join(docsDir, file)),
    ) ?? null
  );
}

/** A route's content Markdown and the file it came from, or null when the route has none. */
export async function readRouteMarkdown(
  route: string,
  docsDir: string = DOCS_DIR,
): Promise<{ file: string; markdown: string } | null> {
  for (const file of routeContentCandidates(route)) {
    try {
      return { file, markdown: await readFile(join(docsDir, file), "utf8") };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The route of a page source file under a `pages/` folder (`src/pages/deployment.html` is `/deployment`,
 * `src/pages/switch/index.html` is `/switch`), with either path separator. Null for anything else.
 */
export function pageRoute(pageFile: string | undefined): string | null {
  if (!pageFile) return null;
  // The last pages/ folder in the path, so a project that itself sits under a "pages" folder still works.
  const match = /^(?:.*\/)?pages\/(.+)\.html$/.exec(
    pageFile.replace(/\\/g, "/"),
  );
  if (!match) return null;
  const route = match[1].replace(/(?:^|\/)index$/, "");
  return `/${route}`;
}

/**
 * The absolute path of the content Markdown a page source file renders, found from its route, or null when
 * the file is not a page or its route has no Markdown. The sidebar's "On this page" list reads it.
 */
export function pageContentFile(
  pageFile: string | undefined,
  docsDir: string = DOCS_DIR,
): string | null {
  const route = pageRoute(pageFile);
  if (route === null) return null;
  const file = routeContentFile(route, docsDir);
  return file === null ? null : join(docsDir, file);
}
