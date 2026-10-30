/**
 * Every build script example in the docs (docs/content) and the agent skills (skills/**\/*.md) uses the directive
 * the guidance gives it:
 *
 * - `data-bascik-build` runs once per page with that page's context, so it is for output that depends on the page.
 * - `data-bascik-build-once` runs once and every use shares its output, with no page or route context, so it is for
 *   output that is the same everywhere (a copyright year, social links, an inlined logo).
 *
 * The rule, for each `<script>` in a fenced code block:
 *
 * 1. A `data-bascik-build` script passes when it reads page context: it names BASCIK_PAGE_PATH, BASCIK_PAGE_FILE or
 *    BASCIK_ROUTE (the list skills/bascik/scripts/lib/build-scripts.mjs shares with audit-components), or calls a
 *    helper these docs define to read them (PAGE_HELPERS below).
 * 2. Otherwise it passes only when its block shows a reader that it is written in a page, where it runs once for
 *    that page anyway. The marker convention, visible in the code block itself:
 *      - a comment naming a page file, such as `<!-- src/pages/about.html -->` or `// src/pages/blog.html`;
 *      - the whole page: `<!doctype`, `<html`, `<head` or `<body`;
 *      - a comment that says so: `<!-- usage in a page -->`.
 *    A component block (one whose script reads no page context) cannot carry any of these, so it fails: use
 *    `data-bascik-build-once` there.
 * 3. A `data-bascik-build-once` script fails when it reads page context, which is empty there.
 * 4. A script with `src=` is skipped: its body is not in the block.
 *
 * Each failure names file:line and what to do.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pageContextVars } from "../../skills/bascik/scripts/lib/build-scripts.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const ROOTS = ["docs/content", "skills"];

/** Helpers the docs and skills define that read the page's context; a call to one counts as reading it. */
export const PAGE_HELPERS = [
  "canonical", // docs/src/lib/canonical.ts: BASCIK_SOURCE_FILE, BASCIK_PAGE_FILE
  "openGraph", // docs/src/lib/open-graph.ts
  "breadcrumbLd", // docs/src/lib/breadcrumb-ld.ts
  "articleSchema", // docs/src/lib/article-schema.ts
  "pagePath", // how-to/page-aware-scripts.md: reads BASCIK_PAGE_PATH
  "seo", // examples/starter-site/src/lib/seo.ts: defaults its canonical path to the page being built
];
const HELPER_CALL = new RegExp(`\\b(?:${PAGE_HELPERS.join("|")})\\s*\\(`);

export interface ScriptExample {
  file: string;
  line: number;
  directive: "build" | "build-once";
  body: string;
  block: string;
}

const SCRIPT =
  /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi;

/** The build and build-once scripts in one Markdown file's fenced code blocks, with their 1-based lines. */
export function scriptExamples(md: string, file: string): ScriptExample[] {
  const out: ScriptExample[] = [];
  const fence = /^(\s*)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\2\s*$/gm;
  for (const f of md.matchAll(fence)) {
    const block = f[3];
    const blockLine = md.slice(0, f.index).split("\n").length + 1;
    for (const s of block.matchAll(SCRIPT)) {
      const attrs = s[1];
      const once = /(?:^|\s)data-bascik-build-once(?=[\s=/]|$)/i.test(attrs);
      const build = /(?:^|\s)data-bascik-build(?=[\s=/]|$)/i.test(attrs);
      if (!once && !build) continue;
      if (/(?:^|\s)src\s*=/i.test(attrs)) continue;
      out.push({
        file,
        line: blockLine + block.slice(0, s.index).split("\n").length - 1,
        directive: once ? "build-once" : "build",
        body: s[2],
        block,
      });
    }
  }
  return out;
}

const COMMENTS = /<!--([\s\S]*?)-->|\/\*([\s\S]*?)\*\/|(?:^|\s)\/\/([^\n]*)/g;
const comments = (code: string): string[] =>
  [...code.matchAll(COMMENTS)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");

/** True when the block shows it is written in a page (see the marker convention above). */
export function showsPage(block: string): boolean {
  if (/<!doctype\b|<html\b|<head\b|<body\b/i.test(block)) return true;
  return comments(block).some(
    (text) =>
      /(?:^|[\s/(])pages\/[\w./[\]-]*\.html\b/.test(text) ||
      /\bin a page\b/i.test(text),
  );
}

export const readsPageContext = (body: string): boolean =>
  pageContextVars(body).length > 0 || HELPER_CALL.test(body);

/** The problem with one example, or undefined when it follows the guidance. */
export function problemOf(example: ScriptExample): string | undefined {
  const where = `${example.file}:${example.line}`;
  const reads = readsPageContext(example.body);
  if (example.directive === "build-once")
    return reads
      ? `${where}: <script data-bascik-build-once> reads page context, which is empty there. Use data-bascik-build, which runs per page.`
      : undefined;
  if (reads || showsPage(example.block)) return undefined;
  return (
    `${where}: <script data-bascik-build> reads no page context and its block does not show a page. ` +
    `If it belongs in a component or prints the same thing everywhere, use data-bascik-build-once; if it is in a ` +
    `page, start the block with a comment naming the page file (<!-- src/pages/name.html -->).`
  );
}

function markdownFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".md")) files.push(abs);
    }
  };
  for (const root of ROOTS) walk(path.join(REPO, root));
  return files.sort();
}

describe("the classifier (misuse lens)", () => {
  const one = (code: string) => {
    const examples = scriptExamples("```html\n" + code + "\n```\n", "x.md");
    expect(examples).toHaveLength(1);
    return problemOf(examples[0]);
  };

  it("fails a component's data-bascik-build year, and passes it as data-bascik-build-once", () => {
    const year = `export default () => String(new Date().getFullYear());`;
    expect(
      one(
        `<!-- src/components/site-footer/site-footer.html -->\n<footer>\n  <script data-bascik-build>\n    ${year}\n  </script>\n</footer>`,
      ),
    ).toMatch(/^x\.md:4: .*use data-bascik-build-once/);
    expect(
      one(
        `<!-- src/components/site-footer/site-footer.html -->\n<script data-bascik-build-once>${year}</script>`,
      ),
    ).toBeUndefined();
  });

  it("passes a data-bascik-build that reads the page directly or through a known helper", () => {
    expect(
      one(
        `<script data-bascik-build>export default () => process.env.BASCIK_ROUTE;</script>`,
      ),
    ).toBeUndefined();
    expect(
      one(
        `<script data-bascik-build>import { canonical } from "@/lib/canonical.ts"; export default () => canonical();</script>`,
      ),
    ).toBeUndefined();
  });

  it("passes a page-level script only with a visible marker: a page path comment, page markup, or 'in a page'", () => {
    const script = `<script data-bascik-build>export default () => "<p>x</p>";</script>`;
    expect(one(script)).toMatch(/does not show a page/);
    expect(one(`<!-- src/pages/about.html -->\n${script}`)).toBeUndefined();
    expect(one(`<!-- usage in a page -->\n${script}`)).toBeUndefined();
    expect(one(`<body>\n${script}\n</body>`)).toBeUndefined();
    // A component path is not a page, and neither is BASCIK_SOURCE_FILE, which names the component.
    expect(
      one(`<!-- src/components/x-y/x-y.html -->\n${script}`),
    ).toBeDefined();
    expect(
      one(
        `<script data-bascik-build>export default () => process.env.BASCIK_SOURCE_FILE;</script>`,
      ),
    ).toBeDefined();
  });

  it("fails a data-bascik-build-once that reads page context, and skips src= scripts", () => {
    expect(
      one(
        `<script data-bascik-build-once>export default () => process.env.BASCIK_PAGE_PATH;</script>`,
      ),
    ).toMatch(/build-once> reads page context/);
    expect(
      scriptExamples(
        '```html\n<script data-bascik-build src="./nav.ts"></script>\n```\n',
        "x.md",
      ),
    ).toEqual([]);
  });

  it("ends a script where the HTML parser does, even at an end tag with space or attributes", () => {
    const examples = scriptExamples(
      "```html\n<script data-bascik-build>a</script\t\n bar>\n<script data-bascik-build-once>b</SCRIPT >\n```\n",
      "x.md",
    );
    expect(examples.map((e) => [e.directive, e.body])).toEqual([
      ["build", "a"],
      ["build-once", "b"],
    ]);
  });

  it("matches the directive names exactly, never a longer attribute", () => {
    expect(
      scriptExamples(
        "```html\n<script data-bascik-builder>x</script>\n<script data-bascik-build-onces>y</script>\n```\n",
        "x.md",
      ),
    ).toEqual([]);
  });
});

describe("build script examples in docs/content and skills", () => {
  const examples = markdownFiles().flatMap((abs) =>
    scriptExamples(
      readFileSync(abs, "utf8"),
      path.relative(REPO, abs).replace(/\\/g, "/"),
    ),
  );

  it("finds the examples (the scan is not silently empty)", () => {
    expect(
      examples.filter((e) => e.directive === "build").length,
    ).toBeGreaterThan(40);
    expect(
      examples.filter((e) => e.directive === "build-once").length,
    ).toBeGreaterThan(1);
  });

  it("each uses the directive its output calls for", () => {
    const problems = examples
      .map(problemOf)
      .filter((p): p is string => p !== undefined);
    expect(problems).toEqual([]);
  });
});

/*
 * The prose around the examples gives the same guidance. Each rule below is a wrong claim the docs once made, found
 * in review; it scans every sentence outside code blocks in docs/content and skills:
 *
 * A. Pairing `data-bascik-build` with component props. Build scripts never see props (no env var, no argv), so a
 *    per-use script that reads no page context prints the same thing at every use: that is build-once output.
 * B. Saying `data-bascik-build` output in a component skips scoping or expansion. It is scoped like the template,
 *    the same as build-once output.
 * C. Listing the other script directives (build, routes, server, stream) without `data-bascik-build-once`. The
 *    linter, the LSP and the compiler all treat it as one of them.
 * D. Saying `data-bascik-build` generates the pages of a `[slug]` route. That is `data-bascik-routes`.
 * E. A build-script example labeled as a real docs component (docs/src/components/<name>/<name>.html) that imports
 *    an `@/lib` helper the real file does not import, so its label and its job do not match.
 */
const BARE_BUILD = /data-bascik-build(?![-\w])/;

/** `line` rules see a whole line (a directive list or table row); `sentence` rules see one sentence at a time. */
const PROSE_RULES: {
  id: string;
  scope: "line" | "sentence";
  test: (s: string) => boolean;
  fix: string;
}[] = [
  {
    id: "build-with-props",
    scope: "sentence",
    test: (s) =>
      BARE_BUILD.test(s) &&
      (/\b(?:depends?|depending|varies|vary)\b[^.]*\bprops?\b/i.test(s) ||
        /per-component-use/i.test(s)),
    fix: "build scripts cannot read props; data-bascik-build is for output that depends on the page or the route",
  },
  {
    id: "build-unscoped",
    scope: "sentence",
    test: (s) =>
      BARE_BUILD.test(s) &&
      /\b(?:not|never|skips?|bypass\w*)\b[^.]*\b(?:scop\w*|expan\w*)\b|\bunscoped\b/i.test(
        s,
      ),
    fix: "a component's data-bascik-build output is scoped and expanded like its template",
  },
  {
    id: "directive-list-without-build-once",
    scope: "line",
    test: (s) =>
      BARE_BUILD.test(s) &&
      /data-bascik-routes/.test(s) &&
      /data-bascik-server/.test(s) &&
      /data-bascik-stream/.test(s) &&
      !/data-bascik-build-once/.test(s),
    fix: "add data-bascik-build-once to the list of script directives",
  },
  {
    id: "build-generates-routes",
    scope: "sentence",
    test: (s) =>
      BARE_BUILD.test(s) &&
      !/data-bascik-routes/.test(s) &&
      /(?:\[slug\]|parameteri[sz]ed routes?)[^.]*\bgenerates?\b|\bgenerates?\b[^.]*(?:one (?:HTML )?(?:file|page) per|\[slug\])/i.test(
        s,
      ),
    fix: "dynamic route pages come from <script data-bascik-routes> in a [slug].html template",
  },
];

/** Each line outside fenced code blocks, then each of its sentences, with their 1-based lines. */
export function proseSentences(
  md: string,
): { line: number; text: string; scope: "line" | "sentence" }[] {
  const out: { line: number; text: string; scope: "line" | "sentence" }[] = [];
  let fence: string | undefined;
  md.split("\n").forEach((raw, i) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (open) {
      if (!fence) fence = open[1];
      else if (
        raw.trim().startsWith(fence) &&
        raw.trim() === raw.trim().replace(/[^`~]/g, "")
      )
        fence = undefined;
      return;
    }
    if (fence) return;
    out.push({ line: i + 1, text: raw, scope: "line" });
    for (const text of raw.split(/(?<=[.!?])\s+(?=[A-Z`*[(])/))
      out.push({ line: i + 1, text, scope: "sentence" });
  });
  return out;
}

/** The prose problems in one Markdown file, as file:line messages. */
export function proseProblems(md: string, file: string): string[] {
  const seen = new Set<string>();
  for (const { line, text, scope } of proseSentences(md))
    for (const rule of PROSE_RULES)
      if (rule.scope === scope && rule.test(text))
        seen.add(`${file}:${line}: ${rule.id}: ${rule.fix}`);
  return [...seen];
}

const DOCS_COMPONENTS = path.join(REPO, "docs/src/components");

/** Rule E for one example: a real docs component label whose build script imports helpers the real file lacks. */
export function labelProblem(
  example: ScriptExample,
  readComponent: (name: string) => string | undefined,
): string | undefined {
  const label = /src\/components\/([a-z0-9-]+)\/\1\.html/.exec(
    comments(example.block).join("\n"),
  );
  if (!label) return undefined;
  const real = readComponent(label[1]);
  if (real === undefined) return undefined;
  const missing = [
    ...example.body.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*["'](@\/lib\/[^"']+)["']/g,
    ),
  ].flatMap((m) =>
    m[1]
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0])
      .filter((n) => n && !new RegExp(`\\b${n}\\b`).test(real)),
  );
  return missing.length === 0
    ? undefined
    : `${example.file}:${example.line}: labeled src/components/${label[1]}/${label[1]}.html, but the real docs component does not use ${missing.join(", ")}. Label it as a component whose job this is, or show the real script.`;
}

const readDocsComponent = (name: string): string | undefined => {
  try {
    return readFileSync(
      path.join(DOCS_COMPONENTS, name, `${name}.html`),
      "utf8",
    );
  } catch {
    return undefined;
  }
};

describe("the prose rules (misuse lens)", () => {
  const problems = (md: string) => proseProblems(md, "x.md");

  it("A: fails data-bascik-build paired with props, in prose and in a table row", () => {
    expect(
      problems(
        "Use `data-bascik-build` when output depends on the page, the route, or component props.\n",
      ),
    ).toEqual([expect.stringMatching(/^x\.md:1: build-with-props/)]);
    expect(
      problems(
        "| Page-specific or per-component-use HTML | `data-bascik-build` | once per use |\n",
      ),
    ).toHaveLength(1);
    expect(
      problems(
        "Use `data-bascik-build` when output depends on the page or the route.\n",
      ),
    ).toEqual([]);
    // Pointing a reader from build to build-once or a prop is the right advice, not this mistake.
    expect(
      problems(
        "A `data-bascik-build` script reads `BASCIK_ROUTE`. Use `data-bascik-build-once`, or pass the value in as a prop.\n",
      ),
    ).toEqual([]);
  });

  it("A, B, D: judge one sentence at a time, so two true sentences on a line never combine", () => {
    expect(
      problems(
        "Use `data-bascik-build` for page output. A label that depends on props needs a slot.\n",
      ),
    ).toEqual([]);
  });

  it("B: fails a claim that data-bascik-build output skips scoping or expansion", () => {
    expect(
      problems(
        "With `data-bascik-build`, the script would run per page, and its output would not go through that expansion.\n",
      ),
    ).toHaveLength(1);
    expect(
      problems(
        "With `data-bascik-build`, the footer's script would run again for every page that uses it.\n",
      ),
    ).toEqual([]);
  });

  it("C: fails a directive list without build-once, and passes it with build-once", () => {
    const four =
      "Completes `data-bascik-build`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream`.\n";
    expect(problems(four)).toEqual([
      expect.stringMatching(/^x\.md:1: directive-list-without-build-once/),
    ]);
    expect(
      problems(
        four.replace(
          "`data-bascik-routes`",
          "`data-bascik-build-once`, `data-bascik-routes`",
        ),
      ),
    ).toEqual([]);
  });

  it("D: fails data-bascik-build named as the way to generate [slug] pages", () => {
    expect(
      problems(
        "For parameterized routes like `[slug]`, generate one HTML file per value at build time using a `<script data-bascik-build>` block.\n",
      ),
    ).toHaveLength(1);
    expect(
      problems(
        "For parameterized routes like `[slug]`, generate one HTML file per value using `<script data-bascik-routes>`.\n",
      ),
    ).toEqual([]);
    // Saying build output is shared by every generated page is not this mistake.
    expect(
      problems(
        "In a dynamic route template, a `data-bascik-build-once` script runs once and every generated page shares its output, while `data-bascik-build` runs in the context of each route.\n",
      ),
    ).toEqual([]);
    // BASCIK_ROUTE reaching a build script in a [slug].html template is true and stays allowed.
    expect(
      problems(
        "| `BASCIK_ROUTE` | `data-bascik-build` (dynamic routes) | JSON for parameterized page templates like `[slug].html`. |\n",
      ),
    ).toEqual([]);
  });

  it("ignores fenced code", () => {
    expect(
      problems("```html\n<!-- data-bascik-build depends on props -->\n```\n"),
    ).toEqual([]);
  });

  it("E: fails a build example labeled as a real docs component whose helpers the real file does not use", () => {
    const [example] = scriptExamples(
      '```html\n<!-- src/components/docs-pagination/docs-pagination.html -->\n<script data-bascik-build>\n  import { pagePath, siteOrigin } from "@/lib/site.ts";\n  export default () => `<link rel="canonical" href="${siteOrigin()}${pagePath()}">`;\n</script>\n```\n',
      "x.md",
    );
    expect(labelProblem(example, readDocsComponent)).toMatch(
      /^x\.md:3: labeled src\/components\/docs-pagination.*pagePath, siteOrigin/,
    );
    const [real] = scriptExamples(
      '```html\n<!-- src/components/docs-pagination/docs-pagination.html -->\n<script data-bascik-build>\n  import { renderPagination } from "@/lib/render-nav.ts";\n  export default async () => renderPagination();\n</script>\n```\n',
      "x.md",
    );
    expect(labelProblem(real, readDocsComponent)).toBeUndefined();
    // A component the docs site does not have is a hypothetical example, which may do anything.
    const [made] = scriptExamples(
      '```html\n<!-- src/components/canonical-link/canonical-link.html -->\n<script data-bascik-build>\n  import { pagePath } from "@/lib/site.ts";\n  export default () => pagePath();\n</script>\n```\n',
      "x.md",
    );
    expect(labelProblem(made, readDocsComponent)).toBeUndefined();
  });
});

describe("the guidance prose in docs/content and skills", () => {
  const files = markdownFiles().map((abs) => ({
    rel: path.relative(REPO, abs).replace(/\\/g, "/"),
    md: readFileSync(abs, "utf8"),
  }));

  it("states each directive's job the way the guidance does", () => {
    expect(files.flatMap(({ rel, md }) => proseProblems(md, rel))).toEqual([]);
  });

  it("labels build examples only with a docs component that does that job", () => {
    const problems = files
      .flatMap(({ rel, md }) => scriptExamples(md, rel))
      .map((e) => labelProblem(e, readDocsComponent))
      .filter((p): p is string => p !== undefined);
    expect(problems).toEqual([]);
  });
});
