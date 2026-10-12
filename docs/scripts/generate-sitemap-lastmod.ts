/**
 * Adds git-derived `<lastmod>` dates to dist/sitemap.xml.
 *
 * Runs as a `post` exec script, after Bascik writes the sitemap. See src/lib/sitemap-lastmod.ts for why
 * this does not use Bascik's mtime-based `generate.sitemapLastmod`. It never fails the build: without git
 * or history it leaves the sitemap exactly as generated.
 *
 * Run via pipeline.exec in bascik.config.ts (build only), or directly: node scripts/generate-sitemap-lastmod.ts
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addGitLastmod, findRepoRoot, isShallowRepository, unshallow } from '../src/lib/sitemap-lastmod.ts';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sitemapFile = join(process.env.BASCIK_OUT_DIR ?? join(docsDir, 'dist'), 'sitemap.xml');

if (!existsSync(sitemapFile)) {
  console.warn(`[sitemap-lastmod] ${sitemapFile} not found, skipping. Set BASCIK_SITE_URL so the build writes a sitemap.`);
} else {
  const repoRoot = await findRepoRoot(docsDir);

  // Cloudflare Pages fetches a single commit, so most pages would have no provable date. Fetch the rest of
  // the history there (CF_PAGES=1 is set by Pages). Local and other CI builds are never modified.
  if (repoRoot && process.env.CF_PAGES === '1' && (await isShallowRepository(repoRoot))) {
    console.log('[sitemap-lastmod] shallow clone on Cloudflare Pages, fetching full history...');
    const complete = await unshallow(repoRoot);
    console.log(complete ? '[sitemap-lastmod] full history fetched.' : '[sitemap-lastmod] could not fetch full history, continuing with what is available.');
  }

  const summary = repoRoot ? await addGitLastmod(await readFile(sitemapFile, 'utf8'), docsDir, repoRoot) : null;

  if (!summary) {
    console.warn('[sitemap-lastmod] not a git checkout, leaving sitemap.xml without <lastmod>.');
  } else {
    await writeFile(sitemapFile, summary.xml);
    console.log(`[sitemap-lastmod] added <lastmod> to ${summary.dated} of ${summary.total} URLs.`);
    if (summary.dated < summary.total) {
      const hint = summary.shallow
        ? ' This is a shallow clone, so commits before its cut-off are unknown. Fetch full history (git fetch --unshallow, or fetch-depth: 0 in CI) to date every page.'
        : '';
      console.warn(`[sitemap-lastmod] ${summary.total - summary.dated} URLs have no committed source history and were left undated.${hint}`);
    }
  }
}
