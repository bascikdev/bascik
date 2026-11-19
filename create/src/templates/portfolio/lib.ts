/**
 * @module templates/portfolio/lib
 *
 * The portfolio's TypeScript modules under `src/lib/`, their tests, and the project config.
 *
 * `src/lib/books.ts` is the collection: a typed array, checked when the module loads so a bad entry stops the
 * build with a message that names it. `src/lib/site.ts` is the only file that holds the site's name.
 */

/**
 * `src/lib/site.ts` for a site name. The name is written as a JSON string, which is a TypeScript string literal,
 * so any name is safe here; the pages print it with `html` from `@bascik/bascik/html`, which escapes it for HTML.
 */
export const siteModule = (
  siteName: string,
): string => `// The facts several pages and components show. Change one here and every page follows.
export const site = {
  /** The site's name: the header logo, og:site_name, and the end of every page title. */
  name: ${JSON.stringify(siteName)},
  /** Who the site is about. */
  author: "Hayden Vale Racing",
  role: "Motorsport engineering and race programs",
  tagline:
    "Race engineering, classic Porsche restoration, photography, and driver development from Daytona to Le Mans.",
  /** The home page's description in search results: one or two sentences. */
  description:
    "Motorsport portfolio covering race engineering, Porsche restoration, race photography, driver development, and track programs.",
} as const;
`;

/** `bascik.config.ts`: the one setting the site needs that is not a default. */
export const BASCIK_CONFIG = `import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  pipeline: {
    // Rebuild pages in dev when project Markdown or shared helpers change.
    // Component and page folders are watched already.
    watchPaths: ["src/lib/", "content/projects/"],
  },
  scripts: {
    cache: {
      exclude: ["@/lib/projects.ts", "src/pages/work/[slug].html", "src/pages/work.html", "src/pages/index.html"],
    },
  },
});
`;

/** `src/lib/books.ts`: the types, the sample books, and the check that runs when the module loads. */
export const BOOKS_TS = `// The books this site shows. Each entry becomes a card on /work and a page at /work/<slug>
// (src/pages/work/[slug].html). To add a book, add an entry; to remove one, delete it.
//
// Bascik strips the types without checking them, so checkBooks() checks every entry when this module loads:
// a missing field or a slug used twice stops the build with a message that names the book.

/** The cover colors <book-cover> draws (src/components/book-cover/book-cover.html). Add a color in both files. */
export const COVER_TONES = [
  "amber",
  "moss",
  "tide",
  "plum",
  "rust",
  "slate",
] as const;
export type CoverTone = (typeof COVER_TONES)[number];

export interface Book {
  /** The last part of the page's URL: lowercase letters, digits, and hyphens. Unique. */
  slug: string;
  title: string;
  /** The year it was published. */
  year: number;
  /** What kind of book it is, such as "Novel" or "Essays". */
  kind: string;
  /** One sentence: the card's text and the page's description in search results (50 to 160 characters reads best). */
  summary: string;
  /** The page's text, one string per paragraph. */
  description: string[];
  cover: {
    tone: CoverTone;
    /** What the cover shows, for people who cannot see it. */
    alt: string;
  };
  pages?: number;
  /** Show the book on the home page. */
  featured?: boolean;
}

/** Every book, newest first: the order written here is the order on the site. */
export const books: Book[] = checkBooks([
  {
    slug: "nine-letters-to-a-lighthouse",
    title: "Nine Letters to a Lighthouse",
    year: 2025,
    kind: "Novella",
    pages: 148,
    featured: true,
    summary:
      "A keeper's granddaughter writes to the light that raised her family, one letter for each year it has stood dark.",
    description: [
      "The Carrow light was switched off nine years ago, and nobody told Mirren Ashby, who grew up in its kitchen. She finds out from a postcard. What follows is a year of letters addressed to a building: furious, funny, and slowly forgiving.",
      "This is the shortest book on the shelf and the one readers write back about most. It can be read in an evening, preferably a windy one.",
    ],
    cover: {
      tone: "tide",
      alt: "Cover of Nine Letters to a Lighthouse: the title in white serif type on deep sea blue.",
    },
  },
  {
    slug: "the-lamplighters-almanac",
    title: "The Lamplighter's Almanac",
    year: 2023,
    kind: "Novel",
    pages: 384,
    featured: true,
    summary:
      "A town that still lights its streets by hand hires its first new lamplighter in forty years, and she keeps notes.",
    description: [
      "Pell Harbor has 212 gas lamps and one rule: each is lit by a person, at dusk, every day of the year. When the old lamplighter retires, the job goes to Wren Tolland, who is nineteen, afraid of ladders, and unable to stop writing things down.",
      "Told as a year of almanac entries, the novel follows one round of the lamps through four seasons, three funerals, a wedding, and a flood.",
    ],
    cover: {
      tone: "amber",
      alt: "Cover of The Lamplighter's Almanac: the title in white serif type on warm amber.",
    },
  },
  {
    slug: "tide-tables-for-beginners",
    title: "Tide Tables for Beginners",
    year: 2021,
    kind: "Short stories",
    pages: 226,
    featured: true,
    summary:
      "Eleven stories set between high and low water, about people learning something later than they meant to.",
    description: [
      "A retired pilot takes swimming lessons. A ferry cook studies for a law degree between crossings. A widower learns to read the sky from his late wife's notebooks. Each story happens in the six hours between one tide and the next.",
      "Several of these stories first appeared in small magazines; three are new to this collection.",
    ],
    cover: {
      tone: "moss",
      alt: "Cover of Tide Tables for Beginners: the title in white serif type on moss green.",
    },
  },
  {
    slug: "glasshouse-winter",
    title: "Glasshouse Winter",
    year: 2019,
    kind: "Novel",
    pages: 312,
    summary:
      "Two sisters inherit a botanical garden in the coldest winter on record and have until spring to decide what lives.",
    description: [
      "The boilers at Hollin Garden can keep one glasshouse warm, not five. Ada wants to save the orchids their mother collected; June wants to save the garden's accounts. The frost does not wait for them to agree.",
      "A novel about inheritance, heating bills, and the difference between keeping something and keeping it alive.",
    ],
    cover: {
      tone: "plum",
      alt: "Cover of Glasshouse Winter: the title in white serif type on dark plum.",
    },
  },
  {
    slug: "a-small-hours-atlas",
    title: "A Small Hours Atlas",
    year: 2017,
    kind: "Essays",
    pages: 198,
    summary:
      "Essays on night shifts, ferry timetables, and the maps people draw of places they only visit after midnight.",
    description: [
      "Fourteen essays written between midnight and five in the morning, in the places that are open then: a bakery, a signal box, a hospital car park, the upper deck of the last boat home.",
      "Part travel writing and part sleep diary, the book asks who keeps a town running while it sleeps, and what they see.",
    ],
    cover: {
      tone: "slate",
      alt: "Cover of A Small Hours Atlas: the title in white serif type on slate gray.",
    },
  },
  {
    slug: "the-salt-ledger",
    title: "The Salt Ledger",
    year: 2015,
    kind: "Novel",
    pages: 296,
    summary:
      "A debut novel about a salt works, the family that keeps its books, and the one entry nobody will explain.",
    description: [
      "For a hundred and forty years the Marsh family has written down every sack of salt that left Saltwick Pans. Then a new bookkeeper finds a line in the ledger for 1911 that has been paid, every year since, to no one.",
      "The first novel, and still the one with the most weather in it.",
    ],
    cover: {
      tone: "rust",
      alt: "Cover of The Salt Ledger: the title in white serif type on rust red.",
    },
  },
]);

/** The books the home page shows. */
export const featuredBooks = (): Book[] =>
  books.filter((book) => book.featured);

/** A book's page, as a site path. */
export const bookPath = (book: Pick<Book, "slug">): string =>
  \`/work/\${book.slug}\`;

// A function declaration, like checkBooks: both are called above, while the module is still loading.
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The list as given, or an Error that names the first entry that cannot become a page. The parameter is
 * unknown[] so the check holds for entries the type checker never saw.
 */
export function checkBooks(list: readonly unknown[]): Book[] {
  const firstUse = new Map<string, number>();
  list.forEach((entry, index) => {
    const book = (entry ?? {}) as Partial<Book>;
    const called = isText(book.slug)
      ? book.slug
      : isText(book.title)
        ? book.title
        : "no slug or title";
    const fail = (problem: string): never => {
      throw new Error(
        \`src/lib/books.ts: book \${index + 1} ("\${called}") \${problem}\`,
      );
    };
    if (typeof entry !== "object" || entry === null)
      fail("is not an object. Each book is { slug, title, year, ... }.");
    for (const field of ["slug", "title", "kind", "summary"] as const)
      if (!isText(book[field])) fail(\`is missing "\${field}".\`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(book.slug!))
      fail(
        \`has the slug "\${book.slug}". A slug is the page's URL: use lowercase letters, digits, and hyphens, such as "my-first-book".\`,
      );
    if (!Number.isInteger(book.year))
      fail('is missing "year", a whole number.');
    if (
      !Array.isArray(book.description) ||
      book.description.length === 0 ||
      !book.description.every(isText)
    )
      fail('is missing "description", a list with one string per paragraph.');
    if (!COVER_TONES.includes(book.cover?.tone as CoverTone))
      fail(\`needs "cover.tone" to be one of: \${COVER_TONES.join(", ")}.\`);
    if (!isText(book.cover?.alt))
      fail('is missing "cover.alt", the text that describes the cover.');
    if (book.pages !== undefined && !Number.isInteger(book.pages))
      fail('has "pages" that is not a whole number.');
    const earlier = firstUse.get(book.slug!);
    if (earlier !== undefined)
      fail(
        \`has the same slug as book \${earlier + 1}. Each book needs its own slug, because the slug is its page's URL.\`,
      );
    firstUse.set(book.slug!, index);
  });
  return list as Book[];
}
`;

/** `src/lib/books.test.ts`: the sample data holds, and each kind of bad entry is refused by name. */
export const BOOKS_TEST = `import { describe, expect, it } from "vitest";
import {
  bookPath,
  books,
  checkBooks,
  featuredBooks,
  type Book,
} from "./books.ts";

const valid: Book = {
  slug: "a-test-book",
  title: "A Test Book",
  year: 2024,
  kind: "Novel",
  summary: "One sentence about the book.",
  description: ["A paragraph."],
  cover: { tone: "moss", alt: "Cover of A Test Book." },
};

describe("books", () => {
  it("lists books that all pass the check, some of them featured", () => {
    expect(books.length).toBeGreaterThan(0);
    expect(() => checkBooks(books)).not.toThrow();
    expect(featuredBooks().length).toBeGreaterThan(0);
    expect(featuredBooks().every((book) => book.featured)).toBe(true);
  });

  it("gives each book a page under /work", () => {
    expect(bookPath(valid)).toBe("/work/a-test-book");
  });

  it("accepts a book without the optional fields", () => {
    expect(checkBooks([valid])).toEqual([valid]);
  });

  it.each(["slug", "title", "kind", "summary", "year", "description"] as const)(
    "misuse: a book with no %s fails with its position and name",
    (field) => {
      const broken: Partial<Book> = { ...valid };
      delete broken[field];
      const named = field === "slug" ? "A Test Book" : "a-test-book";
      expect(() => checkBooks([valid, broken])).toThrow(\`book 2 ("\${named}")\`);
      expect(() => checkBooks([broken])).toThrow(\`"\${field}"\`);
    },
  );

  it("misuse: two books with one slug fail, naming both positions", () => {
    const other = { ...valid, title: "Another Book" };
    expect(() => checkBooks([valid, { ...valid, slug: "b" }, other])).toThrow(
      'book 3 ("a-test-book") has the same slug as book 1',
    );
  });

  it.each(["A Test Book", "a_test", "-a", "a/b", "été"])(
    "misuse: the slug %j is refused, because it would not be a clean URL",
    (slug) => {
      expect(() => checkBooks([{ ...valid, slug }])).toThrow(
        "lowercase letters",
      );
    },
  );

  it("misuse: a cover color the component does not draw, or no alt text, is refused", () => {
    expect(() =>
      checkBooks([{ ...valid, cover: { tone: "pink", alt: "Cover." } }]),
    ).toThrow("cover.tone");
    expect(() =>
      checkBooks([{ ...valid, cover: { tone: "moss", alt: " " } }]),
    ).toThrow("cover.alt");
    expect(() => checkBooks([{ ...valid, cover: undefined }])).toThrow(
      "cover.tone",
    );
  });

  it("misuse: an entry that is not an object, or a year typed as text, is refused", () => {
    expect(() => checkBooks([null])).toThrow("book 1");
    expect(() => checkBooks(["a-test-book"])).toThrow("is not an object");
    expect(() => checkBooks([{ ...valid, year: "2024" }])).toThrow('"year"');
    expect(() => checkBooks([{ ...valid, pages: 12.5 }])).toThrow('"pages"');
  });
});
`;

/** The racing project's Markdown collection reader. */
export const PROJECTS_TS = `import { readdir, readFile } from "node:fs/promises";
import { raw, type SafeHtml } from "@bascik/bascik/html";

export interface Project {
  slug: string;
  title: string;
  year: number;
  category: string;
  tags: string[];
  summary: string;
  accent: "amber" | "tide" | "moss" | "rust" | "slate" | "plum";
  featured?: boolean;
  html: SafeHtml;
}

function scalar(value: string | undefined, field: string, file: string): string {
  if (!value?.trim()) throw new Error(\`\${file}: missing "\${field}" in frontmatter.\`);
  return value.trim();
}

function markdownToHtml(markdown: string): SafeHtml {
  const rendered = markdown.trim().split(/\\n\\s*\\n/).map((block) => {
    if (block.startsWith("## ")) return \`<h2>\${block.slice(3)}</h2>\`;
    if (block.startsWith("### ")) return \`<h3>\${block.slice(4)}</h3>\`;
    return \`<p>\${block.replace(/\\n/g, " ")}</p>\`;
  }).join("\\n");
  return raw(rendered);
}

export async function listProjects(): Promise<Project[]> {
  const names = (await readdir("./content/projects")).filter((name) => name.endsWith(".md")).sort();
  const projects: Project[] = [];
  for (const name of names) {
    const file = \`content/projects/\${name}\`;
    const source = await readFile(file, "utf8");
    const match = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(source);
    if (!match) throw new Error(\`\${file} is missing frontmatter\`);
    const fields = new Map<string, string>();
    for (const line of match[1].split("\\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^["']|["']$/g, ""));
    }
    const slug = scalar(fields.get("slug"), "slug", file);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(\`\${file}: invalid slug "\${slug}"\`);
    const year = Number(fields.get("year"));
    if (!Number.isInteger(year)) throw new Error(\`\${file}: "year" must be a whole number\`);
    const category = scalar(fields.get("category"), "category", file);
    const summary = scalar(fields.get("summary"), "summary", file);
    const accentValue = scalar(fields.get("accent"), "accent", file);
    if (!["amber", "tide", "moss", "rust", "slate", "plum"].includes(accentValue))
      throw new Error(\`\${file}: invalid accent "\${accentValue}"\`);
    const tags = (fields.get("tags") || "").split("|").map((tag) => tag.trim()).filter(Boolean);
    if (tags.length === 0) throw new Error(\`\${file}: missing "tags"\`);
    projects.push({
      slug,
      title: scalar(fields.get("title"), "title", file),
      year,
      category,
      tags,
      summary,
      accent: accentValue as Project["accent"],
      featured: fields.get("featured") === "true",
      html: markdownToHtml(match[2]),
    });
  }
  const slugs = new Set<string>();
  for (const project of projects) {
    if (slugs.has(project.slug)) throw new Error(\`duplicate project slug: \${project.slug}\`);
    slugs.add(project.slug);
  }
  return projects.sort((a, b) => b.year - a.year);
}

export const projects = await listProjects();
export const featuredProjects = (): Project[] => projects.filter((project) => project.featured);
export const projectPath = (project: Pick<Project, "slug">): string => \`/work/\${project.slug}\`;
`;

/** Legacy draft removed: */
export const DISABLED_PROJECTS_DRAFT = `import { readdir, readFile } from "node:fs/promises";
import { raw, type SafeHtml } from "@bascik/bascik/html";

export interface Project {
  slug: string;
  title: string;
  year: number;
  category: string;
  tags: string[];
  summary: string;
  accent: "amber" | "tide" | "moss" | "rust" | "slate" | "plum";
  featured?: boolean;
  html: SafeHtml;
}

function scalar(value: string | undefined, field: string, file: string): string {
  if (!value?.trim()) throw new Error(
    \`content/projects/: missing "" in frontmatter.

\
      .replace("\u0004", file)
      .replace("\u0004", field)
      .replace(/[\\u0000-\\u001f\\u007f]/g, "")
  );
  return value.trim();
}

function markdownToHtml(markdown: string): SafeHtml {
  const blocks = markdown.trim().split(/\\n\\s*\\n/);
  const rendered = blocks.map((block) => {
    if (block.startsWith("## "))
      return \`<h2></h2>\`.replace("\u0004", block.slice(3).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    if (block.startsWith("### "))
      return \`<h3></h3>\`.replace("\u0004", block.slice(4).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    return \`<p></p>\`.replace("\u0004", block.replace(/\\n/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  }).join("\\n");
  return raw(rendered);
}

export async function listProjects(): Promise<Project[]> {
  const names = (await readdir("./content/projects")).filter((name) => name.endsWith(".md")).sort();
  const projects: Project[] = [];
  for (const name of names) {
    const file = \`content/projects/\`.replace("\u0004", name);
    const source = await readFile(file, "utf8");
    const match = /^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/.exec(source);
    if (!match) throw new Error(\` is missing frontmatter\`.replace("\u0004", file));
    const fields = new Map<string, string>();
    for (const line of match[1].split("\\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^["']|["']$/g, ""));
    }
    const slug = scalar(fields.get("slug"), "slug", file);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      throw new Error(\`: invalid slug ""\`.replace("\u0004", file).replace("\u0004", slug));
    const year = Number(fields.get("year"));
    if (!Number.isInteger(year)) throw new Error(\`: "year" must be a whole number\`.replace("\u0004", file));
    const category = scalar(fields.get("category"), "category", file);
    const summary = scalar(fields.get("summary"), "summary", file);
    const accentValue = scalar(fields.get("accent"), "accent", file);
    if (!["amber", "tide", "moss", "rust", "slate", "plum"].includes(accentValue))
      throw new Error(\`: invalid accent ""\`.replace("\u0004", file).replace("\u0004", accentValue));
    const tags = (fields.get("tags") || "").split("|").map((tag) => tag.trim()).filter(Boolean);
    if (tags.length === 0) throw new Error(\`: missing "tags"\`.replace("\u0004", file));
    projects.push({
      slug,
      title: scalar(fields.get("title"), "title", file),
      year,
      category,
      tags,
      summary,
      accent: accentValue as Project["accent"],
      featured: fields.get("featured") === "true",
      html: markdownToHtml(match[2]),
    });
  }
  const slugs = new Set<string>();
  for (const project of projects) {
    if (slugs.has(project.slug)) throw new Error(\`duplicate project slug: \`.replace("\u0004", project.slug));
    slugs.add(project.slug);
  }
  return projects.sort((a, b) => b.year - a.year);
}

export const projects = await listProjects();
export const featuredProjects = (): Project[] => projects.filter((project) => project.featured);
export const projectPath = (project: Pick<Project, "slug">): string => \`/work/\`.replace("\u0004", project.slug);
`;

export const PROJECT_MARKDOWN = {
  "porsche-917-endurance-plan": `---
slug: "porsche-917-endurance-plan"
title: "Porsche 917 Endurance Plan"
date: "2026-05-02"
year: 2026
category: "Race Engineering"
tags: "Endurance|Porsche 917|Driver Development"
summary: "A complete endurance program built around the Porsche 917, balancing performance, reliability, and a disciplined pit strategy."
accent: "rust"
featured: "true"
---
## The objective

A focused test and race plan for the Porsche 917 across Daytona and Spa, with the same engineering rhythm used for modern endurance programs.

## The approach

Hurley Haywood's era of preparation sets the standard: consistent driver feedback, measured setup changes, and no wasted run in the program.
`,
  "classic-porsche-restoration": `---
slug: "classic-porsche-restoration"
title: "Classic Porsche Restoration"
date: "2026-03-18"
year: 2026
category: "Restoration"
tags: "Porsche 935|Porsche 962|Workshop"
summary: "Workshop and provenance planning for historic Porsche cars, with period-correct details and a return-to-track build standard."
accent: "amber"
featured: "true"
---
## Restoring purpose

The project covers a Porsche 935 and 962 build program, preserving the details that make each car feel correct in the paddock and competitive on circuit.

## Track readiness

Every subsystem is inspected, documented, and tested for Sebring and Laguna Seca use without losing the car's history.
`,
  "race-photography": `---
slug: "race-photography"
title: "Race Photography"
date: "2025-10-07"
year: 2025
category: "Photography"
tags: "Le Mans|Spa|Race Photography"
summary: "A motorsport image library covering the paddock, pit wall, and decisive moments at Le Mans and Spa."
accent: "tide"
---
## Story in motion

The work follows teams and drivers through setup, start, and sunset, from a quiet garage to the final lap.

## Published work

Images document machinery, people, and atmosphere without staging the race or interrupting the job.
`,
  "jordan-taylor-driver-development": `---
slug: "jordan-taylor-driver-development"
title: "Jordan Taylor Driver Development"
date: "2025-08-14"
year: 2025
category: "Driver Development"
tags: "Jordan Taylor|Porsche 963|Data Coaching"
summary: "A data-led coaching program translating on-track references into repeatable pace for prototype and GT drivers."
accent: "plum"
featured: "true"
---
## Coaching method

The program pairs clear debriefs with stint data, helping drivers build repeatable laps around traffic, tire degradation, and endurance rhythm.

## Modern prototype reference

Porsche 963 sessions use the same measurement discipline that supports Jordan Taylor's factory-level prototype work.
`,
  "ross-bentley-track-program": `---
slug: "ross-bentley-track-program"
title: "Ross Bentley Track Program"
date: "2024-11-22"
year: 2024
category: "Track Programs"
tags: "Ross Bentley|Laguna Seca|Driver Coaching"
summary: "A structured track program inspired by clear fundamentals, calm coaching, and measurable improvement."
accent: "moss"
---
## The framework

Students learn braking references, visual planning, and consistent setup communication through short, specific sessions.

## The circuit

Laguna Seca provides the test: enough elevation, commitment, and technical corners to make progress visible.
`,
  "962-paul-newman-tribute": `---
slug: "962-paul-newman-tribute"
title: "962 Paul Newman Tribute"
date: "2024-06-30"
year: 2024
category: "Program Campaign"
tags: "Paul Newman|Porsche 962|Daytona"
summary: "A concise campaign and track program celebrating Paul Newman's competition spirit through the Porsche 962 era."
accent: "slate"
---
## A measured tribute

The program connects Paul Newman with the engineering and endurance discipline of Porsche 962 competition at Daytona.

## Community focus

Track sessions, paddock stories, and historical context bring the car's racing history to a new audience.
`,
} as const;

/** `src/lib/projects.test.ts`: checks the reader's frontmatter contract. */
export const PROJECTS_TEST = `import { describe, expect, it } from "vitest";
import { projectPath, projects, featuredProjects } from "./projects.ts";

describe("projects", () => {
  it("loads a racing Markdown collection with unique slugs", () => {
    expect(projects.length).toBeGreaterThanOrEqual(5);
    expect(new Set(projects.map((project) => project.slug)).size).toBe(projects.length);
    expect(featuredProjects().length).toBeGreaterThan(0);
  });

  it("gives each project a valid work route", () => {
    for (const project of projects) {
      expect(project.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(project.title.length).toBeGreaterThan(0);
      expect(project.summary.length).toBeGreaterThanOrEqual(50);
      expect(project.tags.length).toBeGreaterThan(0);
      expect(projectPath(project)).toBe(\`/work/\${project.slug}\`);
    }
  });
});
`;

/** `src/lib/seo.ts`: each page's title, description, canonical URL, and Open Graph tags. */
export const SEO_TS = `// The head tags each page needs: title, description, canonical URL, and Open Graph tags. A page calls it from
// a build script in its <head>:
//
//   <script data-bascik-build type="text/typescript">
//     import { seo } from "@/lib/seo.ts";
//     export default () => seo({ title: "About", description: "Who I am and what I write." });
//   </script>
//
// The domain comes from BASCIK_SITE_URL (.env or the host's settings), never from this file. html escapes each
// value for where it lands, so a title with quotes or an ampersand is safe.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { site } from "./site.ts";

export interface SeoOptions {
  /** The page's own title. The site's name is added after it. */
  title: string;
  /** One or two sentences for search results. */
  description: string;
  /** "article" on a project page, otherwise "website". */
  type?: "website" | "article";
  /** Keep the page out of search results, as the 404 page does. */
  noindex?: boolean;
}

/** The absolute URL of the page being built, or undefined when the site URL is not set (as in dev). */
export function pageUrl(): string | undefined {
  const origin = process.env.BASCIK_SITE_URL?.replace(/\\/+$/, "");
  if (!origin) return undefined;
  const base = (process.env.BASCIK_BASE || "/").replace(/\\/$/, "");
  return \`\${origin}\${base}\${process.env.BASCIK_PAGE_PATH || "/"}\`;
}

export function seo(options: SeoOptions): SafeHtml {
  const title = \`\${options.title} - \${site.name}\`;
  // A canonical URL must be absolute, so it is written only when the site URL is known.
  const url = options.noindex ? undefined : pageUrl();
  return html\`<title>\${title}</title>
    <meta name="description" content="\${options.description}" />
    \${options.noindex ? html\`<meta name="robots" content="noindex" />\` : ""}
    \${url ? html\`<link rel="canonical" href="\${url}" />\` : ""}
    <meta property="og:type" content="\${options.type ?? "website"}" />
    <meta property="og:title" content="\${title}" />
    <meta property="og:description" content="\${options.description}" />
    \${url ? html\`<meta property="og:url" content="\${url}" />\` : ""}
    <meta property="og:site_name" content="\${site.name}" />
    <meta name="twitter:card" content="summary" />\`;
}
`;

/** `src/lib/seo.test.ts`. */
export const SEO_TEST = `import { afterEach, describe, expect, it, vi } from "vitest";
import { pageUrl, seo } from "./seo.ts";
import { site } from "./site.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("seo", () => {
  it("writes absolute canonical and Open Graph URLs from the site URL and the page path", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com/");
    vi.stubEnv("BASCIK_BASE", "/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/work/a-test-book");
    expect(pageUrl()).toBe("https://example.com/work/a-test-book");
    const tags = String(
      seo({ title: "A Test Book", description: "About it." }),
    );
    expect(tags).toContain(
      '<link rel="canonical" href="https://example.com/work/a-test-book" />',
    );
    expect(tags).toContain(
      '<meta property="og:url" content="https://example.com/work/a-test-book" />',
    );
    expect(tags).toContain('<meta property="og:type" content="website" />');
  });

  it("keeps the base path of a site served from a subfolder", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    vi.stubEnv("BASCIK_BASE", "/books/");
    vi.stubEnv("BASCIK_PAGE_PATH", "/about");
    expect(pageUrl()).toBe("https://example.com/books/about");
  });

  it("leaves the canonical and og:url out when the site URL is not set, as in dev", () => {
    vi.stubEnv("BASCIK_SITE_URL", "");
    const tags = String(seo({ title: "About", description: "About me." }));
    expect(pageUrl()).toBeUndefined();
    expect(tags).not.toContain("canonical");
    expect(tags).not.toContain("og:url");
    expect(tags).toContain("<title>About - ");
  });

  it("ends each title with the site's name and marks a project page", () => {
    const tags = String(
      seo({ title: "Porsche 962 Endurance", description: "About it.", type: "article" }),
    );
    expect(tags).toContain('<meta property="og:type" content="article" />');
    expect(tags).toContain('<meta property="og:site_name" content="');
    expect(site.name.length).toBeGreaterThan(0);
  });

  it("marks a noindex page and gives it no canonical URL", () => {
    vi.stubEnv("BASCIK_SITE_URL", "https://example.com");
    const tags = String(
      seo({
        title: "Page not found",
        description: "Nothing here.",
        noindex: true,
      }),
    );
    expect(tags).toContain('<meta name="robots" content="noindex" />');
    expect(tags).not.toContain("canonical");
  });

  it("misuse: escapes markup and quotes in a title or description", () => {
    const tags = String(
      seo({
        title: '<script>alert("x")</script> & Sons',
        description: 'She said "no" & left <b>',
      }),
    );
    expect(tags).not.toContain("<script>");
    expect(tags).not.toContain("<b>");
    expect(tags).toContain("&lt;script&gt;");
    expect(tags).toContain("&amp; Sons");
    expect(tags).not.toContain('content="She said "no"');
  });
});
`;

/** `src/lib/book-cards.ts`: the grid of cards the home page and the work page share. */
export const BOOK_CARDS_TS = `import { html, type SafeHtml } from "@bascik/bascik/html";
import { bookPath, type Book } from "./books.ts";

/**
 * A grid with one <book-card> per book, its <book-cover> in the card's slot. Bascik expands both tags when the
 * page builds. html escapes each value, so a title with an apostrophe or an ampersand is safe.
 */
export const bookCards = (list: readonly Book[]): SafeHtml =>
  html\`<ul class="book-grid">
    \${list.map((book) => {
      const href = bookPath(book);
      const meta = \`\${book.kind} · \${book.year}\`;
      return html\`<li>
        <book-card
          data-bascik-prop-title="\${book.title}"
          data-bascik-prop-meta="\${meta}"
          data-bascik-prop-summary="\${book.summary}"
          data-bascik-prop-href="\${href}"
        >
          <book-cover
            data-bascik-prop-title="\${book.title}"
            data-bascik-prop-alt="\${book.cover.alt}"
            data-bascik-prop-tone="\${book.cover.tone}"
          />
        </book-card>
      </li>\`;
    })}
  </ul>\`;
`;

/** `src/lib/book-cards.test.ts`. */
export const BOOK_CARDS_TEST = `import { describe, expect, it } from "vitest";
import { bookCards } from "./book-cards.ts";
import { books, type Book } from "./books.ts";

describe("bookCards", () => {
  it("writes one card per book, in order, each linking to the book's page", () => {
    const markup = String(bookCards(books));
    expect(markup.match(/<book-card/g)).toHaveLength(books.length);
    expect(markup.match(/<book-cover/g)).toHaveLength(books.length);
    const links = [...markup.matchAll(/data-bascik-prop-href="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(links).toEqual(books.map((book) => \`/work/\${book.slug}\`));
  });

  it("writes an empty list for no books", () => {
    expect(String(bookCards([]))).not.toContain("<li>");
  });

  it("misuse: escapes markup and quotes in a book's text", () => {
    const book: Book = {
      ...books[0],
      title: '"Quoted" <b>& Sons</b>',
      summary: "<img src=x onerror=alert(1)>",
    };
    const markup = String(bookCards([book]));
    expect(markup).not.toContain("<b>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;b&gt;&amp; Sons&lt;/b&gt;");
    expect(markup).not.toContain('title=""Quoted"');
  });
});
`;
