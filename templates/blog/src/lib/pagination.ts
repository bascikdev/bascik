// Archive pagination. Page 1 is /blog/; page N (N >= 2) is /blog/page/N/.

export interface Page<T> {
  items: T[];
  /** 1-based number of this page. */
  page: number;
  /** Total pages. An empty list still has one (empty) page. */
  pages: number;
}

export function pageCount(total: number, perPage: number): number {
  assertPerPage(perPage);
  return Math.max(1, Math.ceil(total / perPage));
}

function assertPerPage(perPage: number): void {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError(`postsPerPage must be a whole number of at least 1, got ${perPage}`);
  }
}

/** One page of `items`. Throws for a page outside 1..pages instead of returning an empty page. */
export function paginate<T>(items: readonly T[], perPage: number, page: number): Page<T> {
  const pages = pageCount(items.length, perPage);
  if (!Number.isInteger(page) || page < 1 || page > pages) {
    throw new RangeError(`Archive page ${page} does not exist; there ${pages === 1 ? 'is 1 page' : `are ${pages} pages`}`);
  }
  return { items: items.slice((page - 1) * perPage, page * perPage), page, pages };
}

/** Public URL of an archive page. */
export const archiveUrl = (page: number): string => (page <= 1 ? '/blog/' : `/blog/page/${page}/`);

/** The pages that need a generated route: every page after the first (page 1 is blog/index.html). */
export function extraPages(total: number, perPage: number): number[] {
  const pages = pageCount(total, perPage);
  return Array.from({ length: Math.max(0, pages - 1) }, (_unused, index) => index + 2);
}

/** Parse a `[page]` route parameter. Rejects 0, 1 (served by /blog/), signs, decimals, and padding. */
export function parsePageParam(value: string): number {
  if (!/^[2-9]\d*$|^1\d+$/.test(value)) {
    throw new RangeError(`Invalid archive page ${JSON.stringify(value)}; page numbers start at 2 here (page 1 is /blog/)`);
  }
  return Number(value);
}
