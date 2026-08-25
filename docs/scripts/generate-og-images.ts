#!/usr/bin/env node
/**
 * generate-og-images.ts
 *
 * Generates 1200x630 Open Graph social cards (JPEG) for all docs pages directly into
 * docs/dist/assets/og/[slug].jpg.
 *
 * It reads page structure from nav.ts, extracts metadata from content Markdown
 * files (or src/pages/*.html fallback), renders vector card SVG, and converts it
 * to optimized JPEG via @resvg/resvg-js and sharp.
 *
 * Run via:
 *   node scripts/generate-og-images.ts
 *
 * Or via Yarn workspace script:
 *   yarn workspace bascik-docs generate:og
 */

import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { NAV } from './nav.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(__dirname, '..');
const fontsDir = join(docsDir, 'fonts');
const distOgDir = join(docsDir, 'dist', 'assets', 'og');

// Custom font paths for resvg
const fontPaths = [
  join(fontsDir, 'Inter-400.ttf'),
  join(fontsDir, 'Inter-700.ttf'),
  join(fontsDir, 'Inter-800.ttf'),
  join(fontsDir, 'Inter-900.ttf'),
];

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

function wrapText(text: string, maxCharsPerLine: number, maxLines?: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
      if (maxLines && lines.length >= maxLines) break;
    }
  }

  if (currentLine && (!maxLines || lines.length < maxLines)) {
    lines.push(currentLine);
  }

  // Prevent single-word orphan lines on the last line
  if (lines.length >= 2) {
    const lastLine = lines[lines.length - 1];
    const prevLine = lines[lines.length - 2];
    const lastWords = lastLine.split(' ');
    const prevWords = prevLine.split(' ');

    if (lastWords.length === 1 && prevWords.length >= 3) {
      const movedWord = prevWords.pop()!;
      lines[lines.length - 2] = prevWords.join(' ');
      lines[lines.length - 1] = movedWord + ' ' + lastLine;
    }
  }

  return lines;
}

async function readMd(href: string): Promise<string | null> {
  const standard = join(docsDir, 'content', href.slice(1) + '.md');
  try { return await readFile(standard, 'utf8'); } catch { }
  const base = join(docsDir, 'content', href.split('/').pop()! + '.md');
  try { return await readFile(base, 'utf8'); } catch { }
  return null;
}

function extractMetaFromMd(
  md: string,
  fallbackLabel: string
): { title: string; description: string; codeSnippet?: string; codeLang?: string } {
  // Strip multiline HTML comments before line scanning
  const cleanMd = md.replace(/<!--[\s\S]*?-->/g, '');
  const lines = cleanMd.split('\n');
  const h1Line = lines.find((l) => /^# /.test(l));
  const rawTitle = h1Line ? h1Line.slice(2).trim() : fallbackLabel;
  const title = stripMd(rawTitle);

  // 1. Extract first verbatim prose paragraph
  let pastH1 = false;
  const paragraphLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^# /.test(line)) {
      pastH1 = true;
      continue;
    }
    if (!pastH1) continue;

    const trimmed = line.trim();
    if (/^#{2,6}\s+/.test(trimmed)) continue;
    if (trimmed.startsWith('```')) continue;
    if (/^[-*_]{3,}$/.test(trimmed)) continue;
    if (trimmed === '**Legend**' || trimmed.startsWith('**Legend**')) continue;
    if (/^[-*]\s+/.test(trimmed)) continue;
    if (/^\|.*\|$/.test(trimmed)) continue;

    if (trimmed.length === 0) {
      if (paragraphLines.length > 0) break;
      continue;
    }

    paragraphLines.push(line); // Preserve original line content (including backticks)
  }

  // Preserve raw content with inline backticks, just strip other block MD structures
  const description = paragraphLines.join(' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^>\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim() || 'HTML components. Zero runtime.';

  // 2. Extract first fenced code block in the entire document
  let codeSnippet: string | undefined;
  let codeLang: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('```')) {
      codeLang = line.slice(3).trim() || 'code';
      const codeLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim().startsWith('```')) break;
        codeLines.push(lines[j]);
      }
      if (codeLines.length > 0) {
        codeSnippet = codeLines.slice(0, 11).join('\n');
      }
      break;
    }
  }

  return { title, description, codeSnippet, codeLang };
}

function extractMetaFromHtml(html: string): { title: string; description: string } | null {
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/i);
  if (!titleMatch && !descMatch) return null;
  return {
    title: titleMatch ? titleMatch[1].replace(/\s*-\s*Bascik Docs$/, '').trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
  };
}

function formatTextWithCodeStyles(line: string, fill = '#a0a6b5'): string {
  // Regex to match `code` backtick sections
  const parts = line.split(/(`[^`]+`)/g);
  let xml = '';

  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`')) {
      const codeText = part.slice(1, -1);
      // Clean, recognizable inline code styling: Inter font with lime-green color (#d3ff8d)
      xml += `<tspan font-family="Inter" font-weight="700" fill="#d3ff8d">${escapeXml(codeText)}</tspan>`;
    } else {
      xml += `<tspan font-family="Inter" font-weight="400" fill="${fill}">${escapeXml(part)}</tspan>`;
    }
  }

  return xml;
}

function wrapDescription(text: string, maxCharsPerLine = 52, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let currentLine = '';
  let truncated = false;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      if (lines.length === maxLines) {
        truncated = true;
        currentLine = word;
        break;
      }
      currentLine = word;
    }
  }

  if (lines.length < maxLines && currentLine) {
    lines.push(currentLine);
  } else if (lines.length === maxLines && truncated) {
    let last = lines[lines.length - 1];
    if (last.length + 3 > maxCharsPerLine) {
      last = last.slice(0, maxCharsPerLine - 3).trim();
    }
    lines[lines.length - 1] = last.replace(/[.,;!?]+$/, '') + '...';
  }

  return lines;
}

const DEFAULT_LOGO_MARKUP = `<!-- Skewed Polygon Mark -->
  <polygon points="7,0 114,0 107,28 0,28" fill="#d3ff8d" />
  <!-- Blinking Cursor -->
  <rect x="16.9" y="8" width="2" height="12" rx="1" fill="#0e0f10" />
  <!-- Vector Courier New Bold BASCIK Text Path (from bascik-true-font.svg) -->
  <path fill="#0e0f10" stroke="#0e0f10" stroke-width="0.10" stroke-linecap="round" fill-rule="nonzero" d="M25.13 17.60L25.41 17.60L25.41 10.41L25.13 10.41Q24.46 10.41 24.18 10.16Q23.90 9.90 23.90 9.49L23.90 9.49Q23.90 9.08 24.18 8.82Q24.46 8.57 25.13 8.57L25.13 8.57L29.73 8.57Q31.38 8.57 32.38 9.49Q33.38 10.41 33.38 11.67L33.38 11.67Q33.38 12.27 33.15 12.80Q32.92 13.32 32.44 13.77L32.44 13.77Q33.31 14.29 33.74 14.99Q34.18 15.68 34.18 16.56L34.18 16.56Q34.18 17.25 33.87 17.85L33.87 17.85Q33.63 18.31 33.29 18.58L33.29 18.58Q32.84 18.96 32.17 19.19Q31.51 19.43 30.52 19.43L30.52 19.43L25.13 19.43Q24.46 19.43 24.18 19.18Q23.90 18.92 23.90 18.51L23.90 18.51Q23.90 18.11 24.19 17.85Q24.47 17.60 25.13 17.60L25.13 17.60ZM27.25 10.41L27.25 13.08L29.26 13.08Q30.35 13.08 31.06 12.54L31.06 12.54Q31.55 12.17 31.55 11.62L31.55 11.62Q31.55 11.14 31.09 10.78Q30.63 10.41 29.64 10.41L29.64 10.41L27.25 10.41ZM27.25 14.92L27.25 17.60L30.42 17.60Q31.54 17.60 31.99 17.26L31.99 17.26Q32.34 17.01 32.34 16.55L32.34 16.55Q32.34 15.99 31.65 15.46Q30.96 14.92 29.68 14.92L29.68 14.92L27.25 14.92ZM44.31 17.60L43.88 16.48L39.42 16.48L38.97 17.60L39.42 17.60Q40.08 17.60 40.36 17.85Q40.64 18.11 40.64 18.52L40.64 18.52Q40.64 18.92 40.36 19.18Q40.08 19.43 39.42 19.43L39.42 19.43L36.94 19.43Q36.28 19.43 36.00 19.18Q35.72 18.92 35.72 18.51L35.72 18.51Q35.72 18.10 36.01 17.84Q36.31 17.58 36.99 17.60L36.99 17.60L39.87 10.41L38.67 10.41Q38.01 10.41 37.73 10.16Q37.45 9.90 37.45 9.49L37.45 9.49Q37.45 9.08 37.73 8.82Q38.01 8.57 38.67 8.57L38.67 8.57L42.64 8.58L46.29 17.60Q46.94 17.60 47.14 17.74L47.14 17.74Q47.56 18.03 47.56 18.52L47.56 18.52Q47.56 18.92 47.28 19.18Q47.00 19.43 46.34 19.43L46.34 19.43L43.87 19.43Q43.20 19.43 42.92 19.18Q42.64 18.92 42.64 18.51L42.64 18.51Q42.64 18.11 42.92 17.85Q43.20 17.60 43.87 17.60L43.87 17.60L44.31 17.60ZM40.15 14.64L43.11 14.64L41.64 11.01L40.15 14.64ZM51.42 18.97L51.42 18.97Q51.18 19.25 51.03 19.33Q50.88 19.41 50.67 19.41L50.67 19.41Q50.25 19.41 49.99 19.13Q49.74 18.85 49.74 18.20L49.74 18.20L49.74 16.96Q49.74 16.30 49.99 16.01Q50.25 15.73 50.67 15.73L50.67 15.73Q50.99 15.73 51.21 15.90Q51.43 16.07 51.55 16.47Q51.66 16.87 51.79 17.01L51.79 17.01Q52.05 17.29 52.71 17.58Q53.37 17.86 54.16 17.86L54.16 17.86Q55.39 17.86 56.18 17.29L56.18 17.29Q56.68 16.94 56.68 16.43L56.68 16.43Q56.68 16.09 56.44 15.79Q56.19 15.49 55.65 15.29L55.65 15.29Q55.29 15.16 54.05 14.93L54.05 14.93Q52.54 14.65 51.77 14.26Q51.00 13.86 50.55 13.15Q50.11 12.43 50.11 11.60L50.11 11.60Q50.11 10.28 51.21 9.29Q52.31 8.30 54.07 8.30L54.07 8.30Q54.78 8.30 55.38 8.46Q55.99 8.61 56.48 8.94L56.48 8.94Q56.84 8.59 57.20 8.59L57.20 8.59Q57.60 8.59 57.86 8.87Q58.11 9.15 58.11 9.81L58.11 9.81L58.11 11.18Q58.11 11.85 57.86 12.13Q57.60 12.41 57.20 12.41L57.20 12.41Q56.86 12.41 56.61 12.20L56.61 12.20Q56.41 12.05 56.31 11.60Q56.21 11.14 56.06 10.94L56.06 10.94Q55.80 10.60 55.28 10.37Q54.76 10.14 54.08 10.14L54.08 10.14Q53.09 10.14 52.51 10.60Q51.93 11.06 51.93 11.56L51.93 11.56Q51.93 11.90 52.17 12.22Q52.41 12.54 52.86 12.72L52.86 12.72Q53.17 12.84 54.58 13.12Q55.99 13.40 56.75 13.73Q57.50 14.06 58.00 14.77Q58.50 15.47 58.50 16.45L58.50 16.45Q58.50 17.81 57.55 18.62L57.55 18.62Q56.28 19.70 54.31 19.70L54.31 19.70Q53.54 19.70 52.82 19.52Q52.10 19.33 51.42 18.97ZM69.45 9.04L69.45 9.04Q69.62 8.81 69.83 8.69Q70.03 8.58 70.26 8.58L70.26 8.58Q70.66 8.58 70.92 8.86Q71.17 9.13 71.17 9.80L71.17 9.80L71.17 11.35Q71.17 12.02 70.92 12.30Q70.66 12.58 70.26 12.58L70.26 12.58Q69.89 12.58 69.67 12.38L69.67 12.38Q69.45 12.17 69.34 11.60L69.34 11.60Q69.28 11.23 69.09 11.02L69.09 11.02Q68.72 10.62 68.06 10.38Q67.40 10.14 66.74 10.14L66.74 10.14Q65.92 10.14 65.23 10.49Q64.54 10.85 64.01 11.66Q63.48 12.46 63.48 13.57L63.48 13.57L63.48 14.77Q63.48 16.09 64.44 16.98Q65.41 17.86 67.12 17.86L67.12 17.86Q68.14 17.86 68.85 17.59L68.85 17.59Q69.26 17.43 69.72 16.95L69.72 16.95Q70.01 16.66 70.17 16.58Q70.33 16.49 70.54 16.49L70.54 16.49Q70.90 16.49 71.18 16.77Q71.46 17.05 71.46 17.43L71.46 17.43Q71.46 17.80 71.08 18.23L71.08 18.23Q70.54 18.86 69.68 19.22L69.68 19.22Q68.52 19.70 67.13 19.70L67.13 19.70Q65.50 19.70 64.19 19.03L64.19 19.03Q63.13 18.49 62.39 17.33Q61.65 16.17 61.65 14.80L61.65 14.80L61.65 13.56Q61.65 12.12 62.31 10.88Q62.98 9.64 64.16 8.97Q65.34 8.30 66.67 8.30L66.67 8.30Q67.47 8.30 68.16 8.48Q68.85 8.67 69.45 9.04ZM81.82 10.41L79.97 10.41L79.97 17.60L81.82 17.60Q82.48 17.60 82.76 17.85Q83.05 18.11 83.05 18.52L83.05 18.52Q83.05 18.92 82.76 19.18Q82.48 19.43 81.82 19.43L81.82 19.43L76.28 19.43Q75.61 19.43 75.33 19.18Q75.05 18.92 75.05 18.51L75.05 18.51Q75.05 18.11 75.33 17.85Q75.61 17.60 76.28 17.60L76.28 17.60L78.13 17.60L78.13 10.41L76.28 10.41Q75.61 10.41 75.33 10.16Q75.05 9.90 75.05 9.49L75.05 9.49Q75.05 9.08 75.33 8.82Q75.61 8.57 76.28 8.57L76.28 8.57L81.82 8.58Q82.48 8.58 83.05 8.83Q83.05 9.08 83.05 9.49L83.05 9.49Q83.05 9.90 82.76 10.16Q82.48 10.41 81.82 10.41L81.82 10.41ZM90.74 14.60L89.61 15.56L89.61 17.60L90.27 17.60Q90.93 17.60 91.21 17.85Q91.50 18.11 91.50 18.52L91.50 18.52Q91.50 18.92 91.21 19.18Q90.93 19.43 90.27 19.43L90.27 19.43L87.48 19.43Q86.82 19.43 86.54 19.18Q86.26 18.92 86.26 18.51L86.26 18.51Q86.26 18.11 86.54 17.85Q86.83 17.60 87.48 17.60L87.48 17.60L87.77 17.60L87.77 10.41L87.48 10.41Q86.82 10.41 86.54 10.16Q86.26 9.90 86.26 9.49L86.26 9.49Q86.26 9.08 86.54 8.82Q86.82 8.57 87.48 8.57L87.48 8.57L90.27 8.58Q90.93 8.58 91.21 8.83Q91.50 9.08 91.50 9.49L91.50 9.49Q91.50 9.90 91.21 10.16Q90.93 10.41 90.27 10.41L90.27 10.41L89.61 10.41L89.61 13.14L92.87 10.33Q92.58 10.13 92.47 9.95Q92.36 9.77 92.36 9.51L92.36 9.51Q92.65 9.09 92.65 8.83Q92.93 8.57 93.59 8.57L93.59 8.57L95.46 8.58Q96.13 8.58 96.41 8.83Q96.69 9.08 96.69 9.49L96.69 9.49Q96.69 9.89 96.41 10.15Q96.13 10.41 95.53 10.41L95.53 10.41L92.23 13.30Q93.15 13.83 93.96 14.91Q94.77 15.99 95.40 17.60L95.40 17.60L95.89 17.60Q96.55 17.60 96.83 17.85Q97.11 18.11 97.11 18.52L97.11 18.52Q97.11 18.92 96.83 19.18Q96.56 19.43 95.89 19.43L95.89 19.43L94.23 19.43Q93.65 18.06 92.97 16.82L92.97 16.82Q92.42 15.80 91.92 15.34Q91.42 14.88 90.74 14.60L90.74 14.60Z" />`;

export function renderOgSvg(
  title: string,
  section: string,
  description: string,
  isHome = false,
  logoMarkup = DEFAULT_LOGO_MARKUP
): string {
  if (isHome) {
    // 2. Special full-screen Hero layout for the home page (fallback card style)
    const titleLines = wrapText("HTML components. Zero runtime.", 20, 2);
    const descLines = wrapDescription(description, 52, 4);

    const titleStartY = 205; // Pushed down from 175 to add more vertical breathing room below logo
    const descStartY = 355; // Adjusted to match new title position
    const descLineHeight = 38;

    return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Bascik Dark Theme Background (#18191b -> #121314) -->
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#18191b" />
      <stop offset="100%" stop-color="#121314" />
    </linearGradient>

    <!-- Lime Glow Radial Gradient - Large immersive background orb -->
    <radialGradient id="hero-lime-glow" cx="45%" cy="-5%" r="75%">
      <stop offset="0%" stop-color="#d3ff8d" stop-opacity="0.14" />
      <stop offset="100%" stop-color="#d3ff8d" stop-opacity="0" />
    </radialGradient>
  </defs>

  <!-- Base Backgrounds -->
  <rect width="1200" height="630" fill="url(#bg-grad)" />
  <rect width="1200" height="630" fill="url(#hero-lime-glow)" />

  <!-- Outer Card Frame (Bascik surface #1e2022) -->
  <rect x="40" y="40" width="1120" height="550" rx="20" fill="#1e2022" fill-opacity="0.25" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1.5" />

  <!-- Top Parallelogram Accent Line -->
  <polygon points="40,40 1160,40 1160,45 40,45" fill="#d3ff8d" />

  <!-- Header: Bascik Skewed Polygon Logo -->
  <g transform="translate(80, 75)">
    <g transform="scale(1.4285714)">
      ${logoMarkup}
    </g>
  </g>

  <!-- Big Hero Title: split into "HTML components." (white) and "Zero runtime." (lime-green) -->
  <g transform="translate(80, ${titleStartY})">
    <text font-family="Inter" font-size="76" font-weight="900" fill="#f8fafc" letter-spacing="-0.03em">
      <tspan x="0" y="0">HTML components.</tspan>
      <tspan x="0" y="82" fill="#d3ff8d">Zero runtime.</tspan>
    </text>
  </g>

  <!-- Verbatim Description / Paragraph -->
  <g transform="translate(80, ${descStartY})">
    <text font-family="Inter" font-size="28" font-weight="400" fill="#a0a6b5" letter-spacing="-0.01em">
      ${descLines.map((line, i) => `<tspan x="0" y="${i * descLineHeight}">${escapeXml(line)}</tspan>`).join('')}
    </text>
  </g>

  <!-- Footer -->
  <g transform="translate(80, 520)">
    <line x1="0" y1="-25" x2="1040" y2="-25" stroke="rgba(255,255,255,0.08)" stroke-width="1.5" />
    <text x="0" y="27" font-family="Inter" font-size="26" font-weight="900" fill="#d3ff8d" letter-spacing="-0.02em">HTML components. Zero runtime.</text>
    <text x="1040" y="27" text-anchor="end" font-family="Inter" font-size="26" font-weight="700" fill="#d3ff8d">bascik.dev</text>
  </g>
</svg>`;
  }

  // 1. Regular documentation page layout
  const sectionUpper = section.toUpperCase();
  const badgeCharWidth = 12;
  const badgeWidth = Math.max(100, Math.round(sectionUpper.length * badgeCharWidth + 32));

  const titleLines = wrapText(title, 24, 2);
  const descLines = wrapDescription(description, 48, 3);

  const titleStartY = 210; // Pushed down from 180 to add more vertical space below the logo header
  const titleLineHeight = 70;
  const descStartY = titleStartY + titleLines.length * titleLineHeight + 12; // Snug vertical spacing
  const descLineHeight = 38;

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Bascik Dark Theme Background (#18191b -> #121314) -->
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#18191b" />
      <stop offset="100%" stop-color="#121314" />
    </linearGradient>

    <!-- Lime Glow Gradient (#d3ff8d) -->
    <radialGradient id="lime-glow" cx="85%" cy="15%" r="60%">
      <stop offset="0%" stop-color="#d3ff8d" stop-opacity="0.16" />
      <stop offset="100%" stop-color="#d3ff8d" stop-opacity="0" />
    </radialGradient>
  </defs>

  <!-- Base Backgrounds -->
  <rect width="1200" height="630" fill="url(#bg-grad)" />
  <rect width="1200" height="630" fill="url(#lime-glow)" />

  <!-- Outer Card Frame (Bascik surface #1e2022) -->
  <rect x="40" y="40" width="1120" height="550" rx="20" fill="#1e2022" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1.5" />

  <!-- Top Parallelogram Accent Line -->
  <polygon points="40,40 1160,40 1160,45 40,45" fill="#d3ff8d" />

  <!-- Header: Bascik Skewed Polygon Logo + Section Badge -->
  <g transform="translate(80, 75)">
    <!-- Bascik Skewed Polygon Logo (exact vector mark from docs-logo.html scaled to 40px height) -->
    <g transform="scale(1.4285714)">
      ${logoMarkup}
    </g>

    <!-- Skewed Section Badge (Exact same dx = 10 slant as Logo) -->
    <g transform="translate(178, 0)">
      <polygon points="10,0 ${badgeWidth + 10},0 ${badgeWidth},40 0,40" fill="rgba(211,255,141,0.12)" stroke="rgba(211,255,141,0.28)" stroke-width="1.5" />
      <text x="${Math.round((badgeWidth + 10) / 2)}" y="26" text-anchor="middle" font-family="Inter" font-size="15" font-weight="700" fill="#d3ff8d" letter-spacing="1.5">${escapeXml(sectionUpper)}</text>
    </g>
  </g>

  <!-- Main Title (Big, Bold, Hero-style for Mobile & iMessage Previews) -->
  <g transform="translate(80, ${titleStartY})">
    <text font-family="Inter" font-size="64" font-weight="900" fill="#f8fafc" letter-spacing="-0.03em">
      ${titleLines.map((line, i) => `<tspan x="0" y="${i * titleLineHeight}">${escapeXml(line)}</tspan>`).join('')}
    </text>
  </g>

  <!-- Verbatim Subtitle / Description -->
  <g transform="translate(80, ${descStartY})">
    <text font-family="Inter" font-size="28" font-weight="400" fill="#a0a6b5" letter-spacing="-0.01em">
      ${descLines.map((line, i) => `<tspan x="0" y="${i * descLineHeight}">${formatTextWithCodeStyles(line, '#a0a6b5')}</tspan>`).join('')}
    </text>
  </g>

  <!-- Footer -->
  <g transform="translate(80, 520)">
    <line x1="0" y1="-25" x2="1040" y2="-25" stroke="rgba(255,255,255,0.08)" stroke-width="1.5" />
    <text x="0" y="27" font-family="Inter" font-size="26" font-weight="900" fill="#d3ff8d" letter-spacing="-0.02em">HTML components. Zero runtime.</text>
    <text x="1040" y="27" text-anchor="end" font-family="Inter" font-size="26" font-weight="700" fill="#d3ff8d">bascik.dev</text>
  </g>
</svg>`;
}

interface PageMeta {
  slug: string;
  section: string;
  title: string;
  description: string;
  fileName?: string;
  codeSnippet?: string;
}

export async function generateOgImages(): Promise<void> {
  await mkdir(distOgDir, { recursive: true });

  const logoSvgFile = join(docsDir, 'src', 'pages', 'assets', 'bascik-logo.svg');
  let logoMarkup = DEFAULT_LOGO_MARKUP;
  try {
    const rawSvg = await readFile(logoSvgFile, 'utf8');
    logoMarkup = rawSvg
      .replace(/[\s\S]*?<svg[^>]*>/, '')
      .replace(/<\/svg>[\s\S]*/, '')
      .replace(/<animate[\s\S]*?\/>/g, '')
      .trim();
  } catch { }

  const pagesMap = new Map<string, PageMeta>();

  // Process home page + all documentation pages listed in NAV
  const allNavPages = [
    { href: '/', label: 'Bascik', section: 'Overview' },
    ...NAV.flatMap((sec) => sec.pages.map((p) => ({ ...p, section: sec.section }))),
  ];

  for (const { href, label, section } of allNavPages) {
    const slug = href === '/' ? 'home' : href.replace(/^\//, '').replace(/\//g, '-');

    // Try reading meta from corresponding src/pages/*.html shell
    const htmlRelPath = href === '/' ? 'index.html' : href.slice(1) + '.html';
    const htmlFile = join(docsDir, 'src', 'pages', htmlRelPath);
    let htmlMeta: { title: string; description: string } | null = null;
    try {
      const html = await readFile(htmlFile, 'utf8');
      htmlMeta = extractMetaFromHtml(html);
    } catch { }

    const md = await readMd(href);
    const mdMeta = md ? extractMetaFromMd(md, label) : { title: label, description: 'HTML components. Zero runtime.' };

    const title = href === '/' ? 'Bascik' : (mdMeta.title || htmlMeta?.title || label);
    const description = href === '/'
      ? "Bascik is a build tool for HTML components with automatically scoped CSS and JS. Zero runtime. The code that ships is the code you wrote."
      : (mdMeta.description || htmlMeta?.description || 'HTML components. Zero runtime.');
    const codeSnippet = mdMeta.codeSnippet;
    const fileName = `docs/content${href === '/' ? '/overview' : href}.md`;

    pagesMap.set(slug, { slug, section, title, description, fileName, codeSnippet });
  }

  // Render SVG and convert to optimized JPEG in chunked batches with event-loop yielding
  const entries = Array.from(pagesMap.entries());
  const chunkSize = Math.max(2, availableParallelism ? availableParallelism() : 4);

  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async ([slug, { section, title, description }]) => {
        const isHome = slug === 'home';
        const svg = renderOgSvg(title, section, description, isHome, logoMarkup);

        const resvg = new Resvg(svg, {
          fitTo: { mode: 'width', value: 1200 },
          font: {
            fontFiles: fontPaths,
            loadSystemFonts: false,
            defaultFontFamily: 'Inter',
            sansSerifFamily: 'Inter',
            serifFamily: 'Inter',
            monospaceFamily: 'Inter',
          },
        });
        const pngBuffer = resvg.render().asPng();
        const jpgBuffer = await sharp(pngBuffer)
          .jpeg({ quality: 85, progressive: true, mozjpeg: true, chromaSubsampling: '4:4:4' })
          .toBuffer();

        const outFile = join(distOgDir, `${slug}.jpg`);
        await writeFile(outFile, jpgBuffer);
      })
    );
    if (i + chunkSize < entries.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

// Auto-run when executed directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await generateOgImages();
}
