/**
 * Generates OG and Twitter card <meta> tags for the current page.
 * Reads title and description from the raw page file itself, so they never
 * need to be duplicated in the page source.
 *
 * Usage inside a <script data-bascik-build> block:
 *
 *   const { openGraph } = await import(
 *     pathToFileURL(join(process.cwd(), 'src/lib/open-graph.ts')).href
 *   );
 *   console.log(await openGraph());
 */
import { readFile } from 'node:fs/promises';
import { NAV } from './nav.ts';

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : '';
}

function extractDescription(html: string): string {
  const metaRe = /<meta([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = m[1];
    if (/name\s*=\s*["']description["']/i.test(attrs)) {
      const cm = /content\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (cm) return cm[1].trim();
    }
  }
  return '';
}

export async function openGraph(): Promise<string> {
  const siteUrl = (process.env.BASCIK_SITE_URL ?? '').replace(/\/$/, '');
  const pageFile = process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? '';
  const pagesDir = process.env.BASCIK_PAGES_DIR ?? '';

  if (!siteUrl || !pageFile || !pagesDir) return '';

  let html: string;
  try {
    html = await readFile(pageFile, 'utf8');
  } catch (err) {
    console.warn(`[open-graph] Warning: Could not read page file "${pageFile}": ${(err as Error).message}`);
    return '';
  }
  const rawTitle = extractTitle(html);
  const description = extractDescription(html);

  const relPath = pageFile.startsWith(pagesDir)
    ? pageFile.slice(pagesDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
    : '';
  const withoutExt = relPath.replace(/\.html$/, '');
  const routePath = withoutExt === 'index' ? '' : withoutExt.replace(/\/index$/, '/');
  const urlPath = routePath ? `/${routePath}` : '/';
  const url = `${siteUrl}${urlPath}`;

  // TN3156: Do not put site name/branding in og:title (use og:site_name instead).
  const cleanTitle = withoutExt === 'index'
    ? (rawTitle.replace(/^Bascik\s*-\s*/i, '').trim() || 'HTML components. Zero runtime.')
    : (rawTitle.replace(/\s*-\s*Bascik Docs$/i, '').replace(/\s*-\s*Bascik$/i, '').trim() || rawTitle);

  const isNavOrHome = urlPath === '/' || NAV.some((sec) => sec.pages.some((p) => p.href === urlPath));
  const imageSlug = (isNavOrHome && withoutExt !== 'index') ? withoutExt.replace(/\//g, '-') : 'home';
  const imageUrl = `${siteUrl}/assets/og/${imageSlug}.jpg`;

  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Bascik" />`,
    `<meta property="og:url" content="${escapeHtmlAttr(url)}" />`,
    `<meta property="og:locale" content="en_US" />`,
  ];
  if (cleanTitle) tags.push(`<meta property="og:title" content="${escapeHtmlAttr(cleanTitle)}" />`);
  if (description) {
    tags.push(`<meta property="og:description" content="${escapeHtmlAttr(description)}" />`);
  }
  tags.push(`<meta property="og:image" content="${escapeHtmlAttr(imageUrl)}" />`);
  tags.push(`<meta property="og:image:type" content="image/jpeg" />`);
  tags.push(`<meta property="og:image:width" content="1200" />`);
  tags.push(`<meta property="og:image:height" content="630" />`);
  if (cleanTitle) {
    tags.push(`<meta property="og:image:alt" content="${escapeHtmlAttr(cleanTitle)} open graph social card" />`);
  }
  tags.push(`<meta name="twitter:card" content="summary_large_image" />`);
  tags.push(`<meta name="twitter:site" content="@bascikdev" />`);
  if (cleanTitle) tags.push(`<meta name="twitter:title" content="${escapeHtmlAttr(cleanTitle)}" />`);
  if (description) {
    tags.push(`<meta name="twitter:description" content="${escapeHtmlAttr(description)}" />`);
  }
  tags.push(`<meta name="twitter:image" content="${escapeHtmlAttr(imageUrl)}" />`);

  return tags.join('\n');
}
