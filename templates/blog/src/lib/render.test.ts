import { describe, expect, it } from 'vitest';
import { loadPosts } from './posts.ts';
import { renderArchive, renderHead, renderHome, renderPager, renderPost, renderPostList, renderTagPage, renderTagsIndex } from './render.ts';
import { collectTags } from './posts.ts';
import { png, useProject } from './test-helpers.ts';

function posts(project: ReturnType<typeof useProject>, count: number, extra: Record<string, unknown> = {}): void {
  for (let n = 1; n <= count; n++) {
    project.post(`post-${String(n).padStart(2, '0')}.md`, { title: `Post ${n}`, date: `2026-01-${String(n).padStart(2, '0')}`, ...extra });
  }
}

describe('renderHead', () => {
  const project = useProject();

  it('omits absolute URLs without a site URL instead of writing relative ones', () => {
    const html = renderHead({ title: 'Hello' });
    expect(html).toContain('<title>Hello | Lantern Log</title>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).not.toContain('canonical');
    expect(html).not.toContain('og:url');
    expect(html).not.toContain('og:image');
    expect(html).toContain('twitter:card" content="summary"');
  });

  it('adds canonical, Open Graph, and image tags with a site URL', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    process.env.BASCIK_PAGE_PATH = '/blog/hello/';
    const html = renderHead({ title: 'Hello', description: 'D', image: '/blog/hello/p.png', type: 'article', published: new Date('2026-01-05T00:00:00Z'), tags: ['a', 'b'] });
    expect(html).toContain('<link rel="canonical" href="https://example.com/blog/hello/">');
    expect(html).toContain('<meta property="og:image" content="https://example.com/blog/hello/p.png">');
    expect(html).toContain('twitter:card" content="summary_large_image"');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta property="article:published_time" content="2026-01-05">');
    expect(html.match(/article:tag/g)).toHaveLength(2);
    expect(html).toContain('og:title" content="Hello"');
  });

  it('falls back to the site social card', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    expect(renderHead()).toContain('content="https://example.com/assets/social-card.png"');
  });

  it('escapes every value', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    const html = renderHead({ title: '"><script>x</script>', description: `a "b" & 'c'`, tags: ['"t"'], type: 'article', published: new Date(0) });
    expect(html).not.toContain('<script>');
    expect(html).toContain('<title>&quot;&gt;&lt;script&gt;x&lt;/script&gt; | Lantern Log</title>');
    expect(html).toContain('a &quot;b&quot; &amp; &#39;c&#39;');
    expect(html).toContain('content="&quot;t&quot;"');
  });

  it('keeps the 404 page out of search indexes and gives it no canonical link', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    const html = renderHead({ title: 'Page not found', noindex: true });
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('canonical');
    expect(html).not.toContain('og:');
  });

  void project;
});

describe('home page', () => {
  const project = useProject();

  it('shows the latest posts newest first and counts the rest', async () => {
    posts(project, 5);
    const html = renderHome(await loadPosts());
    expect(html).toContain('<h1 id="latest">Latest posts</h1>');
    expect(html.match(/postlist-link/g)).toHaveLength(3);
    expect(html.indexOf('Post 5')).toBeLessThan(html.indexOf('Post 4'));
    expect(html).not.toContain('Post 2<');
    expect(html).toContain('2 more posts in <a href="/blog/">the archive</a>.');
    expect(html).toContain('start="5"');
  });

  it('has no archive link when everything fits', async () => {
    posts(project, 2);
    expect(renderHome(await loadPosts())).not.toContain('more post');
  });

  it('uses the singular for one post and says so for none', async () => {
    posts(project, 1);
    expect(renderHome(await loadPosts())).toContain('Latest post</h1>');
    expect(renderPostList([])).toBe('<p>No posts yet.</p>');
  });
});

describe('archive', () => {
  const project = useProject();

  it('paginates with continuing numbers and a pager', async () => {
    posts(project, 7);
    const all = await loadPosts();
    const first = renderArchive(all, 1);
    expect(first).toContain('<h1 id="archive">Archive</h1>');
    expect(first).toContain('start="7"');
    expect(first.match(/postlist-link/g)).toHaveLength(5);
    expect(first).toContain('Page 1 of 2');
    expect(first).toContain('<a href="/blog/page/2/" rel="next">Older posts');
    expect(first).not.toContain('rel="prev"');

    const second = renderArchive(all, 2);
    expect(second).toContain('<h1 id="archive">Archive, page 2</h1>');
    expect(second).toContain('start="2"');
    expect(second.match(/postlist-link/g)).toHaveLength(2);
    expect(second).toContain('<a href="/blog/" rel="prev">\u2190 Newer posts</a>');
    expect(second).not.toContain('rel="next"');
  });

  it('has no pager for a single page, and still renders when empty', async () => {
    posts(project, 3);
    expect(renderArchive(await loadPosts(), 1)).not.toContain('class="pager"');
    expect(renderPager({ items: [], page: 1, pages: 1 })).toBe('');
  });

  it('rejects a page that does not exist', async () => {
    posts(project, 3);
    const all = await loadPosts();
    expect(() => renderArchive(all, 2)).toThrow(/Archive page 2 does not exist; there is 1 page/);
    expect(() => renderArchive(all, 0)).toThrow(/does not exist/);
  });
});

describe('tags', () => {
  const project = useProject();

  it('lists tags with counts and renders each tag page newest first', async () => {
    project.post('a.md', { title: 'A', date: '2026-01-01', tags: ['Field notes'] });
    project.post('b.md', { title: 'B', date: '2026-01-02', tags: ['Field notes', 'misc'] });
    const loaded = await loadPosts();
    const index = renderTagsIndex(loaded);
    expect(index).toContain('<a href="/tags/field-notes/" class="post-tag">Field notes</a> <span class="tag-count">(2)</span>');
    expect(index).toContain('(1)');

    const group = collectTags(loaded).find((tag) => tag.slug === 'field-notes');
    const page = renderTagPage(group!);
    expect(page).toContain('Tagged \u201cField notes\u201d');
    expect(page.indexOf('>B<')).toBeLessThan(page.indexOf('>A<'));
  });

  it('says so when there are no tags', () => {
    expect(renderTagsIndex([])).toContain('No tags yet.');
  });
});

describe('renderPost', () => {
  const project = useProject();

  it('escapes the title, links neighbors, and links tags', async () => {
    project.post('a.md', { title: 'First', date: '2026-01-01' });
    project.post('b.md', { title: '<Second> & "more"', date: '2026-01-02', tags: ['x y'] });
    project.post('c.md', { title: 'Third', date: '2026-01-03' });
    const loaded = await loadPosts();
    const html = renderPost(loaded[1]!, loaded);
    expect(html).toContain('<h1 id="second-more">&lt;Second&gt; &amp; &quot;more&quot;</h1>');
    expect(html).toContain('<a href="/tags/x-y/" class="post-tag">x y</a>');
    expect(html).toContain('<a href="/blog/a/" rel="prev">First</a>');
    expect(html).toContain('<a href="/blog/c/" rel="next">Third</a>');
    expect(html).toContain('<time datetime="2026-01-02">January 2, 2026</time>');
  });

  it('has no previous link on the oldest post and no next link on the newest', async () => {
    posts(project, 2);
    const loaded = await loadPosts();
    expect(renderPost(loaded[0]!, loaded)).not.toContain('links-nextprev-prev');
    expect(renderPost(loaded[1]!, loaded)).not.toContain('links-nextprev-next');
  });

  it('has no neighbor list for a single post', async () => {
    posts(project, 1);
    const loaded = await loadPosts();
    expect(renderPost(loaded[0]!, loaded)).not.toContain('links-nextprev');
  });

  it('renders the hero image eagerly with its sized copies', async () => {
    project.write('content/blog/pic/pic.png', png(400, 200));
    project.write('content/blog/pic/pic-200w.png', png(200, 100));
    project.post('pic/pic.md', { title: 'Pic', date: '2026-01-01', image: 'pic.png', imageAlt: 'Alt' });
    const loaded = await loadPosts();
    const html = renderPost(loaded[0]!, loaded);
    expect(html).toContain('<div class="hero"><img src="/blog/pic/pic.png" srcset="/blog/pic/pic-200w.png 200w, /blog/pic/pic.png 400w"');
    expect(html).toContain('fetchpriority="high"');
    expect(html).toContain('alt="Alt"');
  });

  it('keeps a body heading that repeats the title distinct from the title id', async () => {
    project.post('a.md', { title: 'Same', date: '2026-01-01' }, '## Same\n\ntext');
    const loaded = await loadPosts();
    const html = renderPost(loaded[0]!, loaded);
    expect(html).toContain('<h1 id="same">');
    expect(html).toContain('<h2 id="same-2">');
  });

  it('fails the build for a body link to a draft', async () => {
    project.post('draft.md', { title: 'Draft', date: '2026-01-01', draft: true });
    project.post('live.md', { title: 'Live', date: '2026-01-02' }, '[d](draft.md)');
    const loaded = await loadPosts();
    expect(() => renderPost(loaded[0]!, loaded)).toThrow(/does not point at a published page/);
  });

  it('allows a link to a draft in development, where drafts are listed', async () => {
    process.env.BASCIK_BUILD = '0';
    project.post('draft.md', { title: 'Draft', date: '2026-01-01', draft: true });
    project.post('live.md', { title: 'Live', date: '2026-01-02' }, '[d](draft.md)');
    const loaded = await loadPosts();
    const live = loaded.find((post) => post.slug === 'live')!;
    expect(renderPost(live, loaded)).toContain('href="/blog/draft/"');
  });
});
