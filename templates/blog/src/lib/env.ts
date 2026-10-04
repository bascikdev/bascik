import { join } from 'node:path';

// Everything the pipeline reads from the process: Bascik's environment variables and the
// working directory. Build scripts and exec scripts run with the project root as cwd.

/** Directory holding the Markdown sources. */
export const contentRoot = (): string => join(process.cwd(), 'content');

/**
 * Drafts are written in development and left out of production builds. Bascik sets
 * BASCIK_BUILD to "1" for `bascik --build` and "0" for the dev server.
 */
export const includeDrafts = (): boolean => process.env.BASCIK_BUILD !== '1';

/**
 * Where the site is deployed, as an origin without a trailing slash (`https://example.com`), or
 * null when none was supplied (normal in development). Throws on a value that is not an http(s)
 * origin, so a typo never reaches canonical links or the feed.
 *
 * The template assumes the site is served from the root of its domain. A URL with a path
 * (`https://user.github.io/repo`) is rejected instead of producing links that point nowhere.
 */
export function siteOrigin(): string | null {
  const raw = process.env.BASCIK_SITE_URL;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`BASCIK_SITE_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`BASCIK_SITE_URL must start with https:// or http://, got ${JSON.stringify(raw)}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `BASCIK_SITE_URL must be an origin such as https://example.com with no path, got ${JSON.stringify(raw)}. ` +
      'This template serves the site from the root of its domain.',
    );
  }
  return url.origin;
}

/** Like `siteOrigin`, for output that cannot be written with relative URLs (the feed). */
export function requireSiteOrigin(): string {
  const origin = siteOrigin();
  if (!origin) {
    throw new Error('BASCIK_SITE_URL is required for the feed. Copy .env.example to .env or pass --site-url (see README.md).');
  }
  return origin;
}

/** Normalized route of the page being built, with a trailing slash. */
export function pagePath(): string {
  const path = process.env.BASCIK_PAGE_PATH ?? '/';
  return path.endsWith('/') ? path : `${path}/`;
}
