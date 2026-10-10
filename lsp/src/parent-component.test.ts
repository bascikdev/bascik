import { describe, it, expect } from 'vitest';
import { findNearestParentComponent } from './analyzer.js';

// The regex scanner this function used before it became linear. Kept here as
// the behavioral oracle: the linear scanner must agree with it on every input.
function regexOracle(source: string, componentMap: Map<string, string>): string | undefined {
  const stack: string[] = [];
  const tagRegex = /<\/?([A-Za-z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  for (const match of source.matchAll(tagRegex)) {
    const name = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      const matchingIndex = stack.lastIndexOf(name);
      if (matchingIndex >= 0) stack.splice(matchingIndex);
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(name);
    }
  }
  return stack.reverse().find((name) => componentMap.has(name));
}

const components = new Map([
  ['a', '/a.html'],
  ['b', '/b.html'],
  ['my-card', '/my-card.html'],
]);

describe('findNearestParentComponent', () => {
  it.each([
    ['<my-card><div>', 'my-card'],
    ['<my-card></my-card><div>', undefined],
    ['<a><b></b>', 'a'],
    ['<a><b>', 'b'],
    ['<a><b/>', 'a'],
    ['<A><div title="x > y">', 'a'],
    ["<a><div title='</a>'>", 'a'],
    ['<a><div title="unterminated', 'a'],
    ['<my-card', undefined],
  ])('finds the parent of %j', (source, expected) => {
    expect(findNearestParentComponent(source, components)).toBe(expected);
  });

  it('agrees with the regex scanner on every short string over a tag alphabet', () => {
    const alphabet = ['<', '>', '/', '"', "'", 'a', 'b', '-', ' '];
    let checked = 0;
    const visit = (prefix: string, depth: number): void => {
      expect(findNearestParentComponent(prefix, components), JSON.stringify(prefix)).toBe(
        regexOracle(prefix, components),
      );
      checked++;
      if (depth === 0) return;
      for (const char of alphabet) visit(prefix + char, depth - 1);
    };
    visit('', 5);
    expect(checked).toBeGreaterThan(60_000);
  });

  it('agrees with the regex scanner on longer pseudo-random documents', () => {
    const pieces = ['<a', '<b', '</a>', '</b>', '>', '/>', ' x="', '"', " y='", "'", '<my-card ', 'text', '-', '<'];
    let seed = 0x5eed;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };
    for (let run = 0; run < 2_000; run++) {
      let source = '';
      const length = next() % 40;
      for (let index = 0; index < length; index++) source += pieces[next() % pieces.length];
      expect(findNearestParentComponent(source, components), JSON.stringify(source)).toBe(
        regexOracle(source, components),
      );
    }
  });

  it.each([
    ['an unclosed tag name followed by a long hyphen run', `<a${'-'.repeat(40_000)}`],
    ['many tags with unterminated quotes', '<a b="'.repeat(10_000)],
    ['an unterminated quote between many tag starts', `<a"${'"<a"'.repeat(10_000)}`],
  ])('runs in linear time on %s', (_label, source) => {
    const start = performance.now();
    findNearestParentComponent(source, components);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
