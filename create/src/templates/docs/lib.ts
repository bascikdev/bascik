/**
 * The docs template's Node-side modules (`src/lib/`), its `bascik.config.ts`,
 * and their tests. The modules import only Node, `marked` and
 * `@bascik/bascik/html`, so `docs.test.ts` beside this folder can load and run them.
 */

/** The folder the Markdown pages live in, relative to the project root. */
export const DOCS_CONTENT_DIR = "content/docs";

/**
 * The template's one departure from zero config: the Markdown and the helpers
 * in `src/lib/` are outside the folders the dev server watches, so the config names them.
 */
export const DOCS_BASCIK_CONFIG = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  assets: {
    inlineStyles: ["src/pages/css/styles.css"],
  },
  pipeline: {
    // Rebuild pages in the dev server when a Markdown page or a helper in src/lib/ changes.
    watchPaths: ["content/", "src/lib/"],
  },
  scripts: {
    // These scripts read a directory, so their output cannot be safely cached by imported-file contents.
    cache: {
      exclude: ["src/components/docs-*/**", "src/pages/docs/**", "src/pages/index.html"],
    },
  },
});
`;

/** `src/lib/site.ts`: the site's name, written once. Any text is safe here: it is a JSON string in a `.ts` file. */
export const siteModule = (
  siteName: string,
): string => `// src/lib/site.ts: facts about the site that several pages and components show.

/** The site's name, shown in the header, the footer and every page title. */
export const SITE_NAME = ${JSON.stringify(siteName)};
`;

/** `src/lib/head.ts`: the head tags every page prints, built with `html` so each value is escaped. */
export const HEAD_MODULE = `// src/lib/head.ts: the <title>, description, canonical URL and Open Graph tags of one page. Use it from a page's <head>:
//
//   <script data-bascik-build type="text/typescript">
//     import { pageHead } from "@/lib/head.ts";
//     export default () => pageHead({ title: "Pricing", description: "What each plan costs." });
//   </script>
//
// Absolute URLs come from BASCIK_SITE_URL, which you set per deployment (in .env or the build's environment).
import { html, type SafeHtml } from "@bascik/bascik/html";
import { SITE_NAME } from "./site.ts";

export interface PageHead {
  /** The page's own title. The site name is added after it. */
  title: string;
  /** One or two sentences for search results and link previews. */
  description: string;
  /** Keep the page out of search results, as the 404 page does. */
  noindex?: boolean;
}

/** The head tags of the page being built. html escapes every value for where it lands. */
export function pageHead(page: PageHead): SafeHtml {
  const title = \`\${page.title} - \${SITE_NAME}\`;
  const siteUrl = process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "");
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  // A canonical URL must be absolute, so it is only printed when the site URL is known (not in the dev server).
  const url =
    siteUrl && !page.noindex
      ? \`\${siteUrl}\${base}\${process.env.BASCIK_PAGE_PATH || "/"}\`
      : undefined;
  return html\`<title>\${title}</title>
    <meta name="description" content="\${page.description}" />
    \${page.noindex && html\`<meta name="robots" content="noindex" />\`}
    \${url && html\`<link rel="canonical" href="\${url}" />\`}
    <meta property="og:title" content="\${title}" />
    <meta property="og:description" content="\${page.description}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="\${SITE_NAME}" />
    \${url && html\`<meta property="og:url" content="\${url}" />\`}\`;
}
`;

export const HEAD_MODULE_TEST = `import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { pageHead } from './head.ts';
import { SITE_NAME } from './site.ts';

describe('pageHead', () => {
  const names = ['BASCIK_SITE_URL', 'BASCIK_BASE', 'BASCIK_PAGE_PATH'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
  });

  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('prints the page title with the site name, and the description', () => {
    const head = String(pageHead({ title: 'Getting started', description: 'Run the docs site locally.' }));
    expect(head).toContain('<title>Getting started - ');
    expect(head).toContain('<meta name="description" content="Run the docs site locally." />');
    expect(head).toContain('<meta property="og:description" content="Run the docs site locally." />');
    expect(SITE_NAME.length).toBeGreaterThan(0);
  });

  it('escapes a title and a description that hold HTML characters', () => {
    const head = String(pageHead({ title: '<b>Tom & "Ann"</b>', description: 'a "quoted" <i>note</i> & more' }));
    expect(head).not.toContain('<b>');
    expect(head).not.toContain('<i>');
    expect(head).toContain('<title>&lt;b&gt;Tom &amp; ');
    expect(head).toContain('content="a &quot;quoted&quot; &lt;i&gt;note&lt;/i&gt; &amp; more"');
  });

  it('prints no canonical URL until the site URL is known', () => {
    expect(String(pageHead({ title: 'A', description: 'B' }))).not.toContain('rel="canonical"');
  });

  it('builds the canonical URL from the site URL, the base and the page path', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com/';
    process.env.BASCIK_BASE = '/racing/';
    process.env.BASCIK_PAGE_PATH = '/docs/getting-started';
    const head = String(pageHead({ title: 'A', description: 'B' }));
    expect(head).toContain('<link rel="canonical" href="https://example.com/racing/docs/getting-started" />');
    expect(head).toContain('<meta property="og:url" content="https://example.com/racing/docs/getting-started" />');
  });

  it('marks a noindex page and gives it no canonical URL', () => {
    process.env.BASCIK_SITE_URL = 'https://example.com';
    const head = String(pageHead({ title: 'Page not found', description: 'B', noindex: true }));
    expect(head).toContain('<meta name="robots" content="noindex" />');
    expect(head).not.toContain('rel="canonical"');
  });
});
`;

/** `src/lib/markdown.ts`: front matter, Markdown to HTML, and the headings a table of contents lists. */
export const MARKDOWN_MODULE = `// src/lib/markdown.ts: turns one Markdown file into HTML, plus the headings its table of contents lists.
import { esc } from "@bascik/bascik/html";
import { Marked, type Token, type Tokens } from "marked";

/** A section heading in a page: what one "On this page" link points to. */
export interface Heading {
  /** The heading's id, unique in the page. */
  id: string;
  /** The heading as plain text. */
  text: string;
  /** 2 for ##, 3 for ###, and so on. */
  depth: number;
}

/** Ids the page itself uses (<main id="main">), which a heading must not repeat. */
const RESERVED_IDS = ["main"];

/** Split the front matter (\`key: value\` lines between two \`---\` lines) from the Markdown below it. */
export function parseFrontMatter(source: string): {
  data: Record<string, string>;
  body: string;
} {
  const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\\r?\\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const pair = /^([A-Za-z0-9_-]+):\\s*(.*)$/.exec(line);
    if (!pair) throw new Error(\`unreadable front matter line: \${line}\`);
    const value = pair[2].trim();
    data[pair[1]] = /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
  }
  return { data, body: source.slice(match[0].length) };
}

/** "Find a book" becomes "find-a-book". Letters and digits of any script are kept; everything else is a hyphen. */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/['\\u2019]/g, "")
    .replace(/[^\\p{L}\\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "section";

/** A heading's text without its Markdown or HTML markup, for the table of contents and the id. */
const plainText = (tokens: Token[]): string =>
  tokens
    .map((token) => {
      if (token.type === "html") return "";
      const inner = (token as Tokens.Generic).tokens;
      if (inner) return plainText(inner);
      return typeof (token as Tokens.Generic).text === "string"
        ? ((token as Tokens.Generic).text as string)
        : "";
    })
    .join("");

/**
 * Render a page's Markdown. Every heading gets an id that is unique in the page (a repeated heading gets
 * "-2", "-3", and so on), and the headings come back in order for the table of contents.
 *
 * Throws, naming \`where\`, on a "#" heading (the page title comes from front matter, and a page has one <h1>)
 * and on a skipped level such as "##" followed by "####".
 */
export function renderMarkdown(
  body: string,
  where: string,
): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const ids = new WeakMap<object, string>();
  const used = new Set(RESERVED_IDS);
  let previousDepth = 1;

  const marked = new Marked({
    renderer: {
      // marked's own heading, plus the id. The id comes from the heading's text, so it goes through esc().
      heading(token) {
        const tag = "h" + token.depth;
        const id = esc(ids.get(token) ?? "");
        const inline = this.parser.parseInline(token.tokens);
        return "<" + tag + ' id="' + id + '">' + inline + "</" + tag + ">\\n";
      },
    },
  });

  const tokens = marked.lexer(body);
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "heading") return;
    const heading = token as Tokens.Heading;
    const text = plainText(heading.tokens).trim();
    if (heading.depth === 1) {
      throw new Error(
        \`\${where}: "# \${text}" would be a second page title. The title comes from front matter, so start sections at "##".\`,
      );
    }
    if (heading.depth > previousDepth + 1) {
      throw new Error(
        \`\${where}: the heading "\${text}" skips a level (h\${previousDepth} to h\${heading.depth}). Use \${"#".repeat(previousDepth + 1)} here.\`,
      );
    }
    previousDepth = heading.depth;
    const base = slugify(text);
    let id = base;
    for (let count = 2; used.has(id); count++) id = \`\${base}-\${count}\`;
    used.add(id);
    ids.set(heading, id);
    headings.push({ id, text, depth: heading.depth });
  });

  return { html: marked.parser(tokens), headings };
}
`;

export const MARKDOWN_MODULE_TEST = `import { describe, it, expect } from 'vitest';
import { parseFrontMatter, renderMarkdown, slugify } from './markdown.ts';

describe('parseFrontMatter', () => {
  it('reads key: value lines and returns the Markdown below them', () => {
    const { data, body } = parseFrontMatter('---\\ntitle: "Braking zones"\\ndescription: Every reference.\\n---\\n\\nHello');
    expect(data).toEqual({ title: 'Braking zones', description: 'Every reference.' });
    expect(body.trim()).toBe('Hello');
  });

  it('returns the whole file as the body when there is no front matter', () => {
    expect(parseFrontMatter('Just text')).toEqual({ data: {}, body: 'Just text' });
  });

  it('throws on a line that is not key: value', () => {
    expect(() => parseFrontMatter('---\\ntitle\\n---\\n')).toThrow('unreadable front matter line: title');
  });
});

describe('slugify', () => {
  it('lowercases and joins words with hyphens', () => {
    expect(slugify('Find a Setup!')).toBe('find-a-setup');
    expect(slugify('  Tyre & pressure  ')).toBe('tyre-pressure');
    expect(slugify("A driver's race")).toBe('a-drivers-race');
  });

  it('never returns an empty id', () => {
    expect(slugify('???')).toBe('section');
  });
});

describe('renderMarkdown', () => {
  it('gives each heading an id and lists the headings in order', () => {
    const { html, headings } = renderMarkdown('## Install\\n\\ntext\\n\\n### With npm\\n', 'page.md');
    expect(html).toContain('<h2 id="install">Install</h2>');
    expect(html).toContain('<h3 id="with-npm">With npm</h3>');
    expect(headings).toEqual([
      { id: 'install', text: 'Install', depth: 2 },
      { id: 'with-npm', text: 'With npm', depth: 3 },
    ]);
  });

  it('keeps ids unique when headings repeat, and away from the id of <main>', () => {
    const { headings } = renderMarkdown('## Example\\n\\n## Example\\n\\n### Example\\n\\n## Main\\n', 'page.md');
    expect(headings.map((heading) => heading.id)).toEqual(['example', 'example-2', 'example-3', 'main-2']);
  });

  it('builds a valid id and plain text from a heading with HTML characters and Markdown', () => {
    const { html, headings } = renderMarkdown('## The \`<channel>\` tag & "quotes" in *data*\\n', 'page.md');
    expect(headings).toEqual([{ id: 'the-channel-tag-quotes-in-data', text: 'The <channel> tag & "quotes" in data', depth: 2 }]);
    expect(html).toContain('id="the-channel-tag-quotes-in-data"');
    expect(html).toContain('<code>&lt;channel&gt;</code>');
  });

  it('names the file when a page has a second title or skips a heading level', () => {
    expect(() => renderMarkdown('# Again\\n', 'content/docs/a.md')).toThrow('content/docs/a.md: "# Again" would be a second page title');
    expect(() => renderMarkdown('## One\\n\\n#### Four\\n', 'content/docs/a.md')).toThrow('content/docs/a.md: the heading "Four" skips a level (h2 to h4)');
    expect(() => renderMarkdown('### Three\\n', 'content/docs/a.md')).toThrow('skips a level (h1 to h3)');
  });
});
`;

/** `src/lib/sidebar.ts`: the order of the pages. The file a reader edits when adding a page. */
export const SIDEBAR_MODULE = `// src/lib/sidebar.ts: the docs sidebar, and so the order of the pages. To add a page, write
// ${DOCS_CONTENT_DIR}/<name>.md and add <name> to a group below.

export interface SidebarGroup {
  label: string;
  /** File names in ${DOCS_CONTENT_DIR}/ without ".md", in the order the sidebar shows them. */
  pages: string[];
}

/**
 * The sidebar: its groups in order, each listing its pages. Every file in ${DOCS_CONTENT_DIR}/ is listed once.
 * A page that is missing here, or an entry with no file, fails the build with an error that names it.
 */
export const SIDEBAR: SidebarGroup[] = [
  {
    label: "Start here",
    pages: ["getting-started", "writing-pages", "navigation-and-search"],
  },
  {
    label: "Customize",
    pages: ["components-and-design", "build-and-check", "deployment"],
  },
];

/** The introductory guide is the root page; the other guides live under /docs/. */
export const docHref = (slug: string): string =>
  slug === SIDEBAR[0]?.pages[0] ? "/" : \`/docs/\${slug}\`;

/** Where "Docs" links go: the introductory guide at the root. */
export const DOCS_HOME: string = "/";
`;

/** `src/lib/docs.ts`: the reader of `content/docs/`, and what each page is handed. */
export const DOCS_MODULE = `// src/lib/docs.ts: the one place that reads the Markdown pages in ${DOCS_CONTENT_DIR}/ and puts them in sidebar order.
// The page template, src/pages/docs/[slug].html, calls getDocs() once and hands every page its data, so the
// sidebar, the previous and next links, and the page itself always agree.
//
// A page is ${DOCS_CONTENT_DIR}/<name>.md with front matter:
//
//   ---
//   title: Getting started
//   description: One sentence for search results and the top of the page.
//   ---
//
// To add a page, write the file and add its name to SIDEBAR in src/lib/sidebar.ts.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter, renderMarkdown, type Heading } from "./markdown.ts";
import { SIDEBAR, docHref, type SidebarGroup } from "./sidebar.ts";

export const DOCS_DIR = "${DOCS_CONTENT_DIR}";

/** One Markdown page, read and rendered. */
export interface Doc {
  slug: string;
  title: string;
  description: string;
  /** The source Markdown, used to search the full page body. */
  searchText: string;
  /** The rendered Markdown. */
  html: string;
  /** The page's headings, for the "On this page" list. */
  headings: Heading[];
}

export interface DocLink {
  slug: string;
  title: string;
  href: string;
}

/** What one page is handed as its route data: the page, the sidebar, and its neighbors. */
export interface DocPage extends Doc {
  sidebar: { label: string; links: DocLink[] }[];
  previous?: DocLink;
  next?: DocLink;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Read one page's front matter and Markdown. Throws with the file name, so a bad page fails the build loudly. */
export function toDoc(slug: string, source: string): Doc {
  const where = \`\${DOCS_DIR}/\${slug}.md\`;
  if (!SLUG.test(slug)) {
    throw new Error(
      \`\${where}: file names must be lowercase words joined by hyphens (they become URLs)\`,
    );
  }
  const { data, body } = parseFrontMatter(source);
  const title = (data.title ?? "").trim();
  const description = (data.description ?? "").trim();
  if (!title) throw new Error(\`\${where}: front matter needs a title\`);
  if (!description)
    throw new Error(\`\${where}: front matter needs a description\`);
  return {
    slug,
    title,
    description,
    searchText: body,
    ...renderMarkdown(body, where),
  };
}

/**
 * Put the pages in sidebar order and give each its sidebar and its previous and next page.
 * Throws when the sidebar and the files disagree: an entry with no file, a file with no entry, or an entry listed twice.
 */
export function orderDocs(
  docs: Doc[],
  sidebar: SidebarGroup[] = SIDEBAR,
): DocPage[] {
  const bySlug = new Map(docs.map((doc) => [doc.slug, doc]));
  const listed = sidebar.flatMap((group) => group.pages);
  const seen = new Set<string>();
  for (const slug of listed) {
    if (seen.has(slug)) {
      throw new Error(\`src/lib/sidebar.ts: SIDEBAR lists "\${slug}" twice.\`);
    }
    seen.add(slug);
    if (!bySlug.has(slug)) {
      throw new Error(
        \`src/lib/sidebar.ts: SIDEBAR lists "\${slug}", but \${DOCS_DIR}/\${slug}.md does not exist. Create the file or remove the entry.\`,
      );
    }
  }
  for (const doc of docs) {
    if (!seen.has(doc.slug)) {
      throw new Error(
        \`\${DOCS_DIR}/\${doc.slug}.md is not in the sidebar. Add "\${doc.slug}" to SIDEBAR in src/lib/sidebar.ts, or delete the file.\`,
      );
    }
  }
  const link = (slug: string): DocLink => ({
    slug,
    title: bySlug.get(slug)!.title,
    href: docHref(slug),
  });
  const groups = sidebar.map((group) => ({
    label: group.label,
    links: group.pages.map(link),
  }));
  return listed.map((slug, index) => ({
    ...bySlug.get(slug)!,
    sidebar: groups,
    previous: index > 0 ? link(listed[index - 1]) : undefined,
    next: index < listed.length - 1 ? link(listed[index + 1]) : undefined,
  }));
}

/** Every page in sidebar order. Paths are relative to the project root, where Bascik runs build scripts. */
export async function getDocs(dir: string = DOCS_DIR): Promise<DocPage[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".md"));
  const docs = await Promise.all(
    files.map(async (file) =>
      toDoc(file.slice(0, -3), await readFile(join(dir, file), "utf8")),
    ),
  );
  return orderDocs(docs);
}
`;

/** Context-dependent rendering stays out of the build-once search directory reader. */
export const CURRENT_DOC_MODULE = `import { getDocs, type DocPage } from "./docs.ts";

/**
 * The page being built. Bascik passes each page of src/pages/docs/[slug].html its route data in BASCIK_ROUTE,
 * so the docs components (sidebar, article, table of contents, previous and next) read it here.
 */
export async function currentDoc(): Promise<DocPage> {
  const route = JSON.parse(process.env.BASCIK_ROUTE || "{}") as {
    data?: DocPage;
  };
  // The static root uses the first guide, while bracket routes supply their own data.
  if (!route.data && process.env.BASCIK_PAGE_PATH === "/") {
    const first = (await getDocs())[0];
    if (!first) throw new Error("The docs site needs an introductory guide.");
    return first;
  }
  if (!route.data) {
    throw new Error(
      "currentDoc() found no page: the docs components only work on the root or src/pages/docs/[slug].html.",
    );
  }
  return route.data;
}
`;

export const DOCS_MODULE_TEST = `import { describe, it, expect } from 'vitest';
import { getDocs, orderDocs, toDoc, type Doc } from './docs.ts';
import { DOCS_HOME, SIDEBAR } from './sidebar.ts';

const doc = (slug: string): Doc => toDoc(slug, \`---\\ntitle: \${slug}\\ndescription: About \${slug}.\\n---\\n\\n## Section\\n\`);

describe('the pages in content/docs', () => {
  it('match the sidebar, in its order, each with a title and a description', async () => {
    const pages = await getDocs();
    expect(pages.map((page) => page.slug)).toEqual(SIDEBAR.flatMap((group) => group.pages));
    for (const page of pages) {
      expect(page.title).not.toBe('');
      expect(page.description).not.toBe('');
      expect(page.html).not.toBe('');
    }
    expect(DOCS_HOME).toBe("/");
  });

  it('link each page to the one before and after it', async () => {
    const pages = await getDocs();
    expect(pages[0].previous).toBeUndefined();
    expect(pages[0].next?.slug).toBe(pages[1].slug);
    expect(pages.at(-1)?.next).toBeUndefined();
    expect(pages.at(-1)?.previous?.slug).toBe(pages.at(-2)?.slug);
  });
});

describe('toDoc', () => {
  it('names the file when the front matter has no title or description', () => {
    expect(() => toDoc('a-page', 'No front matter')).toThrow('content/docs/a-page.md: front matter needs a title');
    expect(() => toDoc('a-page', '---\\ntitle: A page\\n---\\n')).toThrow('content/docs/a-page.md: front matter needs a description');
  });

  it('refuses a file name that would not make a clean URL', () => {
    expect(() => toDoc('My Page', '---\\ntitle: x\\ndescription: y\\n---\\n')).toThrow('file names must be lowercase words joined by hyphens');
  });
});

describe('orderDocs', () => {
  const sidebar = [
    { label: 'Guides', pages: ['one', 'two'] },
    { label: 'Reference', pages: ['three'] },
  ];

  it('orders pages by the sidebar and gives every page the same groups', () => {
    const pages = orderDocs([doc('three'), doc('one'), doc('two')], sidebar);
    expect(pages.map((page) => page.slug)).toEqual(['one', 'two', 'three']);
    expect(pages[1].previous?.href).toBe('/docs/one');
    expect(pages[1].next?.href).toBe('/docs/three');
    expect(pages[0].sidebar.map((group) => group.label)).toEqual(['Guides', 'Reference']);
  });

  it('names a sidebar entry that has no page', () => {
    expect(() => orderDocs([doc('one'), doc('two')], sidebar)).toThrow('SIDEBAR lists "three", but content/docs/three.md does not exist');
  });

  it('names a page that is missing from the sidebar', () => {
    expect(() => orderDocs([doc('one'), doc('two'), doc('three'), doc('four')], sidebar)).toThrow(
      'content/docs/four.md is not in the sidebar. Add "four" to SIDEBAR',
    );
  });

  it('names an entry listed twice', () => {
    expect(() => orderDocs([doc('one')], [{ label: 'Guides', pages: ['one', 'one'] }])).toThrow('SIDEBAR lists "one" twice');
  });
});

`;

export const CURRENT_DOC_MODULE_TEST = `import { describe, it, expect } from "vitest";
import { currentDoc } from "./current-doc.ts";
import { getDocs } from "./docs.ts";
import { SIDEBAR } from "./sidebar.ts";

describe('currentDoc', () => {
  it('reads the first guide for the static root and keeps its neighbors', async () => {
    const route = process.env.BASCIK_ROUTE;
    const path = process.env.BASCIK_PAGE_PATH;
    delete process.env.BASCIK_ROUTE;
    process.env.BASCIK_PAGE_PATH = "/";
    try {
      const page = await currentDoc();
      expect(page.slug).toBe(SIDEBAR[0].pages[0]);
      expect(page.previous).toBeUndefined();
      expect(page.next?.href).toBe("/docs/writing-pages");
    } finally {
      if (route === undefined) delete process.env.BASCIK_ROUTE;
      else process.env.BASCIK_ROUTE = route;
      if (path === undefined) delete process.env.BASCIK_PAGE_PATH;
      else process.env.BASCIK_PAGE_PATH = path;
    }
  });

  it('uses supplied route data for the remaining guides', async () => {
    const route = process.env.BASCIK_ROUTE;
    const page = (await getDocs())[1];
    process.env.BASCIK_ROUTE = JSON.stringify({ data: page });
    try { expect(await currentDoc()).toEqual(page); }
    finally {
      if (route === undefined) delete process.env.BASCIK_ROUTE;
      else process.env.BASCIK_ROUTE = route;
    }
  });

  it('explains itself when a component is used outside the docs page template', async () => {
    const before = process.env.BASCIK_ROUTE;
    delete process.env.BASCIK_ROUTE;
    try {
      await expect(currentDoc()).rejects.toThrow('only work on the root or src/pages/docs/[slug].html');
    } finally {
      if (before !== undefined) process.env.BASCIK_ROUTE = before;
    }
  });
});
`;
