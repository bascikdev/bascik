// Small pure helpers shared by the pipeline. No file system or environment access here.

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Decode the entities that `escapeHtml` and marked produce. */
export function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Lowercase, accent-stripped, hyphen-separated. Used for tag URLs and heading ids.
 * Accents are removed only from Latin letters (`é` becomes `e`). Marks in other scripts are part
 * of the letter: stripping the dakuten from `グ` would turn it into a different character, `ク`.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/(?<=\p{Script=Latin})\p{M}+/gu, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** `January 5, 2026` in the site's language. Always UTC so a build never depends on the machine's zone. */
export function readableDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

/** `2026-01-05`, for `<time datetime>`. */
export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Make absolute URLs out of root-relative ones in the `href`, `src`, and `srcset` values of HTML. */
export function absolutizeUrls(html: string, origin: string, pageUrl: string): string {
  const isExternal = (value: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
  const one = (value: string): string => {
    if (isExternal(value)) return value;
    if (value.startsWith('#')) return `${origin}${pageUrl}${value}`;
    if (value.startsWith('/')) return `${origin}${value}`;
    return value;
  };
  return html.replace(/(\s)(href|src|srcset)=(["'])([^"']*)\3/gi, (_whole, space: string, name: string, quote: string, value: string) => {
    if (name.toLowerCase() === 'srcset') {
      const candidates = value.split(',').map((candidate) => {
        const [url = '', ...descriptor] = candidate.trim().split(/\s+/);
        return [one(url), ...descriptor].join(' ');
      });
      return `${space}${name}=${quote}${candidates.join(', ')}${quote}`;
    }
    return `${space}${name}=${quote}${one(value)}${quote}`;
  });
}
