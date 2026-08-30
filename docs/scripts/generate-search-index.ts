/**
 * Generates docs/src/pages/assets/search-index.json from all nav pages.
 * Each entry is one of:
 *   - a page-level entry (heading: null, text = intro paragraph)
 *   - a section-level entry (heading = h2 text, path = /page#anchor)
 *
 * Run via: node scripts/generate-search-index.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV } from '../src/lib/nav.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(__dirname, '..');

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function stripMd(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--/g, '')
    .replace(/-->/g, '')
    .replace(/```[a-z0-9_-]*\n?([\s\S]*?)```/gi, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^>\s*/gm, '')
    .replace(/^[\s|:\-]+$/gm, '')   // table separator rows
    .replace(/\|/g, ' ')            // table cell pipes → spaces
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readMd(href: string): Promise<string | null> {
  const standard = join(docsDir, 'content', href.slice(1) + '.md');
  try { return await readFile(standard, 'utf8'); } catch { }
  const base = join(docsDir, 'content', href.split('/').pop()! + '.md');
  try { return await readFile(base, 'utf8'); } catch { }
  return null;
}

interface SearchEntry {
  title: string;
  navLabel: string;
  section: string;
  path: string;
  heading: string | null;
  text: string;
}

function parseMd(md: string, navLabel: string, section: string, href: string): SearchEntry[] {
  const lines = md.split('\n');
  const entries: SearchEntry[] = [];

  const h1Line = lines.find(l => /^# /.test(l));
  const rawTitle = h1Line ? h1Line.slice(2).trim() : navLabel;
  const title = rawTitle.replace(/`([^`\n]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');

  const sections: { heading: string | null; lines: string[] }[] = [];
  let cur: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  let pastH1 = false;
  for (const line of lines) {
    if (/^# /.test(line)) { pastH1 = true; continue; }
    if (!pastH1) continue;
    if (/^#{2,3}\s+/.test(line)) {
      sections.push(cur);
      const rawHeading = line.replace(/^#{2,3}\s+/, '').trim();
      const heading = rawHeading
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      cur = { heading, lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);

  const introText = stripMd(sections[0].lines.join('\n')).slice(0, 2000);
  entries.push({ title, navLabel, section, path: href, heading: null, text: introText });

  for (const sec of sections.slice(1)) {
    if (!sec.heading) continue;
    const text = stripMd(sec.lines.join('\n')).slice(0, 2000);
    const anchor = slugify(sec.heading);
    entries.push({ title, navLabel, section, path: `${href}#${anchor}`, heading: sec.heading, text });
  }

  return entries;
}

const entries: SearchEntry[] = [];

for (const { section, pages } of NAV) {
  for (const { href, label } of pages) {
    const md = await readMd(href);
    if (!md) {
      entries.push({ title: label, navLabel: label, section, path: href, heading: null, text: '' });
      continue;
    }
    entries.push(...parseMd(md, label, section, href));
  }
}

const outPath = join(docsDir, 'dist/assets/search-index.json');
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(entries));
