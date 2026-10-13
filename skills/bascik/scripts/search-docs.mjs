#!/usr/bin/env node
// Search the live Bascik documentation (https://bascik.dev) and print the best matching sections.
import { parseArgs } from 'node:util';
import { docsBaseUrl, fail, fetchDocsIndex, isMain } from './lib/project.mjs';

const HELP = `Usage: node search-docs.mjs <query> [--limit 8] [--json]

Searches the current Bascik docs and prints matching sections with their URLs.
Read a whole page with: node read-doc.mjs <path>

Options:
  --limit <n>  Maximum results (default 8)
  --json       Print results as JSON
  --help       Show this message

Environment:
  BASCIK_DOCS_URL  Docs origin to query (default https://bascik.dev)`;

const tokenize = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9@_.-]+/)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((token) => token.length > 1);

const countOccurrences = (haystack, needle) => {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 20) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

/** Score every index entry against the query. Exported for tests. */
export function rankEntries(entries, query, limit = 8) {
  const tokens = [...new Set(tokenize(query))];
  const phrase = String(query).toLowerCase().trim();
  if (tokens.length === 0) return [];
  const scored = [];
  for (const entry of entries) {
    const title = String(entry.title ?? '').toLowerCase();
    const heading = String(entry.heading ?? '').toLowerCase();
    const label = String(entry.navLabel ?? '').toLowerCase();
    const text = String(entry.text ?? '').toLowerCase();
    let score = 0;
    let matched = 0;
    for (const token of tokens) {
      const inText = countOccurrences(text, token);
      const hit = (title.includes(token) ? 6 : 0) + (heading.includes(token) ? 5 : 0) + (label.includes(token) ? 3 : 0);
      if (hit > 0 || inText > 0) matched++;
      score += hit + Math.min(inText, 6);
    }
    if (matched === 0) continue;
    score *= matched / tokens.length;
    if (phrase.length > 3 && (heading.includes(phrase) || title.includes(phrase))) score += 10;
    if (phrase.length > 3 && text.includes(phrase)) score += 4;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ entry, score }) => ({ ...entry, score: Math.round(score * 10) / 10 }));
}

function excerpt(text, query, size = 260) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  const lower = value.toLowerCase();
  const first = tokenize(query)
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (first ?? 0) - 60);
  const slice = value.slice(start, start + size);
  return `${start > 0 ? '...' : ''}${slice}${start + size < value.length ? '...' : ''}`;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: 'string', default: '8' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return console.log(HELP);
  const query = positionals.join(' ').trim();
  if (!query) fail(HELP, 2);
  const limit = Math.max(1, Number.parseInt(values.limit, 10) || 8);

  let entries;
  try {
    entries = await fetchDocsIndex();
  } catch (error) {
    fail(`search-docs: ${error.message}`);
  }
  const results = rankEntries(entries, query, limit);
  const base = docsBaseUrl();

  if (values.json) {
    console.log(JSON.stringify(results.map((r) => ({ ...r, url: `${base}${r.path}` })), null, 2));
    return;
  }
  if (results.length === 0) {
    console.log(`No docs sections match "${query}". Try fewer or different words, or browse ${base}/llms.txt`);
    return;
  }
  for (const result of results) {
    const where = result.heading ? `${result.title} > ${result.heading}` : result.title;
    console.log(`${where}\n  ${base}${result.path}\n  ${excerpt(result.text, query)}\n`);
  }
  console.log(`Read a full page: node read-doc.mjs ${results[0].path.replace(/#.*$/, '')}`);
}

if (isMain(import.meta.url)) await main();
