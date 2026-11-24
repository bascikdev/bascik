/**
 * Tools over the Bascik docs (docs/content/*.md): a keyword search and a page
 * reader. The model is given routes, never file paths.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Tool } from "@bascik/genui";

// This demo lives in the Bascik repository, four folders below its root.
const DOCS_DIR = resolve(
  process.env.DOCS_DIR ??
    join(import.meta.dirname, "..", "..", "..", "..", "docs", "content"),
);
export const DOCS_ORIGIN = "https://bascik.dev";

interface Section {
  route: string;
  page: string;
  heading: string;
  anchor: string;
  text: string;
  words: Map<string, number>;
}

interface Corpus {
  pages: Map<string, { title: string; markdown: string }>;
  sections: Section[];
  /** How many sections each word appears in. */
  spread: Map<string, number>;
}

const tokenize = (text: string): string[] =>
  text.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function markdownFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}

async function buildCorpus(): Promise<Corpus> {
  const pages: Corpus["pages"] = new Map();
  const sections: Section[] = [];
  for (const file of await markdownFiles(DOCS_DIR)) {
    const markdown = await readFile(file, "utf8");
    const route =
      "/" +
      relative(DOCS_DIR, file)
        .split(sep)
        .join("/")
        .replace(/\.md$/, "")
        .replace(/(^|\/)index$/, "");
    const title = /^# (.+)$/m.exec(markdown)?.[1]?.trim() ?? route;
    pages.set(route.replace(/\/$/, "") || "/", { title, markdown });
    // One section per `##` heading; the text before the first is the intro.
    const parts = markdown.split(/^## /m);
    parts.forEach((part, index) => {
      const heading =
        index === 0 ? "" : part.slice(0, part.indexOf("\n")).trim();
      const text = index === 0 ? part : part.slice(part.indexOf("\n") + 1);
      const words = new Map<string, number>();
      for (const word of tokenize(text)) {
        words.set(word, (words.get(word) ?? 0) + 1);
      }
      sections.push({
        route: route.replace(/\/$/, "") || "/",
        page: title,
        heading,
        anchor: heading ? `#${slug(heading)}` : "",
        text,
        words,
      });
    });
  }
  const spread = new Map<string, number>();
  for (const section of sections) {
    for (const word of section.words.keys()) {
      spread.set(word, (spread.get(word) ?? 0) + 1);
    }
  }
  return { pages, sections, spread };
}

let corpus: Promise<Corpus> | undefined;
const loadCorpus = (): Promise<Corpus> => (corpus ??= buildCorpus());

export interface DocHit {
  title: string;
  section: string;
  url: string;
  route: string;
  snippet: string;
}

/** Rank sections by how often they use the query's rarer words. */
export async function searchDocs(query: string, limit = 6): Promise<DocHit[]> {
  const { sections, spread } = await loadCorpus();
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const scored: { section: Section; score: number }[] = [];
  for (const section of sections) {
    let score = 0;
    const heading = `${section.page} ${section.heading}`.toLowerCase();
    for (const term of terms) {
      const count = section.words.get(term) ?? 0;
      const rarity = Math.log(
        1 + sections.length / (1 + (spread.get(term) ?? 0)),
      );
      score += (count / (count + 2)) * rarity;
      if (heading.includes(term)) score += 1.5 * rarity;
    }
    if (score > 0) scored.push({ section, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ section }) => {
    const plain = section.text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      title: section.page,
      section: section.heading,
      url: `${DOCS_ORIGIN}${section.route}${section.anchor}`,
      route: section.route,
      snippet: plain.length > 260 ? `${plain.slice(0, 260)}…` : plain,
    };
  });
}

const MAX_PAGE = 16_000;

export const docsTools: Tool[] = [
  {
    name: "search_docs",
    description:
      "Search the Bascik documentation. Returns the best-matching sections with their page title, section heading, URL, route, and a snippet. Search before answering any question about Bascik, and again with other words if the first results miss.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords, for example: stream script yield",
        },
      },
      required: ["query"],
    },
    note: (input) =>
      `<tool-note>Searching the docs for "${String(input.query).replace(/[<>]/g, "")}"</tool-note>`,
    run: async (input) => JSON.stringify(await searchDocs(String(input.query))),
  },
  {
    name: "read_doc",
    description:
      "Read one documentation page as Markdown, by the route a search result gave (for example /scripts/stream). Read a page before quoting code or details from it.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string", description: "A route from search_docs" },
      },
      required: ["route"],
    },
    note: (input) =>
      `<tool-note>Reading ${String(input.route).replace(/[<>]/g, "")}</tool-note>`,
    run: async (input) => {
      const { pages } = await loadCorpus();
      // The route is looked up in the corpus; it is never used as a path.
      const route =
        String(input.route).split("#")[0]!.replace(/\/$/, "") || "/";
      const page = pages.get(route);
      if (!page)
        throw new Error(`No page at ${route}. Use a route from search_docs.`);
      return page.markdown.length > MAX_PAGE
        ? `${page.markdown.slice(0, MAX_PAGE)}\n\n[Page cut off here.]`
        : page.markdown;
    },
  },
];
