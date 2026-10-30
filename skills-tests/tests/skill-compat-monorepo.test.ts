// Unit tests for the bascik-compatibility and bascik-config workspace scripts and verify.mjs's external-root linting.
// Real-project runs are in skill-monorepo.integration.test.ts and e2e/skill-compat-lookup.spec.ts.
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseMatrix,
  searchMatrix,
} from "../../skills/bascik-compatibility/scripts/lookup.mjs";
import {
  advice,
  formatFeature,
  queriesFor,
} from "../../skills/bascik-compatibility/scripts/baseline.mjs";
import {
  aliasImports,
  analyzeSites,
  discoverSites,
} from "../../skills/bascik-config/scripts/check-workspace.mjs";
import { externalComponentRoots } from "../../skills/bascik/scripts/verify.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("compatibility lookup", () => {
  const page = `<html><body><nav><table><tr><td>nav table ignored</td></tr></table></nav><main>
    <h2 id="css">CSS Scoping</h2><h3>Selectors</h3>
    <table><thead><tr><th scope="col">Pattern</th><th scope="col">Example</th><th scope="col">Status</th><th scope="col">Notes</th></tr></thead>
    <tbody>
      <tr><td><code>@container</code></td><td><code>@container sidebar (min-width: …) {}</code></td><td class="badge-ok"><span role="img" aria-label="Supported and tested"><svg></svg></span></td><td>Names are scoped &amp; queries updated.</td></tr>
      <tr><td><code>:is()</code> with element names</td><td><code>:is(p, h2) {}</code></td><td><span role="img" aria-label="Intentionally unsupported"></span></td><td>Not converted.</td></tr>
      <tr><td>Attribute selector</td><td><code>[data-foo]</code></td><td><span aria-label="Partially supported"></span></td><td>Leaks.</td></tr>
    </tbody></table>
    <h2>Server &amp; API Features</h2>
    <table><tr><th>Capability</th><th>Status</th><th>Notes</th></tr>
      <tr><td>Middleware chains</td><td>✕</td><td>By design.</td></tr>
      <tr><td>Directive scripts printed by a build script</td><td>🚫</td><td>Removed.</td></tr></table>
  </main></body></html>`;

  it("reads every row in <main> with its heading path, columns, and status", () => {
    const rows = parseMatrix(page);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      section: "CSS Scoping > Selectors",
      status: "✓",
      cells: {
        Pattern: "@container",
        Example: "@container sidebar (min-width: …) {}",
        Notes: "Names are scoped & queries updated.",
      },
    });
    expect(rows.map((row: { status: string }) => row.status)).toEqual([
      "✓",
      "✕",
      "△",
      "✕",
      "✕",
    ]);
    expect(rows[3].section).toBe("Server & API Features");
  });

  it("requires every word and ranks first-column matches first", () => {
    const rows = parseMatrix(page);
    expect(
      searchMatrix(rows, "is element").map(
        (row: { cells: { Pattern: string } }) => row.cells.Pattern,
      ),
    ).toEqual([":is() with element names"]);
    expect(searchMatrix(rows, "container")[0].cells.Pattern).toBe("@container");
    expect(searchMatrix(rows, "scoped", { section: "server" })).toEqual([]);
    expect(searchMatrix(rows, "nothing-like-this")).toEqual([]);
  });
});

describe("baseline", () => {
  it("tries an exact web-features ID before free text", () => {
    expect(queriesFor("popover")).toEqual(["id:popover", "popover"]);
    expect(queriesFor("invoker commands")).toEqual(["invoker commands"]);
  });

  it("formats status, dates, browsers, and advice", () => {
    const text = formatFeature({
      feature_id: "popover",
      name: "Popover",
      baseline: { status: "newly", low_date: "2025-01-27" },
      browser_implementations: {
        chrome: { status: "available", version: "116" },
        safari: { status: "available", version: "17" },
      },
    });
    expect(text).toContain("Popover (popover)");
    expect(text).toContain("Baseline newly available since 2025-01-27");
    expect(text).toContain("Chrome 116");
    expect(text).toContain("Firefox no");
    expect(text).toContain("@supports");
    expect(
      formatFeature({
        feature_id: "x",
        name: "X",
        baseline: { status: "widely", high_date: "2024-01-01" },
      }),
    ).toContain("widely available since 2024-01-01");
    expect(advice("limited")).toMatch(/enhancement/);
    expect(advice(undefined)).toMatch(/No Baseline status/);
  });
});

describe("bascik-compatibility stays in step with the linter", () => {
  it("names every compatibility lint rule in SKILL.md", () => {
    const rules = JSON.parse(
      readFileSync(
        join(repoRoot, "pkg/src/lib/compatibility-rules.json"),
        "utf8",
      ),
    ) as Array<{ id: string }>;
    const skill = readFileSync(
      join(repoRoot, "skills/bascik-compatibility/SKILL.md"),
      "utf8",
    );
    const missing = rules
      .map((rule) => rule.id)
      .filter((id) => !skill.includes(`\`${id}\``));
    expect(
      missing,
      "add each new rule to the lint rule table in skills/bascik-compatibility/SKILL.md",
    ).toEqual([]);
  });
});

describe("verify.mjs external component roots", () => {
  it("selects only roots outside the project", () => {
    const root = resolve("/repo/sites/a");
    const roots = [
      resolve(root, "src/components"),
      resolve(root, "../../shared/components"),
      resolve(root, "..dots/x"),
      resolve("/elsewhere"),
    ];
    expect(externalComponentRoots(root, roots)).toEqual([
      resolve("/repo/shared/components"),
      resolve("/elsewhere"),
    ]);
  });
});

describe("check-workspace", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds alias imports only in build, server, stream, and routes scripts", () => {
    const html = `<script data-bascik-build>import { a } from '@/lib/a.ts'; const b = await import("@/lib/b.ts");</script>
      <script data-bascik-server>import '@/lib/c.ts';</script>
      <script>import { d } from '@/lib/client.ts';</script>`;
    expect(aliasImports(html)).toEqual([
      "@/lib/a.ts",
      "@/lib/b.ts",
      "@/lib/c.ts",
    ]);
  });

  it("discovers sites by config file or Bascik dependency, without descending into them", () => {
    dir = mkdtempSync(join(tmpdir(), "bascik-ws-"));
    const make = (path: string, file: string, content = "") => {
      mkdirSync(join(dir!, path), { recursive: true });
      writeFileSync(join(dir!, path, file), content);
    };
    make("sites/a", "bascik.config.ts");
    make("sites/a/nested", "bascik.config.ts");
    make(
      "apps/web",
      "package.json",
      JSON.stringify({ dependencies: { "@bascik/bascik": "1.0.0" } }),
    );
    make("apps/web/src/pages", "index.html");
    make(
      "apps/api",
      "package.json",
      JSON.stringify({ dependencies: { express: "5" } }),
    );
    make("node_modules/pkg", "bascik.config.ts");
    expect(
      discoverSites(dir).map((site: string) => site.slice(dir!.length + 1)),
    ).toEqual(["apps/web", "sites/a"]);
  });

  it("reports duplicates, nesting, unresolved aliases, unwatched helpers, and version drift", () => {
    const repo = resolve("/repo");
    const shared = resolve(repo, "shared/components");
    const site = (name: string, overrides: Record<string, unknown> = {}) => ({
      dir: resolve(repo, "sites", name),
      componentRoots: [shared, resolve(repo, "sites", name, "src/components")],
      importRoot: resolve(repo, "sites", name, "src"),
      watchPaths: [],
      version: "1.0.0",
      components: [],
      ...overrides,
    });
    const nav = {
      root: shared,
      file: resolve(shared, "site-nav.html"),
      tag: "site-nav",
      imports: ["@/lib/links.ts"],
    };
    const sites = [
      site("a", {
        importRoot: resolve(repo, "shared"),
        components: [
          nav,
          {
            ...nav,
            root: resolve(repo, "sites/a/src/components"),
            file: resolve(repo, "sites/a/src/components/site-nav.html"),
            imports: [],
          },
        ],
      }),
      site("b", {
        components: [nav],
        version: "1.1.0",
        componentRoots: [shared, resolve(shared, "inner")],
      }),
    ];
    const exists = (path: string) =>
      path === resolve(repo, "shared/lib/links.ts");
    const { findings, sharedRoots } = analyzeSites(sites, {
      repoRoot: repo,
      exists,
    });
    const text = findings.map(
      (f: { level: string; site: string; message: string }) =>
        `${f.level} ${f.site} ${f.message}`,
    );
    expect(
      text.some((t: string) =>
        t.startsWith("error sites/a <site-nav> is defined 2 times"),
      ),
    ).toBe(true);
    expect(
      text.some((t: string) =>
        t.startsWith(
          "error sites/b component root shared/components/inner is inside shared/components",
        ),
      ),
    ).toBe(true);
    expect(
      text.some((t: string) =>
        t.startsWith(
          "error sites/b shared/components/site-nav.html imports @/lib/links.ts",
        ),
      ),
    ).toBe(true);
    expect(
      text.some(
        (t: string) =>
          t.startsWith("error sites/a") && t.includes("imports @/lib/links.ts"),
      ),
    ).toBe(false);
    expect(
      text.some((t: string) =>
        t.startsWith("warn sites/a scripts.importRoot shared"),
      ),
    ).toBe(true);
    expect(
      text.some((t: string) =>
        t.startsWith(
          "warn (repository) sites resolve different @bascik/bascik versions",
        ),
      ),
    ).toBe(true);
    expect(
      text.some((t: string) =>
        t.startsWith("info sites/a the first component root is shared"),
      ),
    ).toBe(true);
    expect(sharedRoots).toEqual([
      { root: "shared/components", sites: ["sites/a", "sites/b"] },
      { root: "shared/components/inner", sites: ["sites/b"] },
    ]);
  });

  it("accepts a watch path inside an external import root", () => {
    const repo = resolve("/repo");
    const sites = [
      {
        dir: resolve(repo, "sites/a"),
        componentRoots: [],
        importRoot: resolve(repo, "shared"),
        watchPaths: [resolve(repo, "shared/lib")],
        components: [],
      },
    ];
    expect(analyzeSites(sites, { repoRoot: repo }).findings).toEqual([]);
  });
});
