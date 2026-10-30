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
import { NAV, HOME_SITELINKS } from "./nav.ts";
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
 */
export const SEARCH_INDEX_MAX_BYTES = 1_300_000;

/** The longest text kept for one section, in characters. */
const MAX_TEXT = 2000;

/** Searchable text for a section: Markdown removed, whitespace collapsed to single spaces, and capped. */
function searchText(markdown: string): string {
  return stripMd(markdown).slice(0, MAX_TEXT).replace(/\s+/g, " ").trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
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

async function readMd(href: string): Promise<string | null> {
  const standard = join(docsDir, "content", href.slice(1) + ".md");
  try {
    return await readFile(standard, "utf8");
  } catch {}
  const base = join(docsDir, "content", href.split("/").pop()! + ".md");
  try {
    return await readFile(base, "utf8");
  } catch {}
  return null;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The Home entry reads its title and description from pages/index.html so the
 * search result can never drift from what the page declares. It is surfaced
 * only for brand queries (see isNavigationalQuery in search-logic.ts).
 */
/** The value of `name` in one tag's attributes, in either quote style and in any attribute order. */
function attributeValue(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** The content of `<meta name="description">`, wherever `name` and `content` sit in the tag. */
export function metaDescription(html: string): string | undefined {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (attributeValue(tag, "name")?.toLowerCase() === "description")
      return attributeValue(tag, "content");
  }
  return undefined;
}

async function homeEntry(): Promise<SearchEntry> {
  const homePage = join(docsDir, "src/pages/index.html");
  let title = "Bascik";
  let text = "";
  try {
    const html = await readFile(homePage, "utf8");
    const t = /<title>([^<]*)<\/title>/i.exec(html);
    if (t) title = decodeAttr(t[1]).trim();
    const description = metaDescription(html);
    if (description !== undefined)
      text = decodeAttr(description).trim().replace(/\s+/g, " ");
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

function parseMd(
  md: string,
  navLabel: string,
  section: string,
  href: string,
): SearchEntry[] {
  const lines = md.split("\n");
  const entries: SearchEntry[] = [];

  const h1Line = lines.find((l) => /^# /.test(l));
  const rawTitle = h1Line ? h1Line.slice(2).trim() : navLabel;
  const title = rawTitle
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1");

  const sections: { heading: string | null; lines: string[] }[] = [];
  let cur: { heading: string | null; lines: string[] } = {
    heading: null,
    lines: [],
  };
  let pastH1 = false;
  for (const line of lines) {
    if (/^# /.test(line)) {
      pastH1 = true;
      continue;
    }
    if (!pastH1) continue;
    if (/^#{2,3}\s+/.test(line)) {
      sections.push(cur);
      const rawHeading = line.replace(/^#{2,3}\s+/, "").trim();
      const heading = rawHeading
        .replace(/`([^`\n]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*\n]+)\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
      cur = { heading, lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);

  const introText = searchText(sections[0].lines.join("\n"));
  entries.push({
    title,
    navLabel,
    section,
    path: href,
    heading: null,
    text: introText,
  });

  for (const sec of sections.slice(1)) {
    if (!sec.heading) continue;
    const text = searchText(sec.lines.join("\n"));
    const anchor = slugify(sec.heading);
    entries.push({
      title,
      navLabel,
      section,
      path: `${href}#${anchor}`,
      heading: sec.heading,
      text,
    });
  }

  return entries;
}

/** Every search entry, Home first, then each nav page with its sections, in nav order. */
export async function buildSearchEntries(): Promise<SearchEntry[]> {
  const entries: SearchEntry[] = [await homeEntry()];
  for (const { section, pages } of NAV) {
    for (const { href, label } of pages) {
      // External nav entries (e.g. Merch) are off-site and have no local content
      // Markdown, so they are not indexed for search.
      if (/^https?:\/\//i.test(href)) continue;
      const md = await readMd(href);
      if (!md) {
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
      entries.push(...parseMd(md, label, section, href));
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
