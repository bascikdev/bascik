/**
 * Tests of the `reports` template's own content. The rules every template
 * shares (paths, folders, shared files, building with each adapter) are tested
 * for it by `template registry` in scaffold.test.ts and the matrix in
 * scaffold.integration.test.ts.
 *
 * The second half writes the generated site into a temporary folder and
 * imports its modules, so the loader, the charts and the CSV writer are tested
 * as the code a new project gets, not as text.
 */

import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADAPTERS, GITIGNORE, scaffold, SITE_HEADER_CSS } from "../scaffold.js";
import { templateNamed, TEMPLATES } from "../templates.js";
import { REPORTS_TEMPLATE, siteModule } from "./reports.js";
import { DATA_FILES, DEMO_PERIODS, demoSales } from "./reports/data.js";
import { SKIP_LINK_CSS } from "./reports/derived.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** A site name that would break a page, a script or a string if it were written unescaped. */
const AWKWARD_NAME = `Bascik Example & Track Club <script>alert("x")</script> 'Racing' \\ $&`;
/** A title that would break HTML, SVG or CSV if it were not escaped for each. */
const AWKWARD_TITLE = `Bascik <b>& 63, $& 'n' more`;
const AWKWARD_TITLE_HTML = "Bascik &lt;b&gt;&amp; 63, $&amp; &#39;n&#39; more";

const filesOf = (
  siteName = "My Reports",
  adapter?: (typeof ADAPTERS)[number],
): Map<string, string> =>
  new Map(
    REPORTS_TEMPLATE.files({ siteName, adapter }).map(([path, data]) => [
      path,
      String(data),
    ]),
  );

const file = (path: string, files = filesOf()): string => {
  const text = files.get(path);
  if (text === undefined) throw new Error(`the template has no ${path}`);
  return text;
};

/** Markup on one line with no space next to a tag, so no test depends on how a file is wrapped. */
const flat = (markup: unknown): string =>
  String(markup)
    .replace(/\s+/g, " ")
    .replace(/ ?([<>]) ?/g, (_match, bracket: string) => bracket)
    .trim();

// ─── The template as text ─────────────────────────────────────────────────────

describe("reports template", () => {
  it("inlines global styles and does not animate initial content", () => {
    expect(file("bascik.config.ts")).toContain(
      'inlineStyles: ["src/pages/css/styles.css"]',
    );
    expect(file("src/pages/css/styles.css")).not.toContain("settle-in");
  });

  it("provides an icon-only theme control without a decorative brand square", () => {
    const header = file("src/components/site-header/site-header.html");
    expect(header).toContain('data-testid="site-header-theme"');
    expect(header).not.toContain(".brand::before");
    expect(file("src/components/site-meta/site-meta.html")).toContain(
      "localStorage",
    );
  });
  it("is registered under its name with the documented summary", () => {
    expect(templateNamed("reports")).toBe(REPORTS_TEMPLATE);
    expect(TEMPLATES).toContain(REPORTS_TEMPLATE);
    expect(REPORTS_TEMPLATE.summary).toBe(
      "A reporting site: dated reports from data files, SVG charts, CSV downloads, and print styles",
    );
  });

  it("needs no package beyond the starter's own", () => {
    expect(REPORTS_TEMPLATE.dependencies).toBeUndefined();
    expect(REPORTS_TEMPLATE.devDependencies).toBeUndefined();
    for (const [path, text] of filesOf())
      for (const [, specifier] of text.matchAll(
        /^\s*import [^;]*? from "([^"]+)";/gm,
      ))
        expect(
          /^(\.{1,2}\/|@\/|node:|vitest$|@playwright\/test$|@bascik\/bascik\/(html|config)$)/.test(
            specifier,
          ),
          `${path} imports ${specifier}`,
        ).toBe(true);
  });

  it("writes the home page, the report route, the comparison, the 404, the data, the config and the CSV script", () => {
    const paths = [...filesOf().keys()];
    for (const path of [
      "scripts/seed-database.ts",
      "src/lib/racing-db.ts",
      "data/racing.sql",
      "src/pages/index.html",
      "src/pages/reports/[period].html",
      "src/pages/compare.html",
      "src/pages/404.html",
      "src/pages/css/styles.css",
      "bascik.config.ts",
      "scripts/write-csv.ts",
      "e2e/app.spec.ts",
      "src/lib/site.ts",
      ...DEMO_PERIODS.map((period) => `data/reports/${period}.json`),
    ])
      expect(paths).toContain(path);
  });

  it("seeds racing data through package scripts", () => {
    expect(REPORTS_TEMPLATE.scripts).toEqual({
      "db:seed": "node scripts/seed-database.ts",
      predev: "npm run db:seed",
      prebuild: "npm run db:seed",
      pree2e: "npm run db:seed",
    });
    expect(file("scripts/seed-database.ts")).toContain("DatabaseSync");
    expect(file("src/lib/racing-db.ts")).toContain("node:sqlite");
    expect(file("data/racing.sql")).toContain(
      "CREATE TABLE IF NOT EXISTS racing_reports",
    );
    expect(file("data/racing.sql")).not.toContain("INSERT");
    expect(file("data/racing.sql")).not.toMatch(
      /Porsche|Hurley Haywood|Paul Newman|Jordan Taylor|Ross Bentley|Martini Racing/,
    );
    expect(GITIGNORE).toContain("data/racing.db");
  });

  it("renders reports on Node and Cloudflare and keeps the Netlify variant static", () => {
    for (const component of [
      "report-list",
      "period-comparison",
      "report-summary",
    ]) {
      const path = `src/components/${component}/${component}.html`;
      for (const adapter of [undefined, "cloudflare"] as const)
        expect(file(path, filesOf("My Reports", adapter))).toContain(
          "data-bascik-server",
        );
      expect(file(path, filesOf("My Reports", "netlify"))).toContain(
        "data-bascik-build",
      );
    }
  });

  it("gives every component a test, and every module that builds markup or figures a test", () => {
    const paths = [...filesOf().keys()];
    const components = paths.filter((path) =>
      /^src\/components\/[^/]+\/[^/]+\.html$/.test(path),
    );
    expect(components.length).toBeGreaterThanOrEqual(10);
    for (const component of components)
      expect(paths).toContain(component.replace(/\.html$/, ".test.ts"));
    for (const module of paths.filter(
      (path) =>
        /^src\/lib\/[^/]+\.ts$/.test(path) &&
        !/(\.test|\/site|\/testing)\.ts$/.test(path),
    ))
      expect(paths).toContain(module.replace(/\.ts$/, ".test.ts"));
  });

  it("writes TypeScript only: no .js file and no unmarked script block", () => {
    for (const [path, text] of filesOf()) {
      expect(path).not.toMatch(/\.(js|mjs|cjs)$/);
      if (!path.endsWith(".html")) continue;
      for (const [tag] of text.matchAll(/<script\b[^>]*>/g))
        expect(tag, `${path}: ${tag}`).toContain('type="text/typescript"');
    }
  });

  it("builds every piece of markup with html from @bascik/bascik/html, never with an escaper of its own", () => {
    for (const [path, text] of filesOf()) {
      if (
        !/^src\/(lib|components)\/.*\.ts$/.test(path) ||
        /(\.test|\/testing)\.ts$/.test(path)
      )
        continue;
      expect(text, path).not.toMatch(/&amp;|&lt;|escapeHtml/);
      if (!/<\/?[a-z]+[ >]/.test(text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")))
        continue;
      expect(text, path).toContain('from "@bascik/bascik/html"');
      expect(text, path).not.toContain('.join("")');
    }
  });
});

describe("reports template pages", () => {
  const pages = [
    "src/pages/index.html",
    "src/pages/reports/[period].html",
    "src/pages/compare.html",
    "src/pages/404.html",
  ];

  it.each(pages)(
    '%s has the shared head, header and footer around one <main id="main">',
    (path) => {
      const page = flat(file(path));
      expect(page).toMatch(
        /^<!doctype html><html lang="en"><head><site-meta \/>/,
      );
      expect(page).toContain(
        '<body><site-header /><main id="main" data-testid=',
      );
      expect(page).toContain("</main><site-footer /></body></html>");
      expect(page.split("<main")).toHaveLength(2);
      expect(page).toContain("pageHead({");
    },
  );

  it("has one <h1> per page: written in three pages, and built by the masthead on a report page", () => {
    for (const path of pages.filter((path) => !path.includes("[period]")))
      expect(flat(file(path)).split("<h1>"), path).toHaveLength(2);
    expect(file("src/pages/reports/[period].html")).not.toContain("<h1");
    expect(
      file("src/components/report-masthead/render.ts").split("<h1>"),
    ).toHaveLength(2);
  });

  it("makes a report page a list of component tags fed by the route, with nothing passed down by hand", () => {
    const page = flat(file("src/pages/reports/[period].html"));
    expect(page).toContain(
      "<report-masthead /><report-summary /><report-charts /><report-tables /><report-notes /><report-pager /></main>",
    );
    expect(page).toContain(
      '<script data-bascik-routes type="text/typescript">',
    );
    expect(page).toContain("reportRoutes(await loadReports())");
    expect(page).toContain("params: { period: route.report.period }");
    expect(page).not.toContain("data-bascik-prop-");
  });

  it("keeps the 404 page out of search results", () => {
    expect(file("src/pages/404.html")).toContain("noindex: true");
  });

  it("starts the header with the default template's skip link, hidden by clipping until focused", () => {
    expect(SKIP_LINK_CSS).toMatch(/^\.skip-link \{/);
    expect(SKIP_LINK_CSS).toMatch(
      /\.skip-link:not\(:focus\) \{[^}]*clip-path: inset\(50%\);[^}]*\}\n$/,
    );
    expect(SKIP_LINK_CSS).not.toContain("header {");
    expect(SITE_HEADER_CSS.startsWith(SKIP_LINK_CSS)).toBe(true);
    const header = file("src/components/site-header/site-header.html");
    expect(header).toContain(SKIP_LINK_CSS);
    expect(flat(header)).toContain(
      '<header data-testid="site-header"><a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>',
    );
  });

  it("declares the tokens the borrowed skip link styles read", () => {
    const styles = file("src/pages/css/styles.css");
    for (const [, token] of SKIP_LINK_CSS.matchAll(/var\((--[a-z-]+)\)/g))
      expect(styles).toMatch(new RegExp(`^\\s*${token}:`, "m"));
  });

  it("takes the shared head tags from the default template, without its fixed description", () => {
    const meta = file("src/components/site-meta/site-meta.html");
    expect(meta).toContain('charset="UTF-8"');
    expect(meta).toContain('href="/assets/favicon.svg"');
    expect(meta).not.toContain('href="/css/styles.css"');
    expect(meta).not.toContain('name="description"');
  });

  it("puts a data-testid on every component root and interactive part", () => {
    for (const [path, text] of filesOf()) {
      const component = /^src\/components\/([^/]+)\/\1\.html$/.exec(path)?.[1];
      if (!component || component === "site-meta") continue;
      expect(text, path).toContain(`data-testid="${component}"`);
      for (const [tag] of text.matchAll(/<(button|a|nav|form|input)\b[^>]*>/g))
        expect(tag, path).toMatch(
          new RegExp(`data-testid="${component}(-[a-z-]+)?"`),
        );
    }
  });

  it("has a print stylesheet that sets the page, keeps figures and rows whole, and prints charts without color", () => {
    const styles = file("src/pages/css/styles.css");
    expect(styles).toMatch(/@page \{\s*margin:/);
    const print = styles.slice(styles.indexOf("@media print"));
    expect(print).toMatch(/figure,\s*tr,[^{]*\{\s*break-inside: avoid;/);
    expect(print).toMatch(/thead \{\s*display: table-header-group;/);
    expect(print).toMatch(
      /a\[href\^="http"\][^{]*::after \{\s*content: " \(" attr\(href\) "\)"/,
    );
    expect(print).toMatch(/\.chart-bar \{\s*fill: #222;/);
    expect(print).toMatch(/\.chart-bar-muted \{[^}]*stroke: #222;/);
    for (const component of ["site-header", "report-actions", "report-pager"])
      expect(
        file(`src/components/${component}/${component}.html`),
        component,
      ).toMatch(/@media print \{[^}]*display: none;/);
  });

  it("has a print button that is a real button, hidden until its script runs", () => {
    const actions = flat(
      file("src/components/report-actions/report-actions.html"),
    );
    expect(actions).toMatch(
      /<button id="print" type="button" class="button" data-testid="report-actions-print" hidden>Print or save as PDF<\/button>/,
    );
    expect(actions).toContain("window.print()");
    expect(actions).toMatch(
      /<a class="button" data-bascik-attr-href="csv" download data-testid="report-actions-csv">/,
    );
  });
});

describe("reports template build wiring", () => {
  it("writes the CSV files into the build output from a post-phase exec script", () => {
    const config = file("bascik.config.ts");
    expect(config).toMatch(
      /script: "scripts\/write-csv\.ts",\s*phase: "post",\s*watch: \["data\/reports\/", "src\/lib\/"\]/,
    );
    const script = file("scripts/write-csv.ts");
    expect(script).toContain('process.env.BASCIK_OUT_DIR ?? "dist"');
    expect(script).toContain('join(outDir, "reports")');
    expect(script).not.toMatch(/["'`]src\/pages/);
  });

  it("watches the data folder and keeps the two components that list it out of the build script cache", () => {
    const netlify = filesOf("My Reports", "netlify");
    const config = file("bascik.config.ts", netlify);
    expect(config).toContain('watchPaths: ["data/reports/", "src/lib/"]');
    for (const component of ["report-list", "period-comparison"]) {
      expect(config).toContain(`"src/components/${component}/**"`);
      expect(
        file(`src/components/${component}/${component}.html`, netlify),
      ).toContain("await loadReports()");
      expect(file("bascik.config.ts")).not.toContain(
        `"src/components/${component}/**"`,
      );
    }
    expect(config).not.toContain("siteUrl");
  });

  it("formats with a fixed locale and currency, and never makes a Date", () => {
    const format = file("src/lib/format.ts");
    expect(format).toContain('export const LOCALE = "en-US";');
    expect(format).toContain('export const CURRENCY = "USD";');
    for (const [path, text] of filesOf())
      if (/^(src|scripts)\//.test(path) && !path.endsWith(".test.ts"))
        expect(text, path).not.toMatch(
          /new Date|Date\.now|toLocale|DateTimeFormat|NumberFormat\(\)/,
        );
  });

  it("covers the list, a report, the comparison, a CSV download, print styles and the 404 in the Playwright spec", () => {
    const spec = file("e2e/app.spec.ts");
    for (const part of [
      'page.goto("/")',
      'page.goto("/reports/2026-08")',
      'page.goto("/compare")',
      'page.waitForEvent("download")',
      "period,title,author,format,channel,units,revenue",
      'page.emulateMedia({ media: "print" })',
      "toBe(404)",
      'getByRole("figure")',
      "report-pager-previous",
    ])
      expect(spec).toContain(part);
    expect(spec).not.toMatch(/\.nth\(|locator\("\.\.|bascik__/);
  });
});

describe("reports template site name", () => {
  it("writes the name once, as a JSON string in src/lib/site.ts, and into no page", () => {
    const files = filesOf(AWKWARD_NAME);
    const site = file("src/lib/site.ts", files);
    const literal = /export const siteName: string = (".*");\n/.exec(site)?.[1];
    expect(JSON.parse(literal ?? "null")).toBe(AWKWARD_NAME);
    for (const [path, text] of files)
      if (path !== "src/lib/site.ts") {
        expect(text, path).not.toContain("Porsche");
        expect(text, path).not.toContain("alert(");
      }
  });

  it("changes only src/lib/site.ts with the name", () => {
    const one = filesOf("One");
    const two = filesOf("Two");
    for (const [path, text] of one)
      if (path !== "src/lib/site.ts") expect(two.get(path), path).toBe(text);
    expect(siteModule("One")).not.toBe(siteModule("Two"));
  });
});

describe("reports template demo data", () => {
  it("has four consecutive months of race cars and drivers", () => {
    expect(DEMO_PERIODS).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(DATA_FILES.map(([path]) => path)).toEqual(
      DEMO_PERIODS.map((period) => `data/reports/${period}.json`),
    );
  });

  it("writes each file as JSON with one sale per line, in whole cents", () => {
    for (const [path, text] of DATA_FILES) {
      const data = JSON.parse(text) as {
        period: string;
        notes: string[];
        sales: Record<string, unknown>[];
      };
      expect(path).toBe(`data/reports/${data.period}.json`);
      expect(data.notes.length).toBeGreaterThan(0);
      expect(data.sales).toEqual(demoSales(data.period));
      expect(data.sales.length).toBeGreaterThan(20);
      expect(
        text.split("\n").filter((line) => line.includes('"title"')),
      ).toHaveLength(data.sales.length);
      for (const sale of data.sales) {
        expect(
          Number.isSafeInteger(sale.units) && (sale.units as number) > 0,
        ).toBe(true);
        expect(Number.isSafeInteger(sale.revenueCents)).toBe(true);
      }
    }
  });

  it("shows a quiet channel, a new title and a title that needs escaping", () => {
    const channels = (period: string): Set<string> =>
      new Set(demoSales(period).map((sale) => sale.channel));
    expect(channels("2026-07")).toContain("Daytona");
    expect(channels("2026-08")).not.toContain("Spa");
    const titles = (period: string): string[] =>
      demoSales(period).map((sale) => sale.title);
    expect(titles("2026-08")).not.toContain("Bascik Prototype 63");
    expect(titles("2026-09")).toContain("Bascik Prototype 63");
    expect(titles("2026-07")).toContain("Bascik Prototype 17 & Track Club");
    expect(
      [...DATA_FILES.map(([, data]) => data), file("data/racing.sql")].join(
        "\n",
      ),
    ).not.toMatch(
      /Porsche|Hurley Haywood|Paul Newman|Jordan Taylor|Ross Bentley|Martini Racing/,
    );
  });
});

it("renders the Cloudflare bundle using a local D1 binding, without a local SQLite file", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "bascik-reports-d1-")),
  );
  try {
    const root = join(parent, "reports-worker");
    await scaffold("reports-worker", parent, {
      template: REPORTS_TEMPLATE,
      adapter: "cloudflare",
    });
    const scope = join(root, "node_modules", "@bascik");
    await mkdir(scope, { recursive: true });
    await symlink(join(REPO_ROOT, "pkg"), join(scope, "bascik"), "dir");
    await symlink(
      join(REPO_ROOT, "adapters/cloudflare"),
      join(scope, "adapter-cloudflare"),
      "dir",
    );
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "pkg/bin/bascik.js"),
        "--build",
        "--target",
        "cloudflare",
      ],
      {
        cwd: root,
        env: { ...process.env, BASCIK_SITE_URL: "https://example.com" },
      },
    );
    const dir = join(root, "dist/.bascik/cloudflare");
    const { compatibility_date, compatibility_flags, assets } = JSON.parse(
      await readFile(join(dir, "wrangler.jsonc"), "utf8"),
    );
    const snapshot = execFileSync(
      process.execPath,
      ["scripts/seed-database.ts", "--sql"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    // Test-only bootstrap. The generated worker itself contains no setup route.
    const setup = join(dir, "local-test.js");
    await writeFile(
      setup,
      `import worker from "./worker.js";
      export default {
        async fetch(request, env, ctx) {
          if (new URL(request.url).pathname === "/__test_setup" && request.method === "POST") {
            const statements = await request.json();
            await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
            return new Response(null, { status: 204 });
          }
          return worker.fetch(request, env, ctx);
        },
      };`,
    );
    const { Miniflare } = await import("miniflare");
    const worker = new Miniflare({
      modules: true,
      modulesRoot: dir,
      modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
      scriptPath: setup,
      cf: false,
      compatibilityDate: compatibility_date,
      compatibilityFlags: compatibility_flags,
      d1Databases: { DB: "reports-local" },
      assets: {
        directory: join(dir, "public"),
        binding: "ASSETS",
        routerConfig: {
          has_user_worker: true,
          invoke_user_worker_ahead_of_assets: false,
          static_routing: {
            user_worker: [...assets.run_worker_first, "/__test_setup"],
          },
        },
      },
    });
    try {
      const url = await worker.ready;
      const request = (path: string, init?: RequestInit) =>
        fetch(new URL(path, url), {
          ...init,
          signal: AbortSignal.timeout(10_000),
        });
      const seed = await request("/__test_setup", {
        method: "POST",
        body: JSON.stringify([
          ...snapshot
            .trim()
            .split(/;\n|;$/)
            .filter((sql) => sql.trim()),
          `UPDATE racing_reports SET payload = json_set(payload, '$.notes[0]', 'D1-only note') WHERE period = '2026-08'`,
        ]),
      });
      expect(seed.status).toBe(204);
      for (const [path, content] of [
        ["/", "October 2026"],
        ["/compare", "All periods together"],
        ["/reports/2026-08", "D1-only note"],
      ]) {
        const response = await request(path);
        expect(response.status, path).toBe(200);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(await response.text()).toContain(content);
      }
      const csv = await request("/reports/2026-08.csv");
      expect(csv.status).toBe(200);
      expect(await csv.text()).toContain(
        "period,title,author,format,channel,units,revenue",
      );
      expect((await request("/reports/1900-01")).status).toBe(404);
    } finally {
      await worker.dispose();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

// ─── The generated modules, run ───────────────────────────────────────────────

interface Sale {
  title: string;
  author: string;
  format: string;
  channel: string;
  units: number;
  revenueCents: number;
}
interface Report {
  period: string;
  notes: string[];
  sales: Sale[];
}
interface ReportRoute {
  report: Report;
  previous: Report | null;
}
interface Site {
  reports: {
    loadReports(dir?: string): Promise<Report[]>;
    parseReport(file: string, text: string): Report;
    reportRoutes(reports: Report[]): ReportRoute[];
    change(current: number, previous: number | null): { kind: string };
    totals(sales: Sale[]): { units: number; revenueCents: number };
    groupBy(sales: Sale[], key: string): { revenueCents: number }[];
  };
  csv: {
    csvField(value: string | number): string;
    reportsCsv(reports: Report[]): string;
  };
  charts: {
    barChart(label: string, items: object[]): unknown;
    columnChart(label: string, items: object[]): unknown;
  };
  seo: { pageHead(page: { title: string; description: string }): unknown };
  render: Record<string, (...args: never[]) => unknown>;
}

describe("reports template, generated site", () => {
  let root: string;
  let site: Site;
  let dataDir: string;
  let counter = 0;

  /** A fresh data folder holding the given files. */
  const dataFolder = async (
    files: Record<string, unknown>,
  ): Promise<string> => {
    const dir = join(dataDir, String(++counter));
    await mkdir(dir, { recursive: true });
    for (const [name, data] of Object.entries(files))
      await writeFile(
        join(dir, name),
        typeof data === "string" ? data : JSON.stringify(data),
      );
    return dir;
  };

  const sale = (fields: Partial<Sale> = {}): Sale => ({
    title: "Bascik Touring 11",
    author: "Bascik Racing",
    format: "GTP",
    channel: "Sebring",
    units: 2,
    revenueCents: 3400,
    ...fields,
  });
  const report = (period: string, sales: Sale[] = [sale()]): Report => ({
    period,
    notes: [],
    sales,
  });

  /** Everything a report page and the two list pages render for these reports. */
  const renderAll = (reports: Report[]): string => {
    const {
      reportList,
      comparison,
      masthead,
      summary,
      charts,
      tables,
      notes,
      pager,
    } = site.render as Record<string, (...args: unknown[]) => unknown>;
    return flat(
      [
        reportList(reports),
        comparison(reports),
        ...site.reports
          .reportRoutes(reports)
          .flatMap((route) => [
            masthead(route),
            summary(route),
            charts(route),
            tables(route),
            notes(route.report, undefined),
            pager(route),
          ]),
      ]
        .map(String)
        .join("\n"),
    );
  };

  beforeAll(async () => {
    // realpath: macOS's temp folder is a symlink, and the modules must resolve @bascik/bascik from where they are.
    root = await realpath(await mkdtemp(join(tmpdir(), "bascik-reports-")));
    dataDir = join(root, "test-data");
    for (const [path, data] of REPORTS_TEMPLATE.files({
      siteName: AWKWARD_NAME,
    })) {
      const target = join(root, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    }
    await mkdir(join(root, "node_modules", "@bascik"), { recursive: true });
    await symlink(
      join(REPO_ROOT, "pkg"),
      join(root, "node_modules", "@bascik", "bascik"),
      "dir",
    );
    const load = async <Module>(path: string): Promise<Module> =>
      (await import(
        /* @vite-ignore */ pathToFileURL(join(root, path)).href
      )) as Module;
    const component = (name: string): Promise<object> =>
      load<object>(`src/components/${name}/render.ts`);
    site = {
      reports: await load<Site["reports"]>("src/lib/reports.ts"),
      csv: await load<Site["csv"]>("src/lib/csv.ts"),
      charts: await load<Site["charts"]>("src/lib/charts.ts"),
      seo: await load<Site["seo"]>("src/lib/seo.ts"),
      render: Object.assign(
        {},
        ...(await Promise.all(
          [
            "report-list",
            "period-comparison",
            "report-masthead",
            "report-summary",
            "report-charts",
            "report-tables",
            "report-notes",
            "report-pager",
          ].map(component),
        )),
      ),
    };
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("loads the demo data: four periods, oldest first, whose groupings all add up to the same totals", async () => {
    const reports = await site.reports.loadReports(join(root, "data/reports"));
    expect(reports.map(({ period }) => period)).toEqual([...DEMO_PERIODS]);
    for (const { period, sales } of reports) {
      const total = site.reports.totals(sales);
      expect(total.revenueCents).toBe(
        demoSales(period).reduce((sum, line) => sum + line.revenueCents, 0),
      );
      for (const key of ["title", "author", "format", "channel"])
        expect(
          site.reports
            .groupBy(sales, key)
            .reduce((sum, group) => sum + group.revenueCents, 0),
          `${period} by ${key}`,
        ).toBe(total.revenueCents);
    }
  });

  it("uses the same fixture for SQLite and D1, and binds the requested period", async () => {
    const seed = "scripts/seed-database.ts";
    execFileSync(process.execPath, [seed], { cwd: root });
    const sql = execFileSync(process.execPath, [seed, "--sql"], {
      cwd: root,
      encoding: "utf8",
    });
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(sql);
      const bindings: unknown[][] = [];
      const platform = {
        name: "cloudflare" as const,
        env: {
          DB: {
            prepare: (query: string) => ({
              bind: (...args: (string | number)[]) => ({
                all: async () => {
                  bindings.push(args);
                  expect(query).toMatch(/^\s*(SELECT|WITH)\b/i);
                  return { results: db.prepare(query).all(...args) };
                },
              }),
            }),
          },
        },
      };
      const { readReports } = await import(
        /* @vite-ignore */ pathToFileURL(join(root, "src/lib/racing-db.ts"))
          .href
      );
      const fixture = await site.reports.loadReports(
        join(root, "data/reports"),
      );
      expect(
        await readReports({}, undefined, join(root, "data/racing.db")),
      ).toEqual(fixture);
      expect(await readReports({ platform })).toEqual(fixture);
      expect(await readReports({ platform }, "2026-08")).toEqual(
        fixture.slice(0, 3),
      );
      expect(bindings.at(-1)).toEqual(["2026-08", 12, "2026-08"]);
      await expect(
        readReports({ platform: { name: "cloudflare", env: {} } }),
      ).rejects.toThrow(/DB/);
    } finally {
      db.close();
    }
  });

  it("renders the demo data with no NaN, Infinity or undefined, and each table total equal to the headline figure", async () => {
    const reports = await site.reports.loadReports(join(root, "data/reports"));
    const pages = renderAll(reports);
    expect(pages).not.toMatch(/NaN|Infinity|undefined/);
    const { tables, summary } = site.render as Record<
      string,
      (route: ReportRoute) => unknown
    >;
    for (const route of site.reports.reportRoutes(reports)) {
      const money = /<dd class="figure-value">(\$[\d,.]+)<\/dd>/.exec(
        flat(summary(route)),
      )?.[1];
      expect(money).toMatch(/^\$[\d,]+\.\d{2}$/);
      const totals = flat(tables(route)).match(/<tfoot>.*?<\/tfoot>/g) ?? [];
      expect(totals).toHaveLength(3);
      for (const total of totals) expect(total).toContain(`>${money}<`);
    }
  });

  it.each([
    [
      "a missing field",
      { sales: [{ ...sale(), author: undefined }] },
      "sales[0].author must be text (got nothing)",
    ],
    [
      "a non-numeric amount",
      { sales: [{ ...sale(), revenueCents: "34.00" }] },
      'sales[0].revenueCents must be a whole number, 0 or more, in cents (1250 for $12.50) (got "34.00")',
    ],
    [
      "a negative amount",
      { sales: [sale(), { ...sale(), revenueCents: -1 }] },
      "sales[1].revenueCents must be a whole number, 0 or more",
    ],
    [
      "a fractional amount",
      { sales: [{ ...sale(), revenueCents: 12.5 }] },
      "(got 12.5)",
    ],
    [
      "negative units",
      { sales: [{ ...sale(), units: -3 }] },
      "sales[0].units must be a whole number, 0 or more (got -3)",
    ],
    [
      "a malformed period",
      { period: "2026-7", sales: [] },
      '"period" must be a month written as YYYY-MM, such as "2026-07" (got "2026-7")',
    ],
    [
      "a month that does not exist",
      { period: "2026-13", sales: [] },
      '(got "2026-13")',
    ],
    ["no period", { period: undefined, sales: [] }, "(got nothing)"],
    ["no sales list", { sales: undefined }, '"sales" must be a list'],
  ])(
    "misuse: a data file with %s fails the load with an error naming the file",
    async (_case, fields, problem) => {
      const dir = await dataFolder({
        "2026-07.json": report("2026-07"),
        "broken.json": { period: "2026-08", notes: [], ...fields },
      });
      const error = await site.reports.loadReports(dir).then(
        () => undefined,
        (reason: Error) => reason,
      );
      expect(error?.message.startsWith(`${dir}/broken.json: `)).toBe(true);
      expect(error?.message).toContain(problem);
    },
  );

  it("misuse: a data file that is not JSON fails the load with an error naming the file", async () => {
    const dir = await dataFolder({ "typo.json": '{ "period": "2026-07", }' });
    await expect(site.reports.loadReports(dir)).rejects.toThrow(
      `${dir}/typo.json: is not valid JSON`,
    );
  });

  it("misuse: two files for one period fail the load with an error naming both", async () => {
    const dir = await dataFolder({
      "2026-07.json": report("2026-07"),
      "july-corrected.json": report("2026-07"),
    });
    await expect(site.reports.loadReports(dir)).rejects.toThrow(
      `${dir}/july-corrected.json: period 2026-07 is already in ${dir}/2026-07.json. Keep one file per period.`,
    );
  });

  it.each([
    ["an empty period", () => [report("2026-07"), report("2026-08", [])]],
    ["only an empty period", () => [report("2026-07", [])]],
    [
      "a single data point",
      () => [report("2026-07", [sale({ units: 1, revenueCents: 1 })])],
    ],
    [
      "all-zero values",
      () => [
        report("2026-07", [
          sale({ units: 0, revenueCents: 0 }),
          sale({ title: "Other", units: 0, revenueCents: 0 }),
        ]),
        report("2026-08", [sale({ units: 0, revenueCents: 0 })]),
      ],
    ],
    [
      "a zero previous period",
      () => [report("2026-07", []), report("2026-08")],
    ],
    [
      "a zero previous period after a real one",
      () => [report("2026-06"), report("2026-07", []), report("2026-08")],
    ],
    ["no reports at all", () => []],
  ])("renders %s with no NaN, Infinity or undefined", async (_case, make) => {
    const reports = make();
    const dir = await dataFolder(
      Object.fromEntries(reports.map((r) => [`${r.period}.json`, r])),
    );
    const loaded = await site.reports.loadReports(dir);
    expect(loaded).toEqual(reports);
    const pages = renderAll(loaded);
    expect(pages).not.toMatch(/NaN|Infinity|undefined/);
    for (const [, d] of pages.matchAll(/<path[^>]* d="([^"]*)"/g))
      expect(d).toMatch(/^M[\d.]+,[\d.]+[hv]/);
    expect(site.csv.reportsCsv(loaded)).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('says "n/a" for a first report and "New" after a zero period, never a percentage of zero', () => {
    expect(site.reports.change(100, null)).toEqual({ kind: "none" });
    expect(site.reports.change(100, 0)).toEqual({ kind: "new" });
    expect(site.reports.change(0, 0)).toEqual({ kind: "same" });
    const pages = renderAll([report("2026-07", []), report("2026-08")]);
    expect(pages).toContain("n/a: first report");
    expect(pages).toContain("New: nothing in July 2026");
    expect(pages).toContain('<td class="num">n/a</td>');
  });

  it("draws a chart with one bar, with no bars, and with nothing, as valid SVG", () => {
    const item = { label: "Vintage", value: 5, valueLabel: "$5.00" };
    for (const chart of [site.charts.barChart, site.charts.columnChart]) {
      for (const items of [[item], [{ ...item, value: 0 }], []]) {
        const svg = flat(chart("Revenue", items));
        expect(svg).toMatch(
          /^<svg class="chart" viewBox="0 0 640 \d+" role="img" aria-label="Revenue[^"]*">/,
        );
        expect(svg).toMatch(/<\/svg>$/);
        expect(svg).not.toMatch(/NaN|Infinity|undefined/);
        expect(svg.split("<path")).toHaveLength(items[0]?.value ? 2 : 1);
      }
      expect(flat(chart("Revenue", []))).toContain(">No data</text>");
    }
  });

  it("quotes CSV fields that have a comma, a quote or a line break", () => {
    const { csvField } = site.csv;
    expect(csvField("Bascik Touring 11")).toBe("Bascik Touring 11");
    expect(csvField("Bascik GT 35 Long Tail")).toBe("Bascik GT 35 Long Tail");
    expect(csvField('The "Big" One')).toBe('"The ""Big"" One"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("two\r\nlines")).toBe('"two\r\nlines"');
    expect(csvField(1250)).toBe("1250");
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)"])(
    "neutralizes the CSV value %j so a spreadsheet does not run it as a formula",
    (value) => {
      expect(site.csv.csvField(value)).toBe(`'${value}`);
    },
  );

  it("neutralizes and quotes a formula that also needs quoting, in a whole file", () => {
    const formula = '=HYPERLINK("http://example.com","Click, please")';
    expect(site.csv.csvField(formula)).toBe(
      `"'=HYPERLINK(""http://example.com"",""Click, please"")"`,
    );
    expect(
      site.csv.reportsCsv([
        report("2026-07", [
          sale({
            title: formula,
            author: "@author",
            format: "-fmt",
            channel: "+ch",
          }),
        ]),
      ]),
    ).toBe(
      "period,title,author,format,channel,units,revenue\r\n" +
        `2026-07,"'=HYPERLINK(""http://example.com"",""Click, please"")",'@author,'-fmt,'+ch,2,34.00\r\n`,
    );
  });

  it("renders a title with <, &, quotes, a comma and $& correctly in HTML, SVG text and CSV", async () => {
    const dir = await dataFolder({
      "2026-07.json": report("2026-07", [
        sale({
          title: AWKWARD_TITLE,
          author: AWKWARD_TITLE,
          format: AWKWARD_TITLE,
          channel: "<Web> & 'Mail'",
        }),
      ]),
    });
    const reports = await site.reports.loadReports(dir);
    expect(reports[0].sales[0].title).toBe(AWKWARD_TITLE);

    const pages = renderAll(reports);
    expect(pages).not.toMatch(/<b>|<Web>/);
    // HTML: a table header cell, and the summary's sentence.
    expect(pages).toContain(`<th scope="row">${AWKWARD_TITLE_HTML}</th>`);
    expect(pages).toContain(`<cite>${AWKWARD_TITLE_HTML}</cite>`);
    // SVG: the bar's tooltip has the whole label, the text beside the bar a cut one.
    expect(pages).toContain(`<title>${AWKWARD_TITLE_HTML}: $34.00</title>`);
    expect(pages).toMatch(
      /<text class="chart-label"[^>]*>Bascik &lt;b&gt;&amp; 63, \$&amp; …<\/text>/,
    );
    expect(pages).toContain(
      "<title>&lt;Web&gt; &amp; &#39;Mail&#39;: $34.00</title>",
    );

    // CSV: one quoted field, with only the quotes doubled.
    const quoted = `"Bascik <b>& 63, $& 'n' more"`;
    expect(site.csv.reportsCsv(reports)).toBe(
      "period,title,author,format,channel,units,revenue\r\n" +
        `2026-07,${quoted},${quoted},${quoted},<Web> & 'Mail',2,34.00\r\n`,
    );
  });

  it("prints a site name with HTML-special characters escaped, from the generated src/lib/site.ts", async () => {
    const { siteName } = (await import(
      /* @vite-ignore */ pathToFileURL(join(root, "src/lib/site.ts")).href
    )) as { siteName: string };
    expect(siteName).toBe(AWKWARD_NAME);
    const head = String(
      site.seo.pageHead({
        title: "Racing reports",
        description: "All of them.",
      }),
    );
    expect(head).toContain(
      "<title>Racing reports - Bascik Example &amp; Track Club &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;Racing&#39; \\ $&amp;</title>",
    );
    expect(head).not.toContain("<script>");
  });
});
