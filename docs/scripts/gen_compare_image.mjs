import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import opentype from 'opentype.js';

async function main() {
  let fontBuffer;
  try {
    fontBuffer = await fs.readFile('docs/fonts/CourierNew-700.ttf');
  } catch {
    fontBuffer = await fs.readFile('/System/Library/Fonts/Supplemental/Courier New Bold.ttf');
  }
  const font = opentype.parse(fontBuffer.buffer);

  // Generate vector path for BASCIK
  // font-size=17, x=25, y=20.2, letterSpacing=2 (matching letter-spacing: 2px)
  const fontSize = 17;
  const letterSpacing = 2;
  let currentX = 25;
  const startY = 20.2;
  const pathParts = [];

  for (const char of 'BASCIK') {
    const glyph = font.charToGlyph(char);
    const p = glyph.getPath(currentX, startY, fontSize);
    pathParts.push(p.toPathData(2));
    currentX += glyph.advanceWidth * (fontSize / font.unitsPerEm) + letterSpacing;
  }

  const generatedPath = pathParts.join(' ');

  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(`
  <!DOCTYPE html>
  <html>
  <head>
  <style>
    @font-face {
      font-family: 'Courier New Local';
      src: url('data:font/ttf;base64,${fontBuffer.toString('base64')}') format('truetype');
      font-weight: bold;
    }
    body { background: #111; color: #fff; font-family: sans-serif; padding: 30px; }
    .box { margin-bottom: 30px; background: #1e2022; padding: 24px; border-radius: 12px; border: 1px solid #333; }
    h3 { margin-top: 0; color: #d3ff8d; font-size: 16px; margin-bottom: 16px; }
  </style>
  </head>
  <body>

  <div class="box">
    <h3>1. Native Chromium System 'Courier New' Bold Text (&lt;text letter-spacing="2"&gt;)</h3>
    <svg viewBox="0 0 114 28" width="456" height="112" xmlns="http://www.w3.org/2000/svg">
      <polygon points="7,0 114,0 107,28 0,28" fill="#d3ff8d" />
      <rect x="18" y="9" width="2" height="12" rx="1" fill="#0e0f10" />
      <text x="25" y="20" font-family="'Courier New Local', monospace" font-size="17" font-weight="bold" fill="#0e0f10" letter-spacing="2">BASCIK</text>
    </svg>
  </div>

  <div class="box">
    <h3>2. Exact Opentype.js Generated Vector Path (letter-spacing: 2px)</h3>
    <svg viewBox="0 0 114 28" width="456" height="112" xmlns="http://www.w3.org/2000/svg">
      <polygon points="7,0 114,0 107,28 0,28" fill="#d3ff8d" />
      <rect x="18" y="9" width="2" height="12" rx="1" fill="#0e0f10" />
      <path fill="#0e0f10" d="${generatedPath}" />
    </svg>
  </div>

  </body>
  </html>
  `);

  await page.evaluate(() => document.fonts.ready);
  const screenshot = await page.screenshot({ fullPage: true });
  await fs.writeFile('/tmp/logo-compare-result.png', screenshot);
  console.log('Successfully saved /tmp/logo-compare-result.png');
  await browser.close();
}

main().catch(console.error);
