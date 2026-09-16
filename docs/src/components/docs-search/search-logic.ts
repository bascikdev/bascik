/**
 * Pure search logic — no DOM dependencies, importable in Node for testing.
 *
 * The docs-search component inlines these functions at build time (via a
 * <script data-bascik-build> that strips types with Node's stripTypeScriptTypes and
 * removes the export keywords).
 * Any change here is automatically reflected in the browser bundle on the next build.
 */

export interface SearchEntry {
  navLabel: string;
  heading: string | null;
  text: string;
  path: string;
  section?: string;
}

export function tokens(q: string): string[] {
  return q.split(/\s+/).filter(function (w) { return w.length >= 2; });
}

export function basePath(path: string): string {
  return path.split('#')[0];
}

export function score(e: SearchEntry, q: string, toks: string[]): number {
  q = (q || '').toLowerCase();
  toks = (toks || []).map(function (tok) { return tok.toLowerCase(); });
  var sec = (e.section || '').toLowerCase();
  var nl = (e.navLabel || e.title || '').toLowerCase();
  var title = (e.title || '').toLowerCase();
  var h = (e.heading || '').toLowerCase();
  var t = (e.text || '').toLowerCase();

  var secHits = sec ? toks.reduce(function (n, tok) { return n + (sec.includes(tok) ? 1 : 0); }, 0) : 0;
  var nlHits = toks.reduce(function (n, tok) { return n + (nl.includes(tok) || (title && title.includes(tok)) ? 1 : 0); }, 0);
  var hHits = h ? toks.reduce(function (n, tok) { return n + (h.includes(tok) ? 1 : 0); }, 0) : 0;
  var tHits = toks.reduce(function (n, tok) { return n + (t.includes(tok) ? 1 : 0); }, 0);

  // Tier 1 (>=2000): Category (section) match, outranks page title, heading, and text
  if (sec) {
    var secMatch = sec === q || sec.startsWith(q) || sec.includes(q) || (toks.length > 0 && secHits === toks.length);
    if (secMatch) {
      var isPage = e.heading === null;
      var secBase = isPage ? 2000 : 1800;
      var bonus = (nlHits > 0 ? 50 : 0) + (hHits > 0 ? 20 : 0);

      if (sec === q) return secBase + 600 + bonus;
      if (sec.startsWith(q)) return secBase + 400 + secHits + bonus;
      if (sec.includes(q)) return secBase + 200 + secHits + bonus;
      if (toks.length > 0 && secHits === toks.length) return secBase + 100 + secHits + bonus;
    }
  }

  // Tier 2 (1000-1999): Page title (navLabel / title) match, outranks heading and text
  if (nl === q || (title && title === q)) return 1600;
  if (nl.startsWith(q) || (title && title.startsWith(q))) return 1400 + nlHits;
  if (nl.includes(q) || (title && title.includes(q))) return 1200 + nlHits;
  if (toks.length > 0 && nlHits === toks.length) return 1100 + nlHits;
  if (nlHits > 0) return 1000 + nlHits * 10;

  // Tier 3 (100-999): Heading match, outranks text-only matches
  if (h) {
    if (h === q) return 600;
    if (h.startsWith(q)) return 500 + hHits;
    if (h.includes(q)) return 400 + hHits;
    if (toks.length > 0 && hHits === toks.length) return 300 + hHits;
    if (hHits > 0) return 100 + hHits * 10;
  }

  // Tier 4 (1-99): Text/content match only
  if (t.includes(q)) return 80 + tHits;
  if (toks.length > 0 && tHits === toks.length) return 50 + tHits;
  if (tHits > 0) return tHits * 10;

  return 0;
}

/** Returns ~120 chars centered on the first query/token match in text. */
export function snippet(text: string | null | undefined, q: string, toks: string[]): string {
  if (!text) return '';
  var lo = text.toLowerCase();
  var qLo = (q || '').toLowerCase();
  var idx = qLo ? lo.indexOf(qLo) : -1;
  if (idx < 0) {
    for (var i = 0; i < toks.length; i++) {
      idx = lo.indexOf((toks[i] || '').toLowerCase());
      if (idx >= 0) break;
    }
  }
  var start = Math.max(0, idx > 40 ? idx - 40 : 0);
  return (start > 0 ? '\u2026' : '') + text.slice(start, start + 120) + (start + 120 < text.length ? '\u2026' : '');
}

/**
 * Returns an ordered array of up to `limit` result entries.
 * When the query unambiguously identifies one page (its navLabel scores >=1100
 * and < 2000, and no other page ties it), that page's entries are grouped first
 * in document order (page entry, then h2s). Remaining slots fill from score-ordered results.
 */
export function buildResults(index: SearchEntry[], q: string, toks: string[], limit: number): SearchEntry[] {
  var scored = index
    .map(function (e) { return { e: e, s: score(e, q, toks) }; })
    .filter(function (x) { return x.s > 0; })
    .sort(function (a, b) { return b.s - a.s; });

  var pageMatches = scored.filter(function (x) { return x.e.heading === null && x.s >= 1100; });
  var bestPage = pageMatches.length === 1 ? pageMatches[0]
    : (pageMatches.length > 1 && pageMatches[0].s > pageMatches[1].s) ? pageMatches[0]
      : null;

  var seen: Record<string, boolean> = {};
  var top: SearchEntry[] = [];

  if (bestPage) {
    var dominantBase = bestPage.e.path;
    index
      .filter(function (e) { return basePath(e.path) === dominantBase; })
      .forEach(function (e) {
        if (!seen[e.path]) { seen[e.path] = true; top.push(e); }
      });
  }

  for (var i = 0; i < scored.length && top.length < limit; i++) {
    var p = scored[i].e.path;
    if (!seen[p]) { seen[p] = true; top.push(scored[i].e); }
  }

  return top.slice(0, limit);
}
