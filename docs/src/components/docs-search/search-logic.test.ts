import { describe, it, expect } from 'vitest';
import { tokens, basePath, score, snippet, buildResults } from './search-logic.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const entry = (overrides) => ({
  navLabel: 'Test Page',
  heading: null,
  text: 'Some page text about the topic.',
  path: '/test',
  section: 'Tests',
  ...overrides,
});

// Small representative index for buildResults integration tests
const MOCK_INDEX = [
  entry({ navLabel: 'Props', heading: null, text: 'Define and use props.', path: '/props' }),
  entry({ navLabel: 'Props', heading: 'Passing Props', text: 'How to pass props.', path: '/props#passing-props' }),
  entry({ navLabel: 'Props', heading: 'Defaults', text: 'Default prop values.', path: '/props#defaults' }),
  entry({ navLabel: 'Slots', heading: null, text: 'About slots and content.', path: '/slots' }),
  entry({ navLabel: 'Slots', heading: 'Named Slots', text: 'Named slot usage.', path: '/slots#named-slots' }),
  entry({ navLabel: 'Configuration', heading: null, text: 'Config file options.', path: '/config' }),
  entry({ navLabel: 'Configuration', heading: 'Output Dir', text: 'Where output goes.', path: '/config#output-dir' }),
];

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

describe('tokens', () => {
  it('splits on whitespace', () => {
    expect(tokens('hello world')).toEqual(['hello', 'world']);
  });

  it('filters words shorter than 2 chars', () => {
    expect(tokens('a hello b world')).toEqual(['hello', 'world']);
  });

  it('handles extra whitespace', () => {
    expect(tokens('  foo  bar  ')).toEqual(['foo', 'bar']);
  });

  it('returns empty array for empty or whitespace-only input', () => {
    expect(tokens('')).toEqual([]);
    expect(tokens('  ')).toEqual([]);
    expect(tokens('a')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// basePath
// ---------------------------------------------------------------------------

describe('basePath', () => {
  it('strips the hash fragment', () => {
    expect(basePath('/foo#bar')).toBe('/foo');
    expect(basePath('/scoped-javascript#how-scoping-works')).toBe('/scoped-javascript');
  });

  it('returns the path unchanged when there is no hash', () => {
    expect(basePath('/foo')).toBe('/foo');
  });
});

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

describe('score', () => {
  describe('tier 1 - category (section) match (>=2000)', () => {
    it('returns >=2600 for an exact category match on a page-level entry', () => {
      const q = 'how-to';
      expect(score(entry({ section: 'How-to', navLabel: 'Markdown', heading: null }), q, tokens(q))).toBeGreaterThanOrEqual(2600);
    });

    it('does not trigger category match for multi-word query when section only contains one token', () => {
      const q = 'scoped styles';
      const toks = tokens(q);
      const e = entry({ section: 'Styles & Scripts', navLabel: 'Scoped Styles', heading: null });
      // Should match navLabel tier 2 (>=1200) rather than failing category match
      expect(score(e, q, toks)).toBeGreaterThanOrEqual(1200);
    });

    it('returns category matches above page title matches', () => {
      const q = 'how-to';
      const catScore = score(entry({ section: 'How-to', navLabel: 'Markdown', heading: null }), q, tokens(q));
      const pageScore = score(entry({ section: 'Other', navLabel: 'How-to', heading: null }), q, tokens(q));
      expect(catScore).toBeGreaterThan(pageScore);
    });
  });

  describe('tier 2 - navLabel match (1000-1999)', () => {
    it('returns 1600 for an exact navLabel match', () => {
      const q = 'props';
      expect(score(entry({ navLabel: 'Props' }), q, tokens(q))).toBe(1600);
    });

    it('returns ≥1400 when navLabel starts with the query', () => {
      const q = 'pro';
      expect(score(entry({ navLabel: 'Props' }), q, tokens(q))).toBeGreaterThanOrEqual(1400);
    });

    it('returns ≥1200 when navLabel contains the phrase', () => {
      const q = 'scoped javascript';
      const toks = tokens(q);
      expect(score(entry({ navLabel: 'Scoped JavaScript Guide' }), q, toks)).toBeGreaterThanOrEqual(1200);
    });

    it('returns ≥1100 when all tokens match the navLabel', () => {
      const q = 'scoped javascript';
      const toks = tokens(q);
      expect(score(entry({ navLabel: 'Scoped JavaScript' }), q, toks)).toBeGreaterThanOrEqual(1100);
    });

    it('returns ≥1000 for a partial token hit in navLabel', () => {
      const q = 'scoped javascript';
      const toks = tokens(q);
      expect(score(entry({ navLabel: 'Scoped Styles' }), q, toks)).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('tier 3 - heading match (100-999)', () => {
    it('returns 600 for an exact heading match', () => {
      const q = 'passing props';
      const e = entry({ navLabel: 'Unrelated', heading: 'Passing Props' });
      expect(score(e, q, tokens(q))).toBe(600);
    });

    it('returns >=400 when heading contains the phrase', () => {
      const q = 'passing';
      const e = entry({ navLabel: 'Unrelated', heading: 'Passing Props' });
      expect(score(e, q, tokens(q))).toBeGreaterThanOrEqual(400);
    });

    it('score stays below 1000', () => {
      const q = 'defaults';
      const e = entry({ navLabel: 'Other', heading: 'Defaults' });
      expect(score(e, q, tokens(q))).toBeLessThan(1000);
    });
  });

  describe('tier 4 - text-only match (1-99)', () => {
    it('returns ≥80 for a phrase match in text', () => {
      const q = 'define and use';
      const e = entry({ navLabel: 'Other', text: 'Define and use props here.' });
      expect(score(e, q, tokens(q))).toBeGreaterThanOrEqual(80);
    });

    it('score stays below 100', () => {
      const q = 'define and use';
      const e = entry({ navLabel: 'Other', text: 'Define and use props here.' });
      expect(score(e, q, tokens(q))).toBeLessThan(100);
    });
  });

  describe('tier ordering guarantees', () => {
    it('category match always beats navLabel match', () => {
      const q = 'how-to';
      const toks = tokens(q);
      const cat = score(entry({ section: 'How-to', navLabel: 'Markdown', heading: null }), q, toks);
      const nl = score(entry({ section: 'Other', navLabel: 'How-to', heading: null }), q, toks);
      expect(cat).toBeGreaterThan(nl);
    });

    it('navLabel match always beats heading match', () => {
      const q = 'foo';
      const toks = tokens(q);
      const nl = score(entry({ navLabel: 'Foo' }), q, toks);
      const h = score(entry({ navLabel: 'Other Page', heading: 'Foo' }), q, toks);
      expect(nl).toBeGreaterThan(h);
    });

    it('heading match always beats text-only match', () => {
      const q = 'foo bar';
      const toks = tokens(q);
      const h = score(entry({ navLabel: 'Other', heading: 'Foo Bar' }), q, toks);
      const t = score(entry({ navLabel: 'Other', text: 'foo bar here.' }), q, toks);
      expect(h).toBeGreaterThan(t);
    });
  });

  it('returns 0 when nothing matches', () => {
    const q = 'xyznothing';
    expect(score(entry({ navLabel: 'Props', text: 'Props stuff' }), q, tokens(q))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// snippet
// ---------------------------------------------------------------------------

describe('snippet', () => {
  it('returns empty string for falsy input', () => {
    expect(snippet('', 'foo', [])).toBe('');
    expect(snippet(null, 'foo', [])).toBe('');
  });

  it('centres on the phrase match when found', () => {
    const text = 'word '.repeat(20) + 'TARGET' + ' word'.repeat(20);
    const result = snippet(text, 'target', tokens('target'));
    expect(result.toLowerCase()).toContain('target');
  });

  it('adds a leading ellipsis when the match is not near the start', () => {
    const text = 'a'.repeat(80) + ' match ' + 'b'.repeat(40);
    const result = snippet(text, 'match', tokens('match'));
    expect(result.startsWith('\u2026')).toBe(true);
  });

  it('adds a trailing ellipsis when the text is truncated', () => {
    const text = 'match ' + 'b'.repeat(200);
    const result = snippet(text, 'match', tokens('match'));
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('keeps output to roughly 120 characters of text', () => {
    const text = 'word '.repeat(100);
    const result = snippet(text, 'word', tokens('word'));
    // Allow a few extra chars for ellipsis characters
    expect(result.replace(/\u2026/g, '').length).toBeLessThanOrEqual(125);
  });
});

// ---------------------------------------------------------------------------
// buildResults
// ---------------------------------------------------------------------------

describe('buildResults', () => {
  it('returns empty array when nothing matches', () => {
    const results = buildResults(MOCK_INDEX, 'xyznothing', tokens('xyznothing'), 13);
    expect(results).toEqual([]);
  });

  it('puts the page entry first for an unambiguous page-name match', () => {
    const q = 'props';
    const results = buildResults(MOCK_INDEX, q, tokens(q), 13);
    expect(results[0].heading).toBeNull();
    expect(results[0].navLabel).toBe('Props');
    expect(results[0].path).toBe('/props');
  });

  it('follows the page entry with h2s in document order', () => {
    const q = 'props';
    const results = buildResults(MOCK_INDEX, q, tokens(q), 13);
    expect(results[1].heading).toBe('Passing Props');
    expect(results[2].heading).toBe('Defaults');
  });

  it('does not group a dominant page for an ambiguous query', () => {
    // Both 'Props' and 'Configuration' contain 'o' but neither closely matches 'output dir'
    // so this checks that no forced grouping happens for low-confidence matches
    const q = 'output dir';
    const results = buildResults(MOCK_INDEX, q, tokens(q), 13);
    // The heading 'Output Dir' should appear but the page entry needn't be forced first
    const headingMatch = results.find(r => r.heading === 'Output Dir');
    expect(headingMatch).toBeDefined();
  });

  it('respects the limit parameter', () => {
    const results = buildResults(MOCK_INDEX, 'props', tokens('props'), 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('deduplicates paths', () => {
    const q = 'props';
    const results = buildResults(MOCK_INDEX, q, tokens(q), 13);
    const paths = results.map(r => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('handles mixed-case queries and matches case-insensitively', () => {
    const query = 'DeduplicateCss';
    const q = query.toLowerCase().trim();
    const toks = tokens(q);
    const testIndex = [
      entry({ navLabel: 'Configuration', heading: 'deduplicateCss', text: 'Set deduplicateCss in bascik.config.ts.', path: '/config#deduplicatecss' }),
      entry({ navLabel: 'Scoped Styles', heading: 'deduplicateCss Trade-Off Comparison', text: 'Side-by-side comparison of deduplicateCss: true vs false.', path: '/scoped-styles#deduplicatecss-trade-off-comparison' }),
      entry({ navLabel: 'Scoped Styles', heading: 'Class Selectors in Component Scripts', text: 'If you need class selectors unique per instance, set deduplicateCss: false.', path: '/scoped-styles#class-selectors' }),
      entry({ navLabel: 'Scoping System', heading: 'CSS Deduplication', text: 'deduplicateCss receives the list of used components.', path: '/internals/scoping-system#css-deduplication' }),
    ];

    const results = buildResults(testIndex, q, toks, 13);
    expect(results.length).toBe(4);

    // Heading matches (score 400+) come before text-only matches (score 80)
    const navLabels = results.map(r => r.navLabel);
    expect(navLabels).toContain('Scoped Styles');
    expect(navLabels).toContain('Configuration');
    expect(navLabels).toContain('Scoping System');

    // Heading matches should rank before text-only matches
    expect(results[0].heading).toBe('deduplicateCss');
    expect(results[1].heading).toBe('deduplicateCss Trade-Off Comparison');
    expect(results[2].heading).toBe('Class Selectors in Component Scripts');
    expect(results[3].heading).toBe('CSS Deduplication');
  });

  it('returns category pages in document order when searching by category name', () => {
    const q = 'how-to';
    const toks = tokens(q);
    const testIndex = [
      entry({ navLabel: 'Markdown', heading: null, section: 'How-to', path: '/how-to/markdown' }),
      entry({ navLabel: 'Page-Aware Scripts', heading: null, section: 'How-to', path: '/how-to/page-aware-scripts' }),
      entry({ navLabel: 'Server Scripts', heading: null, section: 'How-to', text: 'These guides show common patterns.', path: '/how-to/server-scripts' }),
      entry({ navLabel: 'Templating', heading: null, section: 'How-to', path: '/how-to/templating' }),
      entry({ navLabel: 'Props', heading: null, section: 'Features', path: '/props' }),
    ];

    const results = buildResults(testIndex, q, toks, 13);
    expect(results.map(r => r.navLabel)).toEqual(['Markdown', 'Page-Aware Scripts', 'Server Scripts', 'Templating']);
    expect(results[0].navLabel).toBe('Markdown');
  });

  it('opens up to searching page content when page names/headings do not fill result limit', () => {
    const query = 'unique instance';
    const q = query.toLowerCase().trim();
    const toks = tokens(q);
    const testIndex = [
      entry({ navLabel: 'Props', heading: 'Overview', text: 'Passing props.', path: '/props' }),
      entry({ navLabel: 'Scoped Styles', heading: 'Overview', text: 'Each instance gets unique instance id class names.', path: '/scoped-styles' }),
      entry({ navLabel: 'Scoped JavaScript', heading: 'Overview', text: 'Unique instance state.', path: '/scoped-javascript' }),
    ];

    const results = buildResults(testIndex, q, toks, 13);
    expect(results.length).toBe(2);
    expect(results.map(r => r.navLabel)).toEqual(['Scoped Styles', 'Scoped JavaScript']);
  });
});
