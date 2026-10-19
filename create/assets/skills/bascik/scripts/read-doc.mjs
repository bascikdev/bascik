#!/usr/bin/env node
// Print the current text of a Bascik docs page, section by section, from the live docs index.
import { parseArgs } from "node:util";
import {
  docsBaseUrl,
  fail,
  fetchDocsIndex,
  isMain,
  normalizeDocPath,
} from "./lib/project.mjs";

const HELP = `Usage: node read-doc.mjs <path> [--json]
       node read-doc.mjs --list

Prints a docs page from https://bascik.dev as plain text, one section per heading.

Examples:
  node read-doc.mjs /scoped-javascript
  node read-doc.mjs switch/from-vue
  node read-doc.mjs https://bascik.dev/dynamic-routes#route-object-format

Options:
  --list   List every docs page path with its title
  --json   Print the sections as JSON
  --help   Show this message

Environment:
  BASCIK_DOCS_URL  Docs origin to query (default https://bascik.dev)`;

const SECTION_LIMIT = 2000;
const pagePathOf = (path) => String(path).replace(/#.*$/, "") || "/";

/** Entries for one page in index order. Exported for tests. */
export function pageSections(entries, path) {
  const target = normalizeDocPath(path);
  return entries.filter((entry) => pagePathOf(entry.path) === target);
}

/** Distinct pages in the index. Exported for tests. */
export function listPages(entries) {
  const pages = new Map();
  for (const entry of entries) {
    const path = pagePathOf(entry.path);
    if (!pages.has(path))
      pages.set(path, { path, title: entry.title, section: entry.section });
  }
  return [...pages.values()];
}

function suggestions(entries, path) {
  const needle = normalizeDocPath(path).replace(/^\//, "").toLowerCase();
  const parts = needle.split(/[/-]/).filter(Boolean);
  return listPages(entries)
    .filter((page) =>
      parts.some((part) => page.path.toLowerCase().includes(part)),
    )
    .slice(0, 8);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      list: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);
  if (!values.list && positionals.length === 0) fail(HELP, 2);

  let entries;
  try {
    entries = await fetchDocsIndex();
  } catch (error) {
    fail(`read-doc: ${error.message}`);
  }
  const base = docsBaseUrl();

  if (values.list) {
    const pages = listPages(entries);
    if (values.json) return console.log(JSON.stringify(pages, null, 2));
    let section;
    for (const page of pages) {
      if (page.section !== section) {
        section = page.section;
        console.log(`\n${section}`);
      }
      console.log(`  ${page.path.padEnd(42)} ${page.title}`);
    }
    return;
  }

  const sections = pageSections(entries, positionals[0]);
  if (sections.length === 0) {
    const close = suggestions(entries, positionals[0]);
    const hint = close.length
      ? `\nDid you mean:\n${close.map((p) => `  ${p.path}  ${p.title}`).join("\n")}`
      : "";
    fail(
      `read-doc: no docs page at ${normalizeDocPath(positionals[0])}.${hint}\nList pages with --list.`,
    );
  }
  if (values.json) return console.log(JSON.stringify(sections, null, 2));

  const pagePath = pagePathOf(sections[0].path);
  console.log(`# ${sections[0].title}\n\nSource: ${base}${pagePath}\n`);
  for (const section of sections) {
    if (section.heading) console.log(`## ${section.heading}\n`);
    console.log(String(section.text ?? "").trim());
    if (String(section.text ?? "").length >= SECTION_LIMIT) {
      console.log(`\n[Section shortened. Full text: ${base}${section.path}]`);
    }
    console.log("");
  }
}

if (isMain(import.meta.url)) await main();
