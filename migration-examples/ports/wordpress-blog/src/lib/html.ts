import sanitizeHtml from 'sanitize-html';
import { decodeHTML } from 'entities';

// HTML that comes from WordPress (or from Markdown converted out of WordPress) is data, not
// source code. WordPress lets administrators save any markup, including <script>, inline event
// handlers, and `javascript:` links, so every body is passed through an allowlist before a build
// script prints it. Bascik itself drops printed directive scripts (1.0.0-rc.3 or later); this
// allowlist also removes ordinary scripts, handlers, embeds, and unknown or custom elements, so
// CMS content can never place a Bascik component tag or run code in the visitor's browser.

/** WordPress titles are HTML (`Fish &#038; Chips`). Reduce one to plain text, dropping any tags. */
export function htmlToText(html: string): string {
  return decodeHTML(sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })).trim();
}

/** Rewrites a URL found in content; return the URL to keep, or undefined to leave it unchanged. */
export type UrlMapper = (url: string, kind: 'image' | 'link') => string | undefined;

function mapSrcset(srcset: string, map: UrlMapper): string {
  return srcset
    .split(',')
    .map((candidate) => {
      const [url, ...descriptor] = candidate.trim().split(/\s+/);
      return [map(url, 'image') ?? url, ...descriptor].join(' ');
    })
    .join(', ');
}

const HEADINGS = ['h2', 'h3', 'h4', 'h5', 'h6'];

/** Allowlist the markup WordPress core blocks produce for posts and pages. */
export function sanitizeContent(html: string, map: UrlMapper): string {
  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== 'h1'),
      'img', 'figure', 'figcaption', 'del', 'ins', 'mark', 'sub', 'sup', 'details', 'summary',
    ],
    allowedAttributes: {
      '*': ['class'],
      a: ['href', 'title', 'rel'],
      img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
      ol: ['start', 'reversed'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
      ...Object.fromEntries(HEADINGS.map((tag) => [tag, ['id', 'class']])),
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    transformTags: {
      img: (tagName, attribs) => {
        const next = { ...attribs };
        if (next.src) next.src = map(next.src, 'image') ?? next.src;
        if (next.srcset) next.srcset = mapSrcset(next.srcset, map);
        if (!next.loading) next.loading = 'lazy';
        if (!next.decoding) next.decoding = 'async';
        return { tagName, attribs: next };
      },
      a: (tagName, attribs) => {
        const next = { ...attribs };
        if (next.href) next.href = map(next.href, 'link') ?? next.href;
        return { tagName, attribs: next };
      },
    },
  });
}

/** Make root-relative `src` and `href` values absolute, for feed readers. */
export function absoluteUrls(html: string, origin: string): string {
  return html.replace(/\b(src|href)="\/(?!\/)/g, (_match, name: string) => `${name}="${origin}/`);
}
