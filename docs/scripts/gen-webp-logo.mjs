import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

async function generateWebpLogo() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 }); // 2x Retina rendering

  const fontData = await readFile('/System/Library/Fonts/Supplemental/Courier New Bold.ttf');
  const fontBase64 = fontData.toString('base64');

  await page.setContent(`
  <!DOCTYPE html>
  <html>
  <head>
  <style>
    @font-face {
      font-family: 'Courier New Local';
      src: url('data:font/ttf;base64,${fontBase64}') format('truetype');
      font-weight: bold;
    }
    body {
      margin: 0;
      padding: 0;
      background: transparent;
    }
    .logo-wrap {
      display: inline-block;
      line-height: 0;
    }
  </style>
  </head>
  <body>
    <div class="logo-wrap">
      <svg id="logo" viewBox="0 0 114 28" width="114" height="28" xmlns="http://www.w3.org/2000/svg">
        <polygon points="7,0 114,0 107,28 0,28" fill="#d3ff8d" />
        <rect x="18" y="9" width="2" height="12" rx="1" fill="#0e0f10" />
        <text x="25" y="20" font-family="Courier New Local, monospace" font-size="17" font-weight="bold" fill="#0e0f10" letter-spacing="2">BASCIK</text>
      </svg>
    </div>
  </body>
  </html>
  `);

  await page.evaluate(() => document.fonts.ready);
  const logoEl = await page.$('#logo');
  const pngBuffer = await logoEl.screenshot({ omitBackground: true });
  await browser.close();

  // Convert PNG to WebP with sharp
  const webpBuffer = await sharp(pngBuffer)
    .webp({ quality: 95, lossless: true })
    .toBuffer();

  const outPath = 'docs/src/pages/assets/logo.webp';
  await writeFile(outPath, webpBuffer);
  console.log(`Generated ${outPath} (${webpBuffer.length} bytes)`);
}

generateWebpLogo().catch(console.error);
