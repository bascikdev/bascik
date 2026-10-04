import { describe, expect, it } from 'vitest';
import { archiveUrl, extraPages, pageCount, paginate, parsePageParam } from './pagination.ts';

describe('pageCount', () => {
  it('has one page for an empty list', () => {
    expect(pageCount(0, 5)).toBe(1);
  });

  it('rounds up and keeps exact multiples', () => {
    expect(pageCount(5, 5)).toBe(1);
    expect(pageCount(6, 5)).toBe(2);
    expect(pageCount(10, 5)).toBe(2);
    expect(pageCount(11, 5)).toBe(3);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects postsPerPage %s', (perPage) => {
    expect(() => pageCount(3, perPage)).toThrow(/postsPerPage/);
  });
});

describe('paginate', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('slices each page and reports the total', () => {
    expect(paginate(items, 3, 1)).toEqual({ items: ['a', 'b', 'c'], page: 1, pages: 3 });
    expect(paginate(items, 3, 3)).toEqual({ items: ['g'], page: 3, pages: 3 });
  });

  it('returns the single empty page of an empty list', () => {
    expect(paginate([], 5, 1)).toEqual({ items: [], page: 1, pages: 1 });
  });

  it.each([0, 4, -1, 1.5])('throws for page %s outside 1..3', (page) => {
    expect(() => paginate(items, 3, page)).toThrow(/does not exist/);
  });
});

describe('archive URLs', () => {
  it('serves page 1 at /blog/ and later pages under /blog/page/', () => {
    expect(archiveUrl(1)).toBe('/blog/');
    expect(archiveUrl(2)).toBe('/blog/page/2/');
    expect(archiveUrl(12)).toBe('/blog/page/12/');
  });

  it('lists only the pages that need a generated route', () => {
    expect(extraPages(0, 5)).toEqual([]);
    expect(extraPages(5, 5)).toEqual([]);
    expect(extraPages(6, 5)).toEqual([2]);
    expect(extraPages(11, 5)).toEqual([2, 3]);
  });
});

describe('parsePageParam', () => {
  it.each(['2', '9', '10', '123'])('accepts %s', (value) => {
    expect(parsePageParam(value)).toBe(Number(value));
  });

  it.each(['0', '1', '01', '02', '-2', '+2', '2.5', '2e1', ' 2', '2 ', '', 'x', '../2'])('rejects %j', (value) => {
    expect(() => parsePageParam(value)).toThrow(/Invalid archive page/);
  });
});
