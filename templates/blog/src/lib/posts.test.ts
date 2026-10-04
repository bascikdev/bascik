import { describe, expect, it } from 'vitest';
import { collectTags, findPost, loadPosts, newestFirst, postRoutes } from './posts.ts';
import { png, useProject } from './test-helpers.ts';

describe('loadPosts', () => {
  const project = useProject();

  it('returns an empty list when content/blog does not exist', async () => {
    expect(await loadPosts()).toEqual([]);
  });

  it('reads posts oldest first and breaks date ties by file name', async () => {
    project.post('b.md', { title: 'B', date: '2026-02-01' });
    project.post('a.md', { title: 'A', date: '2026-02-01' });
    project.post('c.md', { title: 'C', date: '2026-01-01' });
    const posts = await loadPosts();
    expect(posts.map((post) => post.slug)).toEqual(['c', 'a', 'b']);
    expect(newestFirst(posts).map((post) => post.slug)).toEqual(['b', 'a', 'c']);
  });

  it('publishes name.md and name/name.md at /blog/name/', async () => {
    project.post('one.md', { title: 'One', date: '2026-01-01' });
    project.post('two/two.md', { title: 'Two', date: '2026-01-02' });
    expect((await loadPosts()).map((post) => post.url)).toEqual(['/blog/one/', '/blog/two/']);
  });

  it('rejects a duplicate address', async () => {
    project.post('same.md', { title: 'One', date: '2026-01-01' });
    project.post('same/same.md', { title: 'Two', date: '2026-01-02' });
    await expect(loadPosts()).rejects.toThrow(/both publish \/blog\/same\//);
  });

  it.each(['deep/er/x.md', 'folder/other.md'])('rejects the unsupported location %s', async (path) => {
    project.post(path, { title: 'X', date: '2026-01-01' });
    await expect(loadPosts()).rejects.toThrow(/use content\/blog\/name\.md or content\/blog\/name\/name\.md/);
  });

  it.each(['My Post.md', 'Upper.md', 'a_b.md', 'double--hyphen.md', '-lead.md', 'trail-.md'])('rejects the file name %s', async (name) => {
    project.post(name, { title: 'X', date: '2026-01-01' });
    await expect(loadPosts()).rejects.toThrow(/lowercase letters, digits, and single hyphens/);
  });

  it('reserves "page" because /blog/page/N/ is the archive', async () => {
    project.post('page.md', { title: 'X', date: '2026-01-01' });
    await expect(loadPosts()).rejects.toThrow(/reserved/);
  });

  it('ignores dot files and folders and non-Markdown files', async () => {
    project.post('real.md', { title: 'Real', date: '2026-01-01' });
    project.post('.hidden.md', { title: 'Hidden', date: '2026-01-01' });
    project.post('.private/x.md', { title: 'Hidden', date: '2026-01-01' });
    project.write('content/blog/notes.txt', 'not a post');
    expect((await loadPosts()).map((post) => post.slug)).toEqual(['real']);
  });

  describe('front matter', () => {
    it.each([
      ['a missing title', { date: '2026-01-01' }, /title/],
      ['an empty title', { title: '  ', date: '2026-01-01' }, /title is required/],
      ['a missing date', { title: 'X' }, /date/],
      ['an invalid date', { title: 'X', date: 'next tuesday' }, /date/],
      ['a misspelled key', { title: 'X', date: '2026-01-01', tag: 'x' }, /tag/],
      ['a non-boolean draft', { title: 'X', date: '2026-01-01', draft: 'yes' }, /draft/],
    ])('fails clearly for %s', async (_name, fields, message) => {
      project.post('x.md', fields);
      await expect(loadPosts()).rejects.toThrow(message);
      await expect(loadPosts()).rejects.toThrow(/content\/blog\/x\.md/);
    });

    it('accepts one tag or a list and trims them', async () => {
      project.post('one.md', { title: 'One', date: '2026-01-01', tags: ' solo ' });
      project.post('two.md', { title: 'Two', date: '2026-01-02', tags: ['a', ' b '] });
      const posts = await loadPosts();
      expect(posts[0]?.tags).toEqual(['solo']);
      expect(posts[1]?.tags).toEqual(['a', 'b']);
    });

    it('rejects an empty tag', async () => {
      project.post('x.md', { title: 'X', date: '2026-01-01', tags: ['ok', ' '] });
      await expect(loadPosts()).rejects.toThrow(/tags cannot be empty/);
    });

    it('keeps YAML-special characters in titles intact', async () => {
      project.post('x.md', { title: 'Q: "quoted" & <b>bold</b> $1 $&', date: '2026-01-01' });
      expect((await loadPosts())[0]?.title).toBe('Q: "quoted" & <b>bold</b> $1 $&');
    });
  });

  describe('drafts', () => {
    it('are left out of a production build and kept in development', async () => {
      project.post('draft.md', { title: 'Hidden', date: '2026-01-01', draft: true });
      project.post('live.md', { title: 'Live', date: '2026-01-02' });
      expect((await loadPosts()).map((post) => post.slug)).toEqual(['live']);

      process.env.BASCIK_BUILD = '0';
      const dev = await loadPosts();
      expect(dev.map((post) => post.slug)).toEqual(['draft', 'live']);
      expect(dev[0]).toMatchObject({ draft: true, title: 'Hidden (draft)' });
    });

    it('can be requested explicitly', async () => {
      project.post('draft.md', { title: 'Hidden', date: '2026-01-01', draft: true });
      expect(await loadPosts({ drafts: true })).toHaveLength(1);
    });

    it('still validate in a production build, so a broken draft is found before it is published', async () => {
      project.post('draft.md', { title: 'Hidden', draft: true });
      await expect(loadPosts()).rejects.toThrow(/Invalid front matter/);
    });

    it('do not reserve their address in a production build', async () => {
      project.post('same.md', { title: 'Draft', date: '2026-01-01', draft: true });
      project.post('same/same.md', { title: 'Live', date: '2026-01-02' });
      expect((await loadPosts()).map((post) => post.title)).toEqual(['Live']);
    });
  });

  describe('image', () => {
    it('resolves relative to the post and is stored relative to content/', async () => {
      project.write('content/blog/pic/pic.png', png(10, 5));
      project.post('pic/pic.md', { title: 'Pic', date: '2026-01-01', image: 'pic.png', imageAlt: 'A pic' });
      expect(await loadPosts()).toMatchObject([{ image: 'blog/pic/pic.png', imageAlt: 'A pic' }]);
    });

    it('can be addressed from the content root', async () => {
      project.write('content/blog/shared/hero.png', png(10, 5));
      project.post('x.md', { title: 'X', date: '2026-01-01', image: '/blog/shared/hero.png' });
      expect((await loadPosts())[0]?.image).toBe('blog/shared/hero.png');
    });

    it('fails when the file is missing', async () => {
      project.post('x.md', { title: 'X', date: '2026-01-01', image: 'nope.png' });
      await expect(loadPosts()).rejects.toThrow(/image "nope\.png" does not exist/);
    });

    it('cannot escape content/', async () => {
      project.write('secret.png', png(1, 1));
      project.post('x.md', { title: 'X', date: '2026-01-01', image: '../../../secret.png' });
      await expect(loadPosts()).rejects.toThrow(/points outside content\//);
    });
  });
});

describe('collectTags', () => {
  const project = useProject();

  it('groups posts, sorts tags alphabetically, and counts a repeated tag once per post', async () => {
    project.post('a.md', { title: 'A', date: '2026-01-01', tags: ['zeta', 'alpha', 'alpha'] });
    project.post('b.md', { title: 'B', date: '2026-01-02', tags: ['alpha'] });
    const groups = collectTags(await loadPosts());
    expect(groups.map((group) => [group.name, group.slug, group.posts.length])).toEqual([
      ['alpha', 'alpha', 2],
      ['zeta', 'zeta', 1],
    ]);
  });

  it('turns a tag into a URL-safe slug', async () => {
    project.post('a.md', { title: 'A', date: '2026-01-01', tags: ['Field notes'] });
    expect(collectTags(await loadPosts())[0]).toMatchObject({ name: 'Field notes', slug: 'field-notes' });
  });

  it('refuses two tags that would publish the same page', async () => {
    project.post('a.md', { title: 'A', date: '2026-01-01', tags: ['Notes'] });
    project.post('b.md', { title: 'B', date: '2026-01-02', tags: ['notes'] });
    const posts = await loadPosts();
    expect(() => collectTags(posts)).toThrow(/would both publish \/tags\/notes\//);
  });

  it('refuses a tag with nothing to build a URL from', async () => {
    project.post('a.md', { title: 'A', date: '2026-01-01', tags: ['!!!'] });
    const posts = await loadPosts();
    expect(() => collectTags(posts)).toThrow(/no letters or digits/);
  });
});

describe('routes', () => {
  const project = useProject();

  it('lists one route per post and finds a post by slug', async () => {
    project.post('a.md', { title: 'A', date: '2026-01-01' });
    const posts = await loadPosts();
    expect(postRoutes(posts)).toEqual([{ params: { slug: 'a' } }]);
    expect(findPost(posts, 'a').title).toBe('A');
    expect(() => findPost(posts, 'missing')).toThrow(/No post for route \/blog\/missing\//);
  });
});
