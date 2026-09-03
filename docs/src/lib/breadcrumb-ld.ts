/**
 * Generates a BreadcrumbList JSON-LD script tag for the current page.
 * Only outputs anything for nested pages (section/page-name).
 *
 * Breadcrumb structure:
 *   Bascik > Section (if a parent page exists) > Page title
 *
 * Usage inside a <script data-bascik-build> block:
 *
 *   const { breadcrumbLd } = await import(
 *     pathToFileURL(join(process.cwd(), 'src/lib/breadcrumb-ld.ts')).href
 *   );
 *   console.log(await breadcrumbLd());
 */
import { readFile } from 'node:fs/promises';

// Sections that have their own index page (e.g. /internals, /switch, /testing)
const SECTIONS_WITH_PAGE = new Set(['internals', 'switch', 'testing']);

const SECTION_LABELS: Record<string, string> = {
  internals: 'Internals',
  switch: 'Switch',
  testing: 'Testing & Debugging',
  'how-to': 'How-to',
  resources: 'Resources',
};

export async function breadcrumbLd(): Promise<string> {
  const siteUrl = (process.env.BASCIK_SITE_URL ?? '').replace(/\/$/, '');
  const pageFile = process.env.BASCIK_SOURCE_FILE ?? process.env.BASCIK_PAGE_FILE ?? '';
  const pagesDir = process.env.BASCIK_PAGES_DIR ?? '';

  if (!siteUrl || !pageFile || !pagesDir) return '';

  const relPath = pageFile.startsWith(pagesDir)
    ? pageFile.slice(pagesDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
    : '';

  const parts = relPath.replace(/\.html$/, '').split('/');
  if (parts.length < 2) return ''; // top-level pages don't need breadcrumbs

  const [section] = parts;
  let html: string;
  try {
    html = await readFile(pageFile, 'utf8');
  } catch (err) {
    console.warn(`[breadcrumb-ld] Warning: Could not read page file "${pageFile}": ${(err as Error).message}`);
    return '';
  }
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/);
  // Strip " - Bascik Docs" / " - Bascik Developer Guide" / " - Bascik" suffixes
  const rawPageLabel = titleM
    ? titleM[1].replace(/ - Bascik.*$/, '').trim()
    : parts[parts.length - 1];
  const pageLabel = rawPageLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rawSectionLabel = SECTION_LABELS[section]
    ?? (section[0].toUpperCase() + section.slice(1));
  const sectionLabel = rawSectionLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const items: Array<{ '@type': string; position: number; name: string; item?: string }> = [
    { '@type': 'ListItem', position: 1, name: 'Bascik', item: `${siteUrl}/` },
  ];

  if (SECTIONS_WITH_PAGE.has(section)) {
    items.push({
      '@type': 'ListItem', position: 2,
      name: sectionLabel, item: `${siteUrl}/${section}`,
    });
    items.push({ '@type': 'ListItem', position: 3, name: pageLabel });
  } else {
    items.push({ '@type': 'ListItem', position: 2, name: pageLabel });
  }

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items,
  };

  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2).replace(/</g, '\\u003c')}\n</script>`;
}
