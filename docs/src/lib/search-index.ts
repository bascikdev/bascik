/**
 * The docs search index: one entry per page (its intro) and one per h2 or h3 section, read from the content
 * Markdown of every page in nav.ts.
 *
 * scripts/generate-search-index.ts writes it to dist/assets/search-index.<hash>.json (`searchIndexPath()`),
 * whose name changes with the content, so `_headers` can cache that exact file for a year (see
 * pages-headers.ts). The docs-search component fetches that path.
 *
 * It also writes a plain array of entries to the unversioned /assets/search-index.json. That path and shape
 * are public: the installed `bascik` agent skill scripts fetch it from bascik.dev and reject anything but an
 * array (skills/bascik/scripts/lib/project.mjs), and pages loaded before a deploy (an open tab, a bfcache
 * restore) parse it that way too. Changing its shape gives them no results without an error. Its contents
 * change on every deploy, so it is never cached for long.
 *
 * Size: the text is what makes it big (about 1.1 MB of it), and every visitor downloads it on their first
 * search. It is not cut short, because a shorter text drops results: at 300 characters a section, 30% of the
 * results for a set of 130 saved queries changed and some queries found nothing. Instead each page's fields
 * are stored once (see `compactSearchIndex`) and whitespace is collapsed, which the results never showed.
 * The page never loads it before the visitor searches, and /search loads it after the page has loaded.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { headingPlainText, slugFromHeadingHtml } from "./heading-slug.ts";
import { NAV, HOME_SITELINKS, type NavSection } from "./nav.ts";
import { readRouteMarkdown, routeContentCandidates } from "./content-path.ts";
import { pageDescription, pageTitle } from "./meta-tags.ts";

export { metaDescription } from "./meta-tags.ts";
import type {
  CompactSearchIndex,
  SearchEntry,
} from "../components/docs-search/search-logic.ts";

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The unversioned index as a plain array of entries, read by the agent skill scripts. Keep its shape. */
export const PUBLIC_SEARCH_INDEX_PATH = "/assets/search-index.json";

/** Matches every content-hashed index file name the build can write. */
export const SEARCH_INDEX_FILE_PATTERN = /^search-index\.[0-9a-f]{10}\.json$/;

/**
 * Upper bound on the index file. It was 1.43 MB with the text indented as in the Markdown and each page's
 * fields repeated on every section. Raise it only for new content, never to fit a format that wastes space.
 * 1.33 MB: the Deployment Overview (content/deployment/index.md, about 13 KB of text) was missing from the
 * index until the content lookup learned folder index.md files.
 */
export const SEARCH_INDEX_MAX_BYTES = 1_330_000;

/** The longest text kept for one section, in characters. */
const MAX_TEXT = 2000;

/** Searchable text for a section: Markdown removed, whitespace collapsed to single spaces, and capped. */
function searchText(markdown: string): string {
  return stripMd(markdown).slice(0, MAX_TEXT).replace(/\s+/g, " ").trim();
}

export function stripMd(text: string): string {
  const visible: string[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf("<!--", from);
    if (start < 0) {
      visible.push(text.slice(from));
      break;
    }
    visible.push(text.slice(from, start));
    const end = text.indexOf("-->", start + 4);
    if (end < 0) break;
    from = end + 3;
  }
  const cleaned = visible.join(" ");
  return cleaned
    .replace(/```[a-z0-9_-]*\n?([\s\S]*?)```/gi, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^>\s*/gm, "")
    .replace(/^[\s|:\-]+$/gm, "") // table separator rows
    .replace(/\|/g, " ") // table cell pipes → spaces
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The Home entry reads its title and description from pages/index.html so the
 * search result can never drift from what the page declares. It is surfaced
 * only for brand queries (see isNavigationalQuery in search-logic.ts).
 */
async function homeEntry(): Promise<SearchEntry> {
  const homePage = join(docsDir, "src/pages/index.html");
  let title = "Bascik";
  let text = "";
  try {
    const html = await readFile(homePage, "utf8");
    title = pageTitle(html) || title;
    text = pageDescription(html);
  } catch (error) {
    // The Home result still works without them, but a search snippet that silently disappears is a bug to see.
    console.warn(
      `[search-index] warning: could not read the Home page title and description from ${homePage}: ${(error as Error).message}`,
    );
  }
  return {
    title,
    navLabel: "Bascik",
    section: "Home",
    path: "/",
    heading: null,
    text,
    sitelinks: [...HOME_SITELINKS],
  };
}

/** A heading's display text and anchor id, from its Markdown, exactly as md-renderer.ts renders them. */
function renderedHeading(markdown: string): { text: string; id: string } {
  const html = marked.parseInline(markdown, { async: false });
  return { text: headingPlainText(html), id: slugFromHeadingHtml(html) };
}

/**
 * The search entries of one page's Markdown: the intro, then one entry per h2 and h3. The headings come from
 * marked's lexer, as the page and its "On this page" list get them, so a `## ` line inside a fenced code
 * block is text, not a section, and each anchor is the id md-renderer.ts puts on that heading. A page with
 * no h1 is titled by its nav label and indexed from its first line.
 */
export function markdownSearchEntries(
  md: string,
  navLabel: string,
  section: string,
  href: string,
): SearchEntry[] {
  const tokens = marked.lexer(md);
  const hasH1 = tokens.some(
    (token) => token.type === "heading" && token.depth === 1,
  );
  let title: string | null = null;
  const sections: {
    heading: string | null;
    anchor: string | null;
    raw: string[];
  }[] = [];
  let cur: (typeof sections)[number] = { heading: null, anchor: null, raw: [] };
  let pastH1 = !hasH1;
  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 1) {
      title ??= renderedHeading(token.text).text;
      pastH1 = true;
      continue;
    }
    if (!pastH1) continue;
    if (token.type === "heading" && (token.depth === 2 || token.depth === 3)) {
      sections.push(cur);
      const heading = renderedHeading(token.text);
      cur = { heading: heading.text, anchor: heading.id, raw: [] };
    } else {
      cur.raw.push(token.raw);
    }
  }
  sections.push(cur);

  const entries: SearchEntry[] = [
    {
      title: title ?? navLabel,
      navLabel,
      section,
      path: href,
      heading: null,
      text: searchText(sections[0].raw.join("")),
    },
  ];
  for (const sec of sections.slice(1)) {
    if (!sec.heading) continue;
    entries.push({
      title: title ?? navLabel,
      navLabel,
      section,
      path: `${href}#${sec.anchor}`,
      heading: sec.heading,
      text: searchText(sec.raw.join("")),
    });
  }
  return entries;
}

/** Every search entry, Home first, then each nav page with its sections, in nav order. */
export async function buildSearchEntries(
  nav: NavSection[] = NAV,
): Promise<SearchEntry[]> {
  const entries: SearchEntry[] = [await homeEntry()];
  for (const { section, pages } of nav) {
    for (const { href, label } of pages) {
      // External nav entries (e.g. Merch) are off-site and have no local content
      // Markdown, so they are not indexed for search.
      if (/^https?:\/\//i.test(href)) continue;
      const md = (await readRouteMarkdown(href))?.markdown;
      if (!md) {
        // A typo'd href or a moved file: the page still gets a title result, but nothing in it is searchable.
        console.warn(
          `[search-index] warning: no Markdown for nav page ${href}; looked for ${routeContentCandidates(href).join(" or ")}`,
        );
        entries.push({
          title: label,
          navLabel: label,
          section,
          path: href,
          heading: null,
          text: "",
        });
        continue;
      }
      entries.push(...markdownSearchEntries(md, label, section, href));
    }
  }
  return entries;
}

/**
 * The index as written to disk: each page's title, nav label, section, path and sitelinks once in `pages`,
 * and each entry as `[page, heading, anchor, text]`. `expandSearchIndex` in search-logic.ts reverses it.
 */
export function compactSearchIndex(entries: SearchEntry[]): CompactSearchIndex {
  const pages: CompactSearchIndex["pages"] = [];
  const pageIds = new Map<string, number>();
  const rows: CompactSearchIndex["entries"] = [];
  for (const entry of entries) {
    const hash = entry.path.indexOf("#");
    const path = hash === -1 ? entry.path : entry.path.slice(0, hash);
    const anchor = hash === -1 ? null : entry.path.slice(hash + 1);
    const page: CompactSearchIndex["pages"][number] = [
      entry.title ?? entry.navLabel,
      entry.navLabel,
      entry.section ?? "",
      path,
    ];
    if (entry.sitelinks) page.push(entry.sitelinks);
    const key = JSON.stringify(page);
    let id = pageIds.get(key);
    if (id === undefined) {
      id = pages.length;
      pages.push(page);
      pageIds.set(key, id);
    }
    rows.push([id, entry.heading, anchor, entry.text]);
  }
  return { pages, entries: rows };
}

/** The file contents of the index. */
export function searchIndexJson(entries: SearchEntry[]): string {
  return JSON.stringify(compactSearchIndex(entries));
}

/** The public file contents: a plain array of entries, as the agent skill scripts and older pages parse it. */
export function publicSearchIndexJson(entries: SearchEntry[]): string {
  return JSON.stringify(entries);
}

/** Where the build writes the index and the browser fetches it: a site path named by a hash of its contents. */
export function searchIndexPath(json: string): string {
  const version = createHash("sha256").update(json).digest("hex").slice(0, 10);
  return `/assets/search-index.${version}.json`;
}
