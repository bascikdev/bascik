import { describe, expect, it } from 'vitest';
import { absolutizeUrls, decodeEntities, escapeHtml, isoDate, plural, readableDate, slugify } from './format.ts';

describe('escapeHtml', () => {
  it('escapes the five characters that matter in text and attributes', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('round-trips with decodeEntities', () => {
    const value = `Tom & "Jerry" <b> it's`;
    expect(decodeEntities(escapeHtml(value))).toBe(value);
  });

  it('does not double-decode', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves replacement tokens alone', () => {
    expect(escapeHtml('$1 $& $` $$')).toBe('$1 $&amp; $` $$');
  });
});

describe('slugify', () => {
  it.each([
    ['Field notes', 'field-notes'],
    ['  --Hello,  World!--  ', 'hello-world'],
    ['Crème brûlée', 'creme-brulee'],
    ['C++ & C#', 'c-c'],
    ['日本語 タグ', '日本語-タグ'],
    ['!!!', ''],
  ])('%j becomes %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe('dates', () => {
  it('formats in UTC so a build never depends on the machine zone', () => {
    const date = new Date('2026-01-05T00:00:00Z');
    expect(readableDate(date, 'en')).toBe('January 5, 2026');
    expect(isoDate(date)).toBe('2026-01-05');
    expect(isoDate(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
  });

  it('uses the site language', () => {
    expect(readableDate(new Date('2026-01-05T00:00:00Z'), 'fr')).toBe('5 janvier 2026');
  });
});

describe('plural', () => {
  it('adds an s except for one', () => {
    expect(plural(0, 'post')).toBe('0 posts');
    expect(plural(1, 'post')).toBe('1 post');
    expect(plural(2, 'post')).toBe('2 posts');
  });
});

describe('absolutizeUrls', () => {
  const origin = 'https://example.com';

  it('makes root-relative and fragment URLs absolute and leaves others alone', () => {
    const html = '<a href="/blog/a/">a</a> <a href="#top">t</a> <a href="https://x.test/">x</a> <a href="//cdn.test/">c</a> <a href="mailto:a@b.test">m</a> <a href="rel.html">r</a>';
    expect(absolutizeUrls(html, origin, '/blog/post/')).toBe(
      '<a href="https://example.com/blog/a/">a</a> <a href="https://example.com/blog/post/#top">t</a> <a href="https://x.test/">x</a> <a href="//cdn.test/">c</a> <a href="mailto:a@b.test">m</a> <a href="rel.html">r</a>',
    );
  });

  it('rewrites every srcset candidate and keeps descriptors', () => {
    const html = '<img src="/a.png" srcset="/a-480w.png 480w, /a-960w.png 960w, /a.png 1200w">';
    expect(absolutizeUrls(html, origin, '/p/')).toBe(
      '<img src="https://example.com/a.png" srcset="https://example.com/a-480w.png 480w, https://example.com/a-960w.png 960w, https://example.com/a.png 1200w">',
    );
  });

  it('leaves prose that mentions an attribute alone, because Markdown output escapes its quotes', () => {
    const html = '<p>use href=&quot;/x&quot; in HTML</p>';
    expect(absolutizeUrls(html, origin, '/p/')).toBe(html);
  });
});
