#!/usr/bin/env node
// Search Bascik's live compatibility matrix (https://bascik.dev/compatibility) for an HTML, CSS, JavaScript, server,
// or HTTP pattern and print whether Bascik supports it. Dependency-free; Node.js 22.18+.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const HELP = `Usage: node lookup.mjs <query...> [--section <name>] [--limit 15] [--json]
       node lookup.mjs --list

Searches every row of the compatibility tables at https://bascik.dev/compatibility. All query words must appear in
the row. Status: ✓ supported, △ partial, ✕ intentionally unsupported, – not yet supported.

Examples:
  node lookup.mjs container
  node lookup.mjs ":has" element
  node lookup.mjs setProperty
  node lookup.mjs --section "DOM Selector" closest

Options:
  --section <name>  Only rows under a heading containing this text (for example css, "id references", server)
  --limit <n>       Maximum rows to print (default 15)
  --list            List the table sections and their row counts
  --json            Print JSON
  --help            Show this message

Environment:
  BASCIK_DOCS_URL   Docs origin (default https://bascik.dev)`;

const STATUS_LABELS = {
  "Supported and tested": "✓",
  "Partially supported": "△",
  "Intentionally unsupported": "✕",
  "Not yet supported": "–",
};

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name) => {
    if (name[0] === "#")
      return String.fromCodePoint(
        name[1].toLowerCase() === "x"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10),
      );
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
const textOf = (html) =>
  decode(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();

/** The status symbol of a table cell, from its icon label or a literal symbol. */
function statusOf(cellHtml) {
  const label = /aria-label="([^"]+)"/.exec(cellHtml)?.[1];
  if (label && STATUS_LABELS[label]) return STATUS_LABELS[label];
  const text = textOf(cellHtml);
  if (/^(✓|✅)$/.test(text)) return "✓";
  if (/^(△|⚠️?)$/.test(text)) return "△";
  if (/^(✕|✗|🚫|❌)$/.test(text)) return "✕";
  if (/^[–-]$/.test(text)) return "–";
  return undefined;
}

/**
 * Every table row on the page as { section, cells: { column: text }, status }. `section` is "H2 > H3".
 * Exported for tests.
 */
export function parseMatrix(html) {
  const main = /<main\b[\s\S]*<\/main>/i.exec(html)?.[0] ?? html;
  const rows = [];
  let h2 = "";
  let h3 = "";
  const token = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1>|<table\b[\s\S]*?<\/table>/gi;
  for (const match of main.matchAll(token)) {
    if (match[1] === "2") {
      h2 = textOf(match[2]);
      h3 = "";
      continue;
    }
    if (match[1] === "3") {
      h3 = textOf(match[2]);
      continue;
    }
    const table = match[0];
    const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(
      (m) => textOf(m[1]),
    );
    for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cellsHtml = [
        ...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
      ].map((m) => m[1]);
      if (cellsHtml.length === 0) continue;
      const cells = {};
      let status;
      cellsHtml.forEach((cellHtml, index) => {
        const column = headers[index] || `Column ${index + 1}`;
        const symbol = column === "Status" ? statusOf(cellHtml) : undefined;
        if (symbol) status = symbol;
        else cells[column] = textOf(cellHtml);
      });
      rows.push({
        section: h3 ? `${h2} > ${h3}` : h2,
        cells,
        status: status ?? "",
      });
    }
  }
  return rows;
}

/** Rows containing every query word, best matches first. Exported for tests. */
export function searchMatrix(rows, query, { section } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const inSection = section
    ? rows.filter((row) =>
        row.section.toLowerCase().includes(section.toLowerCase()),
      )
    : rows;
  return inSection
    .map((row) => {
      const values = Object.values(row.cells);
      const haystack = `${row.section} ${values.join(" ")}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return undefined;
      const first = (values[0] ?? "").toLowerCase();
      const second = (values[1] ?? "").toLowerCase();
      const score = words.reduce(
        (sum, word) =>
          sum +
          (first.includes(word) ? 3 : 0) +
          (second.includes(word) ? 2 : 0),
        0,
      );
      return { row, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.row);
}

function formatRow(row) {
  const [first, ...rest] = Object.entries(row.cells);
  const lines = [
    `${row.status || " "}  ${first?.[1] ?? ""}    [${row.section}]`,
  ];
  for (const [column, value] of rest)
    if (value) lines.push(`     ${column}: ${value}`);
  return lines.join("\n");
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      section: { type: "string" },
      limit: { type: "string", default: "15" },
      list: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || (!values.list && positionals.length === 0))
    return console.log(HELP);

  const origin = (process.env.BASCIK_DOCS_URL || "https://bascik.dev").replace(
    /\/+$/,
    "",
  );
  const url = `${origin}/compatibility`;
  let html;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
  } catch (error) {
    process.stderr.write(
      `lookup: could not load ${url}: ${error.message}. Check the network, or set BASCIK_DOCS_URL.\n`,
    );
    process.exit(1);
  }
  const rows = parseMatrix(html);
  if (rows.length === 0) {
    process.stderr.write(`lookup: no compatibility tables found at ${url}.\n`);
    process.exit(1);
  }

  if (values.list) {
    const counts = new Map();
    for (const row of rows)
      counts.set(row.section, (counts.get(row.section) ?? 0) + 1);
    if (values.json)
      return console.log(
        JSON.stringify(
          [...counts].map(([section, count]) => ({ section, count })),
          null,
          2,
        ),
      );
    for (const [section, count] of counts)
      console.log(`${String(count).padStart(4)}  ${section}`);
    return;
  }

  const query = positionals.join(" ");
  const matches = searchMatrix(rows, query, { section: values.section });
  const limit = Math.max(1, Number.parseInt(values.limit, 10) || 15);
  if (values.json)
    return console.log(
      JSON.stringify(
        { url, query, total: matches.length, rows: matches.slice(0, limit) },
        null,
        2,
      ),
    );
  if (matches.length === 0) {
    console.log(
      `No compatibility rows match "${query}". Try fewer words, or: node <skills-dir>/bascik/scripts/search-docs.mjs "${query}"`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `${matches.length} row${matches.length === 1 ? "" : "s"} match "${query}" (${url}):\n`,
  );
  console.log(matches.slice(0, limit).map(formatRow).join("\n\n"));
  if (matches.length > limit)
    console.log(
      `\n... ${matches.length - limit} more. Add words, use --section, or raise --limit.`,
    );
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
