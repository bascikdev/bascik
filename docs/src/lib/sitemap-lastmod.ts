/**
 * sitemap-lastmod.ts
 *
 * Git-derived `<lastmod>` dates for dist/sitemap.xml.
 *
 * Bascik's own `generate.sitemapLastmod` uses file modification times, which a git checkout resets to the
 * checkout time, so every page would claim it changed on the deploy date. Search engines ignore `<lastmod>`
 * once it proves unreliable, so this reads the date a page's source files were last committed instead.
 *
 * A page's sources are its HTML shell plus every Markdown file the shell renders. The date is the newest
 * commit that touched any of them.
 *
 * Shallow clones are handled by omission, not guessing. A shallow clone treats its oldest visible commit
 * (the "boundary") as if it created every file, so a date taken from it is only an upper bound. Boundary
 * commits are ignored, and a page with no date from a real commit gets no `<lastmod>` at all. Because the
 * boundary is older than every other visible commit, the newest remaining date is still exact whenever one
 * exists.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Repo-relative path (posix separators) to the unix commit time of its newest real commit. */
export type LatestCommitTimes = Map<string, number>;

export interface GitHistory {
  latest: LatestCommitTimes;
  /** True when the clone is shallow, so older dates may be unknown rather than wrong. */
  shallow: boolean;
}

/**
 * Parses `git log --name-only --format="commit %H %ct"` output into the newest commit time per path,
 * skipping boundary commits whose dates cannot be trusted.
 */
export function parseGitLog(output: string, boundaryCommits: ReadonlySet<string> = new Set()): LatestCommitTimes {
  const latest: LatestCommitTimes = new Map();
  let current: { hash: string; time: number } | null = null;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const header = /^commit ([0-9a-f]{40,64}) (\d+)$/.exec(line);
    if (header) {
      current = { hash: header[1], time: Number(header[2]) };
      continue;
    }
    if (!current || boundaryCommits.has(current.hash)) continue;
    const previous = latest.get(line);
    if (previous === undefined || current.time > previous) latest.set(line, current.time);
  }
  return latest;
}

/** True when `cwd` is a shallow clone. Returns false outside a git repository. */
export async function isShallowRepository(cwd: string): Promise<boolean> {
  try {
    return (await run('git', ['rev-parse', '--is-shallow-repository'], { cwd })).stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Fetches the rest of a shallow clone's history so every page can be dated. Returns whether the clone is
 * complete afterwards. Never throws: a failed or timed-out fetch just leaves the clone shallow, and pages
 * without a provable date stay undated.
 */
export async function unshallow(cwd: string, timeoutMs = 120_000): Promise<boolean> {
  try {
    await run('git', ['fetch', '--unshallow', '--quiet'], { cwd, timeout: timeoutMs });
  } catch {
    // Offline, no remote, or no permission: fall through and report the clone state as it is.
  }
  return !(await isShallowRepository(cwd));
}

/** Reads commit history for `paths`, or `null` when `cwd` is not inside a git repository. */
export async function readGitHistory(cwd: string, paths: readonly string[]): Promise<GitHistory | null> {
  const git = (args: string[]) => run('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });

  let shallow: boolean;
  try {
    shallow = (await git(['rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true';
  } catch {
    return null;
  }

  const boundary = new Set<string>();
  if (shallow) {
    const { stdout } = await git(['rev-parse', '--path-format=absolute', '--git-path', 'shallow']);
    try {
      for (const hash of (await readFile(stdout.trim(), 'utf8')).split('\n')) {
        if (hash.trim()) boundary.add(hash.trim());
      }
    } catch {
      // No readable shallow file: nothing to exclude.
    }
  }

  if (paths.length === 0) return { latest: new Map(), shallow };
  const { stdout } = await git(['log', '--name-only', '--format=commit %H %ct', '--', ...paths]);
  return { latest: parseGitLog(stdout, boundary), shallow };
}

/** Markdown files a page shell renders, as written in its source (`./content/x.md`, `../CHANGELOG.md`). */
export function extractMarkdownRefs(pageHtml: string): string[] {
  const refs = new Set<string>();
  for (const match of pageHtml.matchAll(/['"`](\.{1,2}\/[^'"`\s]+\.md)['"`]/g)) refs.add(match[1]);
  return [...refs];
}

/** `https://bascik.dev/how-to/markdown` -> `how-to/markdown`; the home page and directory indexes map to `''`/`dir`. */
export function routeOf(loc: string): string {
  let pathname: string;
  try {
    pathname = new URL(loc.replace(/&amp;/g, '&')).pathname;
  } catch {
    return '';
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the raw pathname.
  }
  return pathname.replace(/^\/+|\/+$/g, '');
}

/**
 * Source files (repo-relative, posix) behind a sitemap URL, or `[]` when no page shell exists for it.
 * `docsDir` is where relative Markdown references resolve, matching the build scripts' working directory.
 */
export async function sourceFilesForRoute(route: string, docsDir: string, repoRoot: string): Promise<string[]> {
  const pagesDir = join(docsDir, 'src', 'pages');
  const candidates = route === '' ? ['index.html'] : [`${route}.html`, `${route}/index.html`];
  const pageFile = candidates.map((c) => join(pagesDir, c)).find((c) => existsSync(c));
  if (!pageFile) return [];

  const toRepoPath = (absolute: string) => relative(repoRoot, absolute).split('\\').join('/');
  const sources = [toRepoPath(pageFile)];
  for (const ref of extractMarkdownRefs(await readFile(pageFile, 'utf8'))) {
    const absolute = isAbsolute(ref) ? ref : resolve(docsDir, ref);
    if (existsSync(absolute)) sources.push(toRepoPath(absolute));
  }
  return sources;
}

/** `2026-02-01` (UTC) for a unix time in seconds, the W3C date form sitemaps accept. */
export function formatLastmod(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Newest known commit date across `sources`, or `undefined` when none of them has a trustworthy date. */
export function lastmodFor(sources: readonly string[], latest: LatestCommitTimes): string | undefined {
  let newest: number | undefined;
  for (const source of sources) {
    const time = latest.get(source);
    if (time !== undefined && (newest === undefined || time > newest)) newest = time;
  }
  return newest === undefined ? undefined : formatLastmod(newest);
}

/**
 * Adds `<lastmod>` to each `<url>` whose `<loc>` has a date. Entries that already carry one, and entries
 * without a date, are left exactly as they were, so running it twice changes nothing.
 */
export function injectLastmod(sitemapXml: string, datesByLoc: ReadonlyMap<string, string>): string {
  return sitemapXml.replace(/<url>[\s\S]*?<\/url>/g, (block) => {
    if (block.includes('<lastmod>')) return block;
    const loc = /<loc>([^<]*)<\/loc>/.exec(block)?.[1];
    const date = loc === undefined ? undefined : datesByLoc.get(loc);
    if (!date) return block;
    return block.replace('</loc>', () => `</loc>\n    <lastmod>${date}</lastmod>`);
  });
}

/** `<loc>` values of every `<url>` entry, in document order. */
export function sitemapLocs(sitemapXml: string): string[] {
  return [...sitemapXml.matchAll(/<url>[\s\S]*?<loc>([^<]*)<\/loc>[\s\S]*?<\/url>/g)].map((m) => m[1]);
}

export interface LastmodSummary {
  xml: string;
  dated: number;
  total: number;
  shallow: boolean;
}

/** Computes the dated sitemap for `sitemapXml` from the git history under `repoRoot`. */
export async function addGitLastmod(
  sitemapXml: string,
  docsDir: string,
  repoRoot: string,
): Promise<LastmodSummary | null> {
  const locs = sitemapLocs(sitemapXml);
  const sourcesByLoc = new Map<string, string[]>();
  for (const loc of locs) sourcesByLoc.set(loc, await sourceFilesForRoute(routeOf(loc), docsDir, repoRoot));

  const history = await readGitHistory(repoRoot, [...new Set([...sourcesByLoc.values()].flat())]);
  if (!history) return null;

  const dates = new Map<string, string>();
  for (const [loc, sources] of sourcesByLoc) {
    const date = lastmodFor(sources, history.latest);
    if (date) dates.set(loc, date);
  }
  return { xml: injectLastmod(sitemapXml, dates), dated: dates.size, total: locs.length, shallow: history.shallow };
}

/** Repo root containing `cwd`, or `null` outside a git repository. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
