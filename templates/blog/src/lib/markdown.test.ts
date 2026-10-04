import { describe, expect, it } from 'vitest';
import { HeadingIds, renderMarkdown, type RenderOptions } from './markdown.ts';
import { png, useProject } from './test-helpers.ts';

const options = (overrides: Partial<RenderOptions> = {}): RenderOptions => ({
  file: 'blog/a.md',
  published: new Set(['/blog/b/', '/about/']),
  urlForFile: (path) => ({ 'blog/b.md': '/blog/b/', 'about.md': '/about/', 'blog/draft.md': '/blog/draft/' })[path] ?? null,
  ...overrides,
});

describe('HeadingIds', () => {
  it('makes repeated headings unique and honors reserved ids', () => {
    const ids = new HeadingIds(['title']);
    expect([ids.next('Title'), ids.next('Title'), ids.next('Intro'), ids.next('Intro')]).toEqual(['title-2', 'title-3', 'intro', 'intro-2']);
  });

  it('never returns an empty id', () => {
    expect(new HeadingIds().next('!!!')).toBe('section');
  });
});

describe('headings', () => {
  const project = useProject();

  it('gives every heading an id and h2-h6 an anchor, but not h1', () => {
    const html = renderMarkdown('# One\n\n## Two\n\n###### Six\n', options());
    expect(html).toContain('<h1 id="one">One</h1>');
    expect(html).toContain('<h2 id="two">Two<span class="ha-placeholder"');
    expect(html).toContain('<a class="ha" href="#two"');
    expect(html).toContain('<h6 id="six">Six');
    expect(html.match(/class="ha"/g)).toHaveLength(2);
  });

  it('leaves out anchors for the feed', () => {
    const html = renderMarkdown('## Two\n', options({ anchors: false }));
    expect(html).toBe('<h2 id="two">Two</h2>\n');
  });

  it('builds the id from the text, not the markup, and escapes it in the accessible label', () => {
    const html = renderMarkdown('## A *fancy* <b>"heading"</b>\n', options());
    expect(html).toContain('id="a-fancy-heading"');
    expect(html).toContain('Jump to section titled: A fancy &quot;heading&quot;');
  });

  it('numbers duplicates and avoids the reserved title id', () => {
    const html = renderMarkdown('## Same\n\n## Same\n\n## Post\n', options({ reservedIds: ['post'] }));
    expect(html).toContain('id="same"');
    expect(html).toContain('id="same-2"');
    expect(html).toContain('id="post-2"');
  });

  it('gives each anchor its own anchor-name', () => {
    const html = renderMarkdown('## A\n\n## B\n', options());
    expect(html).toContain('anchor-name: --ha-0');
    expect(html).toContain('anchor-name: --ha-1');
    expect(html).toContain('position-anchor: --ha-1');
  });

  void project;
});

describe('links', () => {
  const project = useProject();

  it('rewrites a link to a Markdown file and keeps the fragment', () => {
    project.write('content/blog/b.md', '');
    const html = renderMarkdown('[b](b.md#part)\n', options());
    expect(html).toContain('<a href="/blog/b/#part">b</a>');
  });

  it('resolves a content-root path', () => {
    project.write('content/about.md', '');
    expect(renderMarkdown('[about](/about.md)\n', options())).toContain('href="/about/"');
  });

  it('fails for a missing file, naming the source file and link', () => {
    expect(() => renderMarkdown('[x](missing.md)\n', options())).toThrow(/content\/blog\/a\.md: link "missing\.md" does not point at a published page/);
  });

  it('fails for a link to a page that is not published, such as a draft', () => {
    project.write('content/blog/draft.md', '');
    expect(() => renderMarkdown('[x](draft.md)\n', options())).toThrow(/does not point at a published page/);
  });

  it('refuses to leave content/', () => {
    expect(() => renderMarkdown('[x](../../etc/passwd.md)\n', options())).toThrow(/points outside content\//);
  });

  it('leaves external, fragment, mailto, and non-Markdown links alone, and marks external ones noopener', () => {
    const html = renderMarkdown('[a](https://x.test/) [b](#here) [c](mailto:a@b.test) [d](/feed/feed.xml) [e](//cdn.test/)\n', options());
    expect(html).toContain('<a href="https://x.test/" rel="noopener">a</a>');
    expect(html).toContain('<a href="#here">b</a>');
    expect(html).toContain('<a href="mailto:a@b.test">c</a>');
    expect(html).toContain('<a href="/feed/feed.xml">d</a>');
    expect(html).toContain('<a href="//cdn.test/" rel="noopener">e</a>');
  });

  it('escapes quotes in an href and a title', () => {
    const html = renderMarkdown('[x](https://x.test/?a=1&b="2" "T \\"q\\"")\n', options());
    expect(html).not.toMatch(/href="[^"]*"[^>]*"2"/);
    expect(html).toContain('&amp;');
  });

  it('keeps replacement tokens in link text literal', () => {
    const html = renderMarkdown('[$& $1 $$ $\'](https://x.test/)\n', options());
    expect(html).toContain('>$&amp; $1 $$ $&#39;</a>');
  });
});

describe('images', () => {
  const project = useProject();

  it('adds real dimensions and lazy loading to a local image', () => {
    project.write('content/blog/a/p.png', png(40, 20));
    const html = renderMarkdown('![Alt text](p.png)\n', options({ file: 'blog/a/a.md' }));
    expect(html).toContain('<img src="/blog/a/p.png" alt="Alt text" width="40" height="20" loading="lazy" decoding="async">');
  });

  it('wraps an image with a title in a figure with a caption', () => {
    project.write('content/blog/a/p.png', png(40, 20));
    const html = renderMarkdown('![Alt](p.png "A <b>caption</b>")\n', options({ file: 'blog/a/a.md' }));
    expect(html).toContain('<figure><img');
    expect(html).toContain('<figcaption>A &lt;b&gt;caption&lt;/b&gt;</figcaption></figure>');
  });

  it('writes a srcset when sized copies sit beside the image', () => {
    project.write('content/blog/a/p.png', png(400, 200));
    project.write('content/blog/a/p-200w.png', png(200, 100));
    const html = renderMarkdown('![x](p.png)\n', options({ file: 'blog/a/a.md' }));
    expect(html).toContain('srcset="/blog/a/p-200w.png 200w, /blog/a/p.png 400w"');
  });

  it('fails for a local image that does not exist', () => {
    expect(() => renderMarkdown('![x](nope.png)\n', options())).toThrow(/content\/blog\/a\.md: image "nope\.png" does not exist/);
  });

  it('passes an image on another site through, lazily loaded', () => {
    const html = renderMarkdown('![x](https://img.test/p.png)\n', options());
    expect(html).toBe('<p><img src="https://img.test/p.png" alt="x" loading="lazy" decoding="async"></p>\n');
  });

  it('escapes the alt text', () => {
    project.write('content/blog/p.png', png(4, 4));
    expect(renderMarkdown('![a "b" <c>](p.png)\n', options())).toContain('alt="a &quot;b&quot; &lt;c&gt;"');
  });
});

describe('code', () => {
  it('highlights a known language and makes the block keyboard focusable', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```\n', options());
    expect(html).toContain('<pre class="language-javascript" tabindex="0"><code class="language-javascript">');
    expect(html).toContain('<span class="token keyword">const</span>');
  });

  it('accepts a language alias', () => {
    expect(renderMarkdown('```sh\nls\n```\n', options())).toContain('language-bash');
  });

  it('escapes a block with an unknown language and never runs it', () => {
    const html = renderMarkdown('```nonsense\n<script>alert(1)</script>\n```\n', options());
    expect(html).toBe('<pre tabindex="0"><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>\n');
  });

  it('escapes a block with no language', () => {
    const html = renderMarkdown('```\na < b && c\n```\n', options());
    expect(html).toContain('a &lt; b &amp;&amp; c');
  });

  it('does not let a code block use replacement tokens', () => {
    const html = renderMarkdown('```\n$& $1 $`\n```\n', options());
    expect(html).toContain('$&amp; $1 $`');
  });
});
