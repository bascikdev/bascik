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

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { NAV } from './nav.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(__dirname, '..');
const rootDir = resolve(docsDir, '..');
const fontsDir = join(rootDir, '.fonts');
const distOgDir = join(docsDir, 'dist', 'assets', 'og');

// Load custom fonts into memory buffers for resvg and base64 embed in SVG
const fontPaths = [
  join(fontsDir, 'Inter-400.ttf'),
  join(fontsDir, 'Inter-700.ttf'),
  join(fontsDir, 'Inter-900.ttf'),
  join(fontsDir, 'CourierPrime-400.ttf'),
  join(fontsDir, 'CourierPrime-700.ttf'),
];

const fontBuffers = await Promise.all(fontPaths.map((p) => readFile(p)));

const fontData = {
  inter400: fontBuffers[0].toString('base64'),
  inter700: fontBuffers[1].toString('base64'),
  inter900: fontBuffers[2].toString('base64'),
  courier400: fontBuffers[3].toString('base64'),
  courier700: fontBuffers[4].toString('base64'),
};

const fontStyles = `
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 400;
      src: url(data:font/truetype;charset=utf-8;base64,${fontData.inter400}) format('truetype');
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 700;
      src: url(data:font/truetype;charset=utf-8;base64,${fontData.inter700}) format('truetype');
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 800;
      src: url(data:font/truetype;charset=utf-8;base64,${fontData.inter900}) format('truetype');
    }
    @font-face {
      font-family: 'Inter';
      font-style: normal;
      font-weight: 900;
      src: url(data:font/truetype;charset=utf-8;base64,${fontData.inter900}) format('truetype');
    }
    @font-face {
      font-family: 'Courier Prime';
      font-style: normal;
      font-weight: 400;
      src: url(data:font/truetype;charset=utf-8;base64,${fontData.courier400}) format('truetype');
    }
    @font-face {
      font-family: 'Courier Prime';
      font-style: normal;
      font-weight: 700;
      src: url(data:font/truetype;charset=utf-8;base64,${fontData.courier700}) format('truetype');
    }
`;

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
      // Clean, recognizable inline code styling: Monospace font with lime-green color (#d3ff8d)
      xml += `<tspan font-family="Courier Prime, 'Courier New', Courier, monospace" font-weight="700" fill="#d3ff8d">${escapeXml(codeText)}</tspan>`;
    } else {
      xml += `<tspan font-family="Inter, Helvetica, Arial, sans-serif" font-weight="400" fill="${fill}">${escapeXml(part)}</tspan>`;
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

export function renderOgSvg(
  title: string,
  section: string,
  description: string,
  isHome = false
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

    <style>
      ${fontStyles}
    </style>
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
    <!-- Actual Bascik Skewed Logo Polygon Mark (Slant: dx = 10 over height = 40) -->
    <polygon points="10,0 150,0 140,40 0,40" fill="#d3ff8d" />
    <rect x="22" y="11" width="3" height="18" rx="1.5" fill="#0e0f10" />
    <!-- Vector Courier New Bold BASCIK Text Path (with letter-spacing: 2.5px) -->
    <path fill="#0e0f10" d="M34.76 24.80L35.11 24.80L35.11 16.18L34.76 16.18Q33.97 16.18 33.63 15.88Q33.29 15.57 33.29 15.08Q33.29 14.58 33.63 14.28Q33.97 13.97 34.76 13.97L40.28 13.97Q42.26 13.97 43.46 15.07Q44.67 16.17 44.67 17.69Q44.67 18.41 44.39 19.04Q44.11 19.67 43.54 20.21Q44.58 20.83 45.10 21.67Q45.62 22.50 45.62 23.55Q45.62 24.39 45.25 25.11Q44.97 25.66 44.56 25.98Q44.01 26.43 43.22 26.72Q42.42 27 41.23 27L34.76 27Q33.97 27 33.63 26.69Q33.29 26.39 33.29 25.89Q33.29 25.41 33.63 25.10Q33.98 24.80 34.76 24.80M37.31 16.18L37.31 19.38L39.72 19.38Q41.02 19.38 41.88 18.73Q42.46 18.29 42.46 17.63Q42.46 17.05 41.92 16.62Q41.37 16.18 40.18 16.18L37.31 16.18M37.31 21.59L37.31 24.80L41.11 24.80Q42.45 24.80 43 24.40Q43.42 24.10 43.42 23.54Q43.42 22.88 42.59 22.23Q41.77 21.59 40.22 21.59 M58.52 24.80L57.99 23.46L52.64 23.46L52.11 24.80L52.64 24.80Q53.44 24.80 53.78 25.10Q54.12 25.41 54.12 25.90Q54.12 26.39 53.78 26.69Q53.44 27 52.64 27L49.68 27Q48.88 27 48.55 26.69Q48.21 26.39 48.21 25.89Q48.21 25.40 48.56 25.09Q48.92 24.78 49.73 24.80L53.19 16.18L51.75 16.18Q50.96 16.18 50.62 15.88Q50.28 15.57 50.28 15.08Q50.28 14.58 50.62 14.28Q50.96 13.97 51.75 13.97L56.51 13.98L60.89 24.80Q61.67 24.80 61.92 24.97Q62.41 25.32 62.41 25.90Q62.41 26.39 62.08 26.69Q61.74 27 60.95 27L57.98 27Q57.19 27 56.85 26.69Q56.51 26.39 56.51 25.89Q56.51 25.41 56.85 25.10Q57.19 24.80 57.98 24.80L58.52 24.80M53.53 21.25L57.08 21.25L55.31 16.89 M67.79 26.44Q67.50 26.79 67.32 26.88Q67.14 26.98 66.89 26.98Q66.38 26.98 66.07 26.64Q65.77 26.30 65.77 25.52L65.77 24.04Q65.77 23.24 66.07 22.90Q66.38 22.56 66.89 22.56Q67.27 22.56 67.54 22.77Q67.80 22.97 67.94 23.45Q68.08 23.93 68.23 24.10Q68.54 24.43 69.33 24.78Q70.13 25.12 71.08 25.12Q72.55 25.12 73.49 24.43Q74.09 24.01 74.09 23.40Q74.09 22.99 73.80 22.63Q73.51 22.27 72.86 22.04Q72.43 21.88 70.94 21.60Q69.13 21.26 68.21 20.79Q67.28 20.32 66.75 19.46Q66.21 18.60 66.21 17.60Q66.21 16.02 67.53 14.83Q68.85 13.65 70.97 13.65Q71.82 13.65 72.54 13.84Q73.27 14.02 73.86 14.41Q74.29 13.99 74.72 13.99Q75.20 13.99 75.51 14.33Q75.81 14.67 75.81 15.45L75.81 17.11Q75.81 17.90 75.51 18.24Q75.20 18.58 74.72 18.58Q74.31 18.58 74.01 18.33Q73.77 18.15 73.65 17.60Q73.54 17.05 73.35 16.82Q73.04 16.41 72.42 16.13Q71.79 15.85 70.98 15.85Q69.79 15.85 69.09 16.40Q68.40 16.96 68.40 17.56Q68.40 17.97 68.69 18.35Q68.97 18.73 69.52 18.94Q69.88 19.09 71.57 19.43Q73.27 19.76 74.17 20.16Q75.08 20.55 75.68 21.40Q76.29 22.25 76.29 23.42Q76.29 25.06 75.14 26.03Q73.61 27.32 71.25 27.32Q70.33 27.32 69.47 27.10Q68.60 26.88 67.79 26.44 M90.16 14.54Q90.37 14.26 90.61 14.12Q90.85 13.98 91.13 13.98Q91.61 13.98 91.92 14.31Q92.22 14.65 92.22 15.44L92.22 17.31Q92.22 18.11 91.92 18.44Q91.61 18.78 91.13 18.78Q90.69 18.78 90.42 18.54Q90.15 18.29 90.02 17.61Q89.95 17.16 89.72 16.91Q89.28 16.43 88.49 16.14Q87.70 15.85 86.91 15.85Q85.92 15.85 85.09 16.28Q84.26 16.71 83.63 17.68Q83 18.64 83 19.97L83 21.40Q83 22.99 84.15 24.06Q85.31 25.12 87.36 25.12Q88.58 25.12 89.43 24.79Q89.92 24.59 90.48 24.02Q90.83 23.68 91.02 23.58Q91.21 23.48 91.46 23.48Q91.90 23.48 92.23 23.81Q92.57 24.14 92.57 24.59Q92.57 25.04 92.12 25.56Q91.46 26.31 90.43 26.74Q89.04 27.32 87.37 27.32Q85.41 27.32 83.84 26.52Q82.58 25.87 81.69 24.48Q80.79 23.09 80.79 21.45L80.79 19.95Q80.79 18.23 81.59 16.75Q82.39 15.26 83.81 14.45Q85.23 13.65 86.82 13.65Q87.78 13.65 88.61 13.87Q89.44 14.09 90.16 14.54 M105.73 16.18L103.51 16.18L103.51 24.80L105.73 24.80Q106.53 24.80 106.87 25.10Q107.21 25.41 107.21 25.90Q107.21 26.39 106.87 26.69Q106.53 27 105.73 27L99.08 27Q98.29 27 97.95 26.69Q97.61 26.39 97.61 25.89Q97.61 25.41 97.95 25.10Q98.29 24.80 99.08 24.80L101.31 24.80L101.31 16.18L99.08 16.18Q98.29 16.18 97.95 15.88Q97.61 15.57 97.61 15.08Q97.61 14.58 97.95 14.28Q98.29 13.97 99.08 13.97L105.73 13.98Q106.53 13.98 106.87 14.28Q107.21 14.58 107.21 15.08Q107.21 15.57 106.87 15.88Q106.53 16.18 105.73 16.18 M117.17 21.21L115.82 22.36L115.82 24.80L116.61 24.80Q117.41 24.80 117.75 25.10Q118.08 25.41 118.08 25.90Q118.08 26.39 117.75 26.69Q117.41 27 116.61 27L113.27 27Q112.48 27 112.14 26.69Q111.80 26.39 111.80 25.89Q111.80 25.41 112.14 25.10Q112.49 24.80 113.27 24.80L113.62 24.80L113.62 16.18L113.27 16.18Q112.48 16.18 112.14 15.88Q111.80 15.57 111.80 15.08Q111.80 14.58 112.14 14.28Q112.48 13.97 113.27 13.97L116.61 13.98Q117.41 13.98 117.75 14.28Q118.08 14.58 118.08 15.08Q118.08 15.57 117.75 15.88Q117.41 16.18 116.61 16.18L115.82 16.18L115.82 19.45L119.73 16.09Q119.38 15.84 119.26 15.62Q119.13 15.41 119.13 15.10Q119.13 14.59 119.47 14.28Q119.80 13.97 120.60 13.97L122.84 13.98Q123.64 13.98 123.98 14.28Q124.32 14.58 124.32 15.08Q124.32 15.56 123.98 15.87Q123.64 16.18 122.92 16.18L118.97 19.64Q120.07 20.28 121.04 21.58Q122.02 22.88 122.77 24.80L123.36 24.80Q124.14 24.80 124.48 25.10Q124.82 25.41 124.82 25.90Q124.82 26.39 124.49 26.69Q124.15 27 123.36 27L121.36 27Q120.67 25.36 119.86 23.86Q119.19 22.65 118.60 22.10Q118 21.54 117.17 21.21" />
  </g>

  <!-- Big Hero Title: split into "HTML components." (white) and "Zero runtime." (lime-green) -->
  <g transform="translate(80, ${titleStartY})">
    <text font-family="Inter, Helvetica, Arial, sans-serif" font-size="76" font-weight="800" fill="#f8fafc" letter-spacing="-0.03em">
      <tspan x="0" y="0">HTML components.</tspan>
      <tspan x="0" y="82" fill="#d3ff8d">Zero runtime.</tspan>
    </text>
  </g>

  <!-- Verbatim Description / Paragraph -->
  <g transform="translate(80, ${descStartY})">
    <text font-family="Inter, Helvetica, Arial, sans-serif" font-size="28" font-weight="400" fill="#a0a6b5" letter-spacing="-0.01em">
      ${descLines.map((line, i) => `<tspan x="0" y="${i * descLineHeight}">${escapeXml(line)}</tspan>`).join('')}
    </text>
  </g>

  <!-- Footer -->
  <g transform="translate(80, 520)">
    <line x1="0" y1="-25" x2="1040" y2="-25" stroke="rgba(255,255,255,0.08)" stroke-width="1.5" />
    <text x="0" y="27" font-family="Inter, Helvetica, Arial, sans-serif" font-size="26" font-weight="800" fill="#d3ff8d" letter-spacing="-0.02em">HTML components. Zero runtime.</text>
    <text x="1040" y="27" text-anchor="end" font-family="Inter, Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#d3ff8d">bascik.dev</text>
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

    <style>
      ${fontStyles}
    </style>
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
    <!-- Actual Bascik Skewed Logo Polygon Mark (Slant: dx = 10 over height = 40) -->
    <polygon points="10,0 150,0 140,40 0,40" fill="#d3ff8d" />
    <rect x="22" y="11" width="3" height="18" rx="1.5" fill="#0e0f10" />
    <!-- Vector Courier New Bold BASCIK Text Path (with letter-spacing: 2.5px) -->
    <path fill="#0e0f10" d="M34.76 24.80L35.11 24.80L35.11 16.18L34.76 16.18Q33.97 16.18 33.63 15.88Q33.29 15.57 33.29 15.08Q33.29 14.58 33.63 14.28Q33.97 13.97 34.76 13.97L40.28 13.97Q42.26 13.97 43.46 15.07Q44.67 16.17 44.67 17.69Q44.67 18.41 44.39 19.04Q44.11 19.67 43.54 20.21Q44.58 20.83 45.10 21.67Q45.62 22.50 45.62 23.55Q45.62 24.39 45.25 25.11Q44.97 25.66 44.56 25.98Q44.01 26.43 43.22 26.72Q42.42 27 41.23 27L34.76 27Q33.97 27 33.63 26.69Q33.29 26.39 33.29 25.89Q33.29 25.41 33.63 25.10Q33.98 24.80 34.76 24.80M37.31 16.18L37.31 19.38L39.72 19.38Q41.02 19.38 41.88 18.73Q42.46 18.29 42.46 17.63Q42.46 17.05 41.92 16.62Q41.37 16.18 40.18 16.18L37.31 16.18M37.31 21.59L37.31 24.80L41.11 24.80Q42.45 24.80 43 24.40Q43.42 24.10 43.42 23.54Q43.42 22.88 42.59 22.23Q41.77 21.59 40.22 21.59 M58.52 24.80L57.99 23.46L52.64 23.46L52.11 24.80L52.64 24.80Q53.44 24.80 53.78 25.10Q54.12 25.41 54.12 25.90Q54.12 26.39 53.78 26.69Q53.44 27 52.64 27L49.68 27Q48.88 27 48.55 26.69Q48.21 26.39 48.21 25.89Q48.21 25.40 48.56 25.09Q48.92 24.78 49.73 24.80L53.19 16.18L51.75 16.18Q50.96 16.18 50.62 15.88Q50.28 15.57 50.28 15.08Q50.28 14.58 50.62 14.28Q50.96 13.97 51.75 13.97L56.51 13.98L60.89 24.80Q61.67 24.80 61.92 24.97Q62.41 25.32 62.41 25.90Q62.41 26.39 62.08 26.69Q61.74 27 60.95 27L57.98 27Q57.19 27 56.85 26.69Q56.51 26.39 56.51 25.89Q56.51 25.41 56.85 25.10Q57.19 24.80 57.98 24.80L58.52 24.80M53.53 21.25L57.08 21.25L55.31 16.89 M67.79 26.44Q67.50 26.79 67.32 26.88Q67.14 26.98 66.89 26.98Q66.38 26.98 66.07 26.64Q65.77 26.30 65.77 25.52L65.77 24.04Q65.77 23.24 66.07 22.90Q66.38 22.56 66.89 22.56Q67.27 22.56 67.54 22.77Q67.80 22.97 67.94 23.45Q68.08 23.93 68.23 24.10Q68.54 24.43 69.33 24.78Q70.13 25.12 71.08 25.12Q72.55 25.12 73.49 24.43Q74.09 24.01 74.09 23.40Q74.09 22.99 73.80 22.63Q73.51 22.27 72.86 22.04Q72.43 21.88 70.94 21.60Q69.13 21.26 68.21 20.79Q67.28 20.32 66.75 19.46Q66.21 18.60 66.21 17.60Q66.21 16.02 67.53 14.83Q68.85 13.65 70.97 13.65Q71.82 13.65 72.54 13.84Q73.27 14.02 73.86 14.41Q74.29 13.99 74.72 13.99Q75.20 13.99 75.51 14.33Q75.81 14.67 75.81 15.45L75.81 17.11Q75.81 17.90 75.51 18.24Q75.20 18.58 74.72 18.58Q74.31 18.58 74.01 18.33Q73.77 18.15 73.65 17.60Q73.54 17.05 73.35 16.82Q73.04 16.41 72.42 16.13Q71.79 15.85 70.98 15.85Q69.79 15.85 69.09 16.40Q68.40 16.96 68.40 17.56Q68.40 17.97 68.69 18.35Q68.97 18.73 69.52 18.94Q69.88 19.09 71.57 19.43Q73.27 19.76 74.17 20.16Q75.08 20.55 75.68 21.40Q76.29 22.25 76.29 23.42Q76.29 25.06 75.14 26.03Q73.61 27.32 71.25 27.32Q70.33 27.32 69.47 27.10Q68.60 26.88 67.79 26.44 M90.16 14.54Q90.37 14.26 90.61 14.12Q90.85 13.98 91.13 13.98Q91.61 13.98 91.92 14.31Q92.22 14.65 92.22 15.44L92.22 17.31Q92.22 18.11 91.92 18.44Q91.61 18.78 91.13 18.78Q90.69 18.78 90.42 18.54Q90.15 18.29 90.02 17.61Q89.95 17.16 89.72 16.91Q89.28 16.43 88.49 16.14Q87.70 15.85 86.91 15.85Q85.92 15.85 85.09 16.28Q84.26 16.71 83.63 17.68Q83 18.64 83 19.97L83 21.40Q83 22.99 84.15 24.06Q85.31 25.12 87.36 25.12Q88.58 25.12 89.43 24.79Q89.92 24.59 90.48 24.02Q90.83 23.68 91.02 23.58Q91.21 23.48 91.46 23.48Q91.90 23.48 92.23 23.81Q92.57 24.14 92.57 24.59Q92.57 25.04 92.12 25.56Q91.46 26.31 90.43 26.74Q89.04 27.32 87.37 27.32Q85.41 27.32 83.84 26.52Q82.58 25.87 81.69 24.48Q80.79 23.09 80.79 21.45L80.79 19.95Q80.79 18.23 81.59 16.75Q82.39 15.26 83.81 14.45Q85.23 13.65 86.82 13.65Q87.78 13.65 88.61 13.87Q89.44 14.09 90.16 14.54 M105.73 16.18L103.51 16.18L103.51 24.80L105.73 24.80Q106.53 24.80 106.87 25.10Q107.21 25.41 107.21 25.90Q107.21 26.39 106.87 26.69Q106.53 27 105.73 27L99.08 27Q98.29 27 97.95 26.69Q97.61 26.39 97.61 25.89Q97.61 25.41 97.95 25.10Q98.29 24.80 99.08 24.80L101.31 24.80L101.31 16.18L99.08 16.18Q98.29 16.18 97.95 15.88Q97.61 15.57 97.61 15.08Q97.61 14.58 97.95 14.28Q98.29 13.97 99.08 13.97L105.73 13.98Q106.53 13.98 106.87 14.28Q107.21 14.58 107.21 15.08Q107.21 15.57 106.87 15.88Q106.53 16.18 105.73 16.18 M117.17 21.21L115.82 22.36L115.82 24.80L116.61 24.80Q117.41 24.80 117.75 25.10Q118.08 25.41 118.08 25.90Q118.08 26.39 117.75 26.69Q117.41 27 116.61 27L113.27 27Q112.48 27 112.14 26.69Q111.80 26.39 111.80 25.89Q111.80 25.41 112.14 25.10Q112.49 24.80 113.27 24.80L113.62 24.80L113.62 16.18L113.27 16.18Q112.48 16.18 112.14 15.88Q111.80 15.57 111.80 15.08Q111.80 14.58 112.14 14.28Q112.48 13.97 113.27 13.97L116.61 13.98Q117.41 13.98 117.75 14.28Q118.08 14.58 118.08 15.08Q118.08 15.57 117.75 15.88Q117.41 16.18 116.61 16.18L115.82 16.18L115.82 19.45L119.73 16.09Q119.38 15.84 119.26 15.62Q119.13 15.41 119.13 15.10Q119.13 14.59 119.47 14.28Q119.80 13.97 120.60 13.97L122.84 13.98Q123.64 13.98 123.98 14.28Q124.32 14.58 124.32 15.08Q124.32 15.56 123.98 15.87Q123.64 16.18 122.92 16.18L118.97 19.64Q120.07 20.28 121.04 21.58Q122.02 22.88 122.77 24.80L123.36 24.80Q124.14 24.80 124.48 25.10Q124.82 25.41 124.82 25.90Q124.82 26.39 124.49 26.69Q124.15 27 123.36 27L121.36 27Q120.67 25.36 119.86 23.86Q119.19 22.65 118.60 22.10Q118 21.54 117.17 21.21" />

    <!-- Skewed Section Badge (Exact same dx = 10 slant as Logo) -->
    <g transform="translate(166, 0)">
      <polygon points="10,0 ${badgeWidth + 10},0 ${badgeWidth},40 0,40" fill="rgba(211,255,141,0.12)" stroke="rgba(211,255,141,0.28)" stroke-width="1.5" />
      <text x="${Math.round((badgeWidth + 10) / 2)}" y="26" text-anchor="middle" font-family="Courier Prime, 'Courier New', Courier, monospace" font-size="15" font-weight="700" fill="#d3ff8d" letter-spacing="1.5">${escapeXml(sectionUpper)}</text>
    </g>
  </g>

  <!-- Main Title (Big, Bold, Hero-style for Mobile & iMessage Previews) -->
  <g transform="translate(80, ${titleStartY})">
    <text font-family="Inter, Helvetica, Arial, sans-serif" font-size="64" font-weight="800" fill="#f8fafc" letter-spacing="-0.03em">
      ${titleLines.map((line, i) => `<tspan x="0" y="${i * titleLineHeight}">${escapeXml(line)}</tspan>`).join('')}
    </text>
  </g>

  <!-- Verbatim Subtitle / Description -->
  <g transform="translate(80, ${descStartY})">
    <text font-family="Inter, Helvetica, Arial, sans-serif" font-size="28" font-weight="400" fill="#a0a6b5" letter-spacing="-0.01em">
      ${descLines.map((line, i) => `<tspan x="0" y="${i * descLineHeight}">${formatTextWithCodeStyles(line, '#a0a6b5')}</tspan>`).join('')}
    </text>
  </g>

  <!-- Footer -->
  <g transform="translate(80, 520)">
    <line x1="0" y1="-25" x2="1040" y2="-25" stroke="rgba(255,255,255,0.08)" stroke-width="1.5" />
    <text x="0" y="27" font-family="Inter, Helvetica, Arial, sans-serif" font-size="26" font-weight="800" fill="#d3ff8d" letter-spacing="-0.02em">HTML components. Zero runtime.</text>
    <text x="1040" y="27" text-anchor="end" font-family="Inter, Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#d3ff8d">bascik.dev</text>
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

  // Render SVG and convert to optimized JPEG for each documentation page
  await Promise.all(
    Array.from(pagesMap.entries()).map(async ([slug, { section, title, description }]) => {
      const isHome = slug === 'home';
      const svg = renderOgSvg(title, section, description, isHome);

      const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: 1200 },
        font: {
          fontBuffers,
          loadSystemFonts: true,
          defaultFontFamily: 'Inter',
        } as unknown as Record<string, unknown>,
      });
      const pngBuffer = resvg.render().asPng();
      const jpgBuffer = await sharp(pngBuffer)
        .jpeg({ quality: 85, progressive: true, mozjpeg: true, chromaSubsampling: '4:4:4' })
        .toBuffer();

      const outFile = join(distOgDir, `${slug}.jpg`);
      await writeFile(outFile, jpgBuffer);
    })
  );
}

// Auto-run when executed directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await generateOgImages();
}
