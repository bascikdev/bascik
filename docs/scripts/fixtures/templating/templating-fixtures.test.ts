import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractDemoBlock } from '../../../src/lib/md-renderer.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '.');
const TEMPLATING_MD = path.resolve(import.meta.dirname, '../../../content/how-to/templating.md');

/**
 * Every code block on the templating page is extracted from these fixtures
 * via extractDemoBlock. This test runs each fixture so a break in the
 * documented behavior fails the suite, and asserts every marker the page
 * references actually resolves (a typo'd marker renders an empty block).
 */

describe('templating fixtures', () => {
  it('interpolate helper escapes HTML and resolves dotted paths', async () => {
    const { interpolate, escapeHtml } = await import(
      `file://${path.join(FIXTURE_DIR, 'interpolate.mjs')}`
    );

    // Dotted path resolution
    expect(interpolate('<p>${article.title}</p>', { article: { title: 'Hello' } }))
      .toBe('<p>Hello</p>');

    // HTML escaping by default
    expect(interpolate('<p>${article.title}</p>', { article: { title: '<script>&"' } }))
      .toBe('<p>&lt;script&gt;&amp;&quot;</p>');

    // Missing key renders as empty string (deliberate behavior)
    expect(interpolate('<p>${article.missing}</p>', { article: {} }))
      .toBe('<p></p>');

    // escapeHtml is exported for reuse
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });

  it('handlebars fixture renders the article list', async () => {
    const { default: Handlebars } = await import('handlebars');
    const src = await readFile(path.join(FIXTURE_DIR, 'article-list.hbs'), 'utf8');
    const template = Handlebars.compile(src);
    const html = template({
      page: 2,
      items: [
        { title: 'First article', href: '/posts/first' },
        { title: 'Second article', href: '/posts/second' },
      ],
    });
    expect(html).toContain('Articles (Page 2)');
    expect(html).toContain('<li><a href="/posts/first">First article</a></li>');
    expect(html).toContain('<li><a href="/posts/second">Second article</a></li>');
  });

  it('handlebars escapes values by default', async () => {
    const { default: Handlebars } = await import('handlebars');
    const template = Handlebars.compile('<p>{{value}}</p>');
    expect(template({ value: '<script>' })).toBe('<p>&lt;script&gt;</p>');
  });

  it('ejs fixture renders the post list with escaped values', async () => {
    const { default: ejs } = await import('ejs');
    const template = await readFile(path.join(FIXTURE_DIR, 'post-list.ejs'), 'utf8');
    const html = ejs.render(template, {
      rows: [
        { title: 'First post', href: '/posts/first' },
        { title: 'Second post', href: '/posts/second' },
      ],
    });
    expect(html.replace(/\s+/g, ' ')).toContain('<li><a href="/posts/first"> First post </a></li>');
    expect(html.replace(/\s+/g, ' ')).toContain('<li><a href="/posts/second"> Second post </a></li>');
  });

  it('ejs escapes values by default', async () => {
    const { default: ejs } = await import('ejs');
    expect(ejs.render('<p><%= value %></p>', { value: '<script>' })).toBe('<p>&lt;script&gt;</p>');
  });

  it('nunjucks fixture renders the item list', async () => {
    const nunjucks = await import('nunjucks');
    const html = nunjucks.render(path.join(FIXTURE_DIR, 'page.njk'), {
      title: 'Projects',
      items: ['Alpha', 'Bravo', 'Charlie'],
    });
    expect(html).toContain('<h2>Projects</h2>');
    expect(html).toContain('<li>Alpha</li>');
    expect(html).toContain('<li>Charlie</li>');
  });

  it('fetch-once fixture reads data once and applies it everywhere', async () => {
    const data = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'data.json'), 'utf8'));
    // The fetch-once pattern: one read at page level, reused for both blocks
    expect(data.site).toBe('Bascik Demo');
    expect(data.articles).toHaveLength(2);
    const list = data.articles.map(a => `<li><a href="${a.href}">${a.title}</a></li>`).join('');
    const json = JSON.stringify({ site: data.site, articles: data.articles });
    expect(list).toContain('/posts/first');
    expect(json).toContain('Bascik Demo');
  });
});

describe('templating page demo markers', () => {
  const MARKERS = [
    'handlebars-install',
    'handlebars-script',
    'handlebars-template',
    'helper-module',
    'helper-usage',
    'ejs-install',
    'ejs-script',
    'ejs-template',
    'njk-install',
    'njk-script',
    'njk-template',
    'fetch-once-script',
    'json-payload-script',
    'json-payload-client',
  ];

  it('every marker referenced by the page resolves to a code block', async () => {
    const md = await readFile(TEMPLATING_MD, 'utf8');
    for (const marker of MARKERS) {
      const block = await extractDemoBlock('./content/how-to/templating.md', marker);
      expect(block, `marker "${marker}" missing or empty in templating.md`).not.toContain('not found');
      expect(block, `marker "${marker}" has no code block after it`).not.toContain('no code block');
      expect(block, `marker "${marker}" could not read the MD file`).not.toContain('File not found');
      expect(block.trim(), `marker "${marker}" resolved to an empty block`).not.toBe('');
    }
  });

  it('the MD file contains no markers the test does not know about', async () => {
    const md = await readFile(TEMPLATING_MD, 'utf8');
    const found = [...md.matchAll(/<!--\s*demo:([\w-]+)\s*-->/g)].map(m => m[1]);
    const unknown = found.filter(m => !MARKERS.includes(m));
    expect(unknown, `undocumented markers: ${unknown.join(', ')}`).toEqual([]);
  });
});
