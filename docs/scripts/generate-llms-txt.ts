#!/usr/bin/env node
/**
 * generate-llms-txt.ts
 *
 * Generates docs/dist/llms.txt following the llms.txt (v2) specification.
 * It reads the docs structure from nav.ts, extracts brief page descriptions
 * from content Markdown files, and outputs a structured index file directly to dist/.
 *
 * Usage (from docs/):
 *   node scripts/generate-llms-txt.ts
 *
 * Or via Yarn workspace script:
 *   yarn workspace bascik-docs generate:llms
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV } from '../src/lib/nav.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(__dirname, '..');
const outputFile = join(docsDir, 'dist', 'llms.txt');
const siteUrl = 'https://bascik.dev';

function stripMd(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^>\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readMd(href: string): Promise<string | null> {
  const standard = join(docsDir, 'content', href.slice(1) + '.md');
  try { return await readFile(standard, 'utf8'); } catch { }
  const base = join(docsDir, 'content', href.split('/').pop()! + '.md');
  try { return await readFile(base, 'utf8'); } catch { }
  return null;
}

function extractDescription(md: string): string {
  const lines = md.split('\n');
  let pastH1 = false;
  const paragraphLines: string[] = [];

  for (const line of lines) {
    if (/^# /.test(line)) {
      pastH1 = true;
      continue;
    }
    if (!pastH1) continue;
    if (/^#{2,6}\s+/.test(line)) break;
    if (/<!--\s*demo:/.test(line)) break;
    if (/^```/.test(line)) break;

    const trimmed = line.trim();
    if (trimmed.length > 0) {
      paragraphLines.push(trimmed);
      if (paragraphLines.join(' ').length > 200) break;
    } else if (paragraphLines.length > 0) {
      break;
    }
  }

  const raw = paragraphLines.join(' ');
  const cleaned = stripMd(raw);
  if (!cleaned) return '';

  const sentenceMatch = cleaned.match(/.*?[.!?](?:\s|$)/);
  let summary = sentenceMatch ? sentenceMatch[0].trim() : cleaned;
  if (summary.length > 180) {
    summary = summary.slice(0, 177) + '...';
  }
  return summary;
}

const lines: string[] = [];

lines.push('# Bascik');
lines.push('');
lines.push('> Bascik is a build tool for HTML components. It scopes and assembles reusable HTML component files into vanilla HTML pages at build time. It adds zero JavaScript to the output. You write HTML, CSS, and JavaScript; Bascik scopes and assembles them.');
lines.push('');
lines.push('Bascik resolves custom HTML tags to component source HTML, scopes CSS and JavaScript, rewrites DOM selectors, and outputs plain static HTML pages with zero framework runtime.');
lines.push('');
lines.push('For the complete, centralized developer reference and AI assistant instructions, see [SKILL.md](https://bascik.dev/assets/SKILL.md).');
lines.push('');

for (const { section, pages } of NAV) {
  lines.push(`## ${section}`);
  lines.push('');
  for (const { href, label } of pages) {
    const md = await readMd(href);
    const desc = md ? extractDescription(md) : '';
    const url = `${siteUrl}${href}`;
    const descSuffix = desc ? `: ${desc}` : '';
    lines.push(`- [${label}](${url})${descSuffix}`);
  }
  lines.push('');
}

lines.push('## Optional');
lines.push('');
lines.push('- [Complete Skill File](https://bascik.dev/assets/SKILL.md): Complete centralized developer reference and skill guide for LLMs and AI assistants');
lines.push('');

const output = lines.join('\n');
await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, output, 'utf8');
