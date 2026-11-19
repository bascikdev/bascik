import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADAPTERS,
  GITIGNORE,
  PACKAGE_JSON,
  SITE_HEADER_CSS,
  type TemplateFile,
} from "../scaffold.js";
import { TEMPLATES, templateNamed } from "../templates.js";
import { DASHBOARD_TEMPLATE, siteModule } from "./dashboard.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

type Context = Parameters<typeof DASHBOARD_TEMPLATE.files>[0];

const filesOf = (
  context: Context = { siteName: "My Dashboard" },
): Map<string, string> =>
  new Map(
    DASHBOARD_TEMPLATE.files(context).map(([path, data]: TemplateFile) => [
      path,
      String(data),
    ]),
  );

const files = filesOf();
const file = (path: string): string => {
  const content = files.get(path);
  if (content === undefined) throw new Error(`the template has no ${path}`);
  return content;
};
const pathsMatching = (pattern: RegExp): string[] =>
  [...files.keys()].filter((path) => pattern.test(path));

const PAGES = pathsMatching(/^src\/pages\/.*\.html$/);
const COMPONENTS = pathsMatching(/^src\/components\/.*\.html$/);
/** The modules that run in Node or the browser: everything but the tests. */
const MODULES = pathsMatching(/^src\/.*\.ts$/).filter(
  (path) => !path.endsWith(".test.ts"),
);

/** A file without its comments, so a rule can be checked against the code alone. */
const code = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/g, () => "")
    .replace(/\/\*[\s\S]*?\*\//g, () => "")
    .replace(/(^|\s)\/\/[^\n]*/g, () => "");

/** The opening tag of the element with this id, however its attributes are ordered or wrapped. */
const tagWithId = (text: string, id: string): string =>
  new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(text)?.[0] ?? "";

/** The opening tag of each `<script>` in a file. */
const scriptTags = (text: string): string[] =>
  code(text).match(/<script\b[^>]*>/g) ?? [];

// ─── The generated modules, loaded and run ────────────────────────────────────

interface ChartPoint {
  label: string;
  value: number;
}
interface ChartOptions {
  label: string;
  format?: (value: number) => string;
  emptyText?: string;
}
interface Order {
  id: string;
  date: string;
  customer: string;
  totalCents: number;
  status: string;
  lines: { slug: string; quantity: number }[];
}
interface GeneratedModules {
  site: { SITE_NAME: string; pageTitle(page: string): unknown };
  shop: {
    ORDERS: readonly Order[];
    TITLES: readonly { slug: string; title: string; preorder?: boolean }[];
    PERIOD_END: string;
    generateOrders(seed?: number, days?: number, end?: string): Order[];
    currentOrders(): Order[];
    changeFrom(
      current: number,
      previous: number,
    ): { direction: string; text: string };
  };
  charts: {
    lineChart(points: ChartPoint[], options: ChartOptions): unknown;
    barChart(points: ChartPoint[], options: ChartOptions): unknown;
    chartTable(
      points: ChartPoint[],
      options: { caption: string; labelHeading: string; valueHeading: string },
    ): unknown;
  };
  figures: {
    keyFigures(
      current?: Order[],
      previous?: Order[],
    ): { label: string; value: string; change: { text: string } }[];
  };
}

/**
 * Write a scaffolded project's modules into a temporary folder that resolves
 * `@bascik/bascik` from this repository (its `html` helper comes from
 * `pkg/dist`), and import them.
 */
async function loadProject(
  root: string,
  context: Context,
): Promise<GeneratedModules> {
  for (const [path, data] of DASHBOARD_TEMPLATE.files(context)) {
    if (!/^src\/.*\.ts$/.test(path) && !/^data\/.*\.sql$/.test(path)) continue;
    if (path.endsWith(".test.ts")) continue;
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  const scope = join(root, "node_modules", "@bascik");
  await mkdir(scope, { recursive: true });
  await symlink(join(REPO_ROOT, "pkg"), join(scope, "bascik"), "junction");
  const load = (path: string): Promise<unknown> =>
    import(pathToFileURL(join(root, ...path.split("/"))).href);
  return {
    site: (await load("src/lib/site.ts")) as GeneratedModules["site"],
    shop: (await load("src/lib/shop.ts")) as GeneratedModules["shop"],
    charts: (await load("src/lib/charts.ts")) as GeneratedModules["charts"],
    figures: (await load(
      "src/components/key-figures/figures.ts",
    )) as GeneratedModules["figures"],
  };
}

/** A name with every character HTML, a template literal and a string literal treat specially. */
const HOSTILE_NAME = `Tom & "Ann's" <b>Books</b> \`\${x}\` \\ </script>`;

let project: GeneratedModules;
let hostile: GeneratedModules;
const roots: string[] = [];

beforeAll(async () => {
  const make = async (context: Context): Promise<GeneratedModules> => {
    const root = await mkdtemp(join(tmpdir(), "create-bascik-dashboard-"));
    roots.push(root);
    return loadProject(root, context);
  };
  project = await make({ siteName: "My Dashboard" });
  hostile = await make({ siteName: HOSTILE_NAME });
}, 60_000);

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

// ─── The template ─────────────────────────────────────────────────────────────

describe("dashboard template", () => {
  it("is registered under its name, with the summary the CLI prints", () => {
    expect(TEMPLATES).toContain(DASHBOARD_TEMPLATE);
    expect(templateNamed("dashboard")).toBe(DASHBOARD_TEMPLATE);
    expect(templateNamed("Dashboard")).toBe(DASHBOARD_TEMPLATE);
    expect(DASHBOARD_TEMPLATE.summary).toBe(
      "A dashboard: stat tiles, SVG charts, a sortable data table, and a settings page",
    );
  });

  it("needs no package beyond the starter's own", () => {
    expect(DASHBOARD_TEMPLATE.dependencies).toBeUndefined();
    expect(DASHBOARD_TEMPLATE.devDependencies).toBeUndefined();
    const imported = new Set(
      [...files.values()].flatMap((text) =>
        [...text.matchAll(/from ["']([^"'.@][^"']*|@[^"'/]+\/[^"'/]+)/g)].map(
          (match) => match[1],
        ),
      ),
    );
    for (const name of imported)
      expect(
        name === "vitest" ||
          name === "@bascik/bascik" ||
          name === "@playwright/test" ||
          name.startsWith("node:"),
        name,
      ).toBe(true);
  });

  it("writes the racing SQLite seed system and package hooks", () => {
    expect(files.has("data/racing.sql"), "SQL seed").toBe(true);
    expect(files.has("scripts/seed-database.ts"), "seed script").toBe(true);
    expect(files.has("src/lib/racing-db.ts"), "SQLite reader").toBe(true);

    const pkg = JSON.parse(
      PACKAGE_JSON("my-dashboard", undefined, DASHBOARD_TEMPLATE),
    );
    expect(pkg.scripts["db:seed"]).toBe("node scripts/seed-database.ts");
    expect(pkg.scripts.predev).toBe("npm run db:seed");
    expect(pkg.scripts.prebuild).toBe("npm run db:seed");

    expect(GITIGNORE).not.toContain("data/racing.db");
  });

  it("writes the overview, the orders, titles and settings pages, a page per title, and a 404", () => {
    expect(PAGES.sort()).toEqual([
      "src/pages/404.html",
      "src/pages/index.html",
      "src/pages/orders.html",
      "src/pages/settings.html",
      "src/pages/titles.html",
      "src/pages/titles/[slug].html",
    ]);
    expect(files.has("e2e/app.spec.ts")).toBe(true);
    expect(files.has("src/pages/css/styles.css")).toBe(true);
  });

  it("writes the same files with every adapter and with none: the live tile needs no adapter page", () => {
    const none = [...files.entries()];
    for (const adapter of ADAPTERS)
      expect([
        ...filesOf({ siteName: "My Dashboard", adapter }).entries(),
      ]).toEqual(none);
  });

  it("declares the folder of every file it writes", () => {
    const declared = new Set(
      DASHBOARD_TEMPLATE.directories({ siteName: "My Dashboard" }),
    );
    for (const path of files.keys()) {
      const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      if (folder) expect(declared.has(folder), path).toBe(true);
    }
    expect(declared.has("")).toBe(false);
  });

  it("gives every component a test beside it, and every module with logic a test", () => {
    for (const path of COMPONENTS)
      expect(files.has(path.replace(/\.html$/, ".test.ts")), path).toBe(true);
    for (const name of ["shop", "charts", "order-table", "site"])
      expect(files.has(`src/lib/${name}.test.ts`), name).toBe(true);
  });
});

// ─── The site's name ──────────────────────────────────────────────────────────

describe("the site's name", () => {
  it("is written in one file only, as a string literal", () => {
    const named = filesOf({ siteName: "Zebra Crossing Books" });
    const holders = [...named.entries()]
      .filter(([, text]) => text.includes("Zebra Crossing Books"))
      .map(([path]) => path);
    expect(holders).toEqual(["src/lib/site.ts"]);
    expect(named.get("src/lib/site.ts")).toContain(
      'export const SITE_NAME: string = "Zebra Crossing Books";',
    );
  });

  it("misuse: a name with HTML, quote, backtick and template characters reads back unchanged", () => {
    expect(hostile.site.SITE_NAME).toBe(HOSTILE_NAME);
  });

  it("misuse: a hostile name reaches no page as markup, and is escaped where a page prints it", () => {
    const named = filesOf({ siteName: HOSTILE_NAME });
    for (const [path, text] of named)
      if (path !== "src/lib/site.ts")
        expect(text.includes("<b>Books</b>"), path).toBe(false);
    const title = String(hostile.site.pageTitle("Orders"));
    expect(title).not.toContain("<b>");
    expect(title).toContain("Tom &amp; &quot;Ann&#39;s&quot; &lt;b&gt;Books");
    expect(title.match(/<\/title>/g)).toHaveLength(1);
    expect(title).not.toContain("</script>");
  });

  it("misuse: an empty name still gives a module that loads", () => {
    expect(siteModule("")).toContain('export const SITE_NAME: string = "";');
  });

  it("is printed by the header and every page title through html, never typed into them", () => {
    expect(file("src/components/app-header/app-header.html")).toContain(
      "html`${SITE_NAME}`",
    );
    for (const path of PAGES) {
      expect(file(path), path).toContain("pageTitle(");
      expect(file(path), path).not.toMatch(/<title>/);
    }
  });
});

// ─── House rules ──────────────────────────────────────────────────────────────

describe("house rules", () => {
  it('writes every page as a list of component tags around one <main id="main">', () => {
    for (const path of PAGES) {
      const page = file(path);
      expect(page, path).toMatch(/^<!doctype html>/);
      expect(page, path).toContain('<html lang="en">');
      expect(page.match(/<main\b/g), path).toHaveLength(1);
      expect(page, path).toMatch(/<main id="main" data-testid="[a-z-]+-main">/);
      // The header, with the skip link first in it, opens the body.
      expect(page, path).toMatch(/<body>\s*<app-header \/>\s*<app-sidebar \/>/);
      expect(page, path).toContain("<site-head />");
      // A page stays short enough to read at a glance.
      expect(page.split("\n").length, path).toBeLessThan(50);
    }
  });

  it("gives every page one <h1>, and no heading that skips a level", () => {
    for (const path of PAGES) {
      const own = (file(path).match(/<h1\b/g) ?? []).length;
      // The title page's heading is the title, printed by <title-detail>.
      const printed = path.endsWith("[slug].html")
        ? (file("src/components/title-detail/detail.ts").match(/<h1\b/g) ?? [])
            .length
        : 0;
      expect(own + printed, path).toBe(1);
    }
    for (const path of COMPONENTS)
      expect(file(path), path).not.toMatch(/<h1\b/);
    // Sections open with <h2>; only a tile, which sits inside a section, uses <h3>.
    const deeper = pathsMatching(/^src\/.*\.(html|ts)$/).filter(
      (path) => !path.endsWith(".test.ts") && /<h[3-6]\b/.test(file(path)),
    );
    expect(deeper).toEqual(["src/components/stat-tile/stat-tile.html"]);
  });

  it("puts a data-testid on every component root and every control", () => {
    const head = new Set(["site-head", "theme-init"]);
    for (const path of COMPONENTS) {
      const name = path.split("/")[2];
      const markup = code(file(path))
        .replace(/<style>[\s\S]*?<\/style>/g, () => "")
        .replace(/<script\b[\s\S]*?<\/script>/g, () => "");
      if (!head.has(name))
        expect(markup.trimStart(), path).toMatch(
          new RegExp(`^<[a-z]+\\b[^>]*data-testid="${name}"`),
        );
      for (const control of markup.match(
        /<(button|input|select|textarea|summary|form|search)\b[^>]*>/g,
      ) ?? [])
        expect(control, path).toMatch(new RegExp(`data-testid="${name}(-|")`));
    }
  });

  it("uses semantic roots: no component is a wrapper <div>", () => {
    const roots = new Map<string, string>();
    for (const path of COMPONENTS) {
      const markup = code(file(path)).replace(
        /<style>[\s\S]*?<\/style>/g,
        () => "",
      );
      roots.set(path.split("/")[2], /<([a-z]+)\b/.exec(markup)![1]);
    }
    expect(Object.fromEntries(roots)).toEqual({
      "app-header": "header",
      "app-sidebar": "nav",
      "chart-figure": "figure",
      "key-figures": "section",
      "live-orders": "section",
      "orders-table": "section",
      "recent-orders": "section",
      "revenue-chart": "section",
      "settings-form": "form",
      "site-head": "meta",
      "stat-tile": "article",
      "status-badge": "span",
      "stock-table": "section",
      "theme-init": "meta",
      "theme-toggle": "button",
      "title-detail": "article",
      "top-titles": "section",
    });
  });

  it("writes every script in TypeScript", () => {
    for (const path of [...PAGES, ...COMPONENTS])
      for (const tag of scriptTags(file(path)))
        expect(
          /type="text\/typescript"/.test(tag) ||
            /type="module" src="[a-z-]+\.ts"/.test(tag),
          `${path}: ${tag}`,
        ).toBe(true);
    expect(pathsMatching(/\.(js|mjs)$/)).toEqual([]);
  });

  it("builds markup with html from @bascik/bascik/html, and has no escaper of its own", () => {
    for (const path of MODULES) {
      const text = code(file(path));
      expect(text, path).not.toMatch(/&amp;|&lt;|&quot;|escapeHtml/);
      if (/<\/?[a-z][a-z-]*[\s>]/.test(text.replace(/<[A-Z][^>]*>/g, () => "")))
        if (
          !path.endsWith("orders-table.ts") &&
          !path.endsWith("settings-form.ts")
        )
          expect(text, path).toContain('from "@bascik/bascik/html"');
    }
    for (const path of [...PAGES, ...COMPONENTS])
      expect(code(file(path)), path).not.toMatch(
        /escapeHtml|\.replace\(\/&\/g/,
      );
  });

  it("never builds markup in a browser script", () => {
    for (const path of [...PAGES, ...COMPONENTS, ...MODULES])
      expect(file(path), path).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
      );
  });

  it("hides the skip link by clipping until it is focused, as the default template does", () => {
    const rule = /\.skip-link:not\(:focus\) \{[^}]*\}/;
    const compact = (text: string): string => text.replace(/\s+/g, " ");
    expect(
      compact(rule.exec(file("src/components/app-header/app-header.html"))![0]),
    ).toBe(compact(rule.exec(SITE_HEADER_CSS)![0]));
    expect(file("src/components/app-header/app-header.html")).toMatch(
      /<header[^>]*>\s*<a href="#main" class="skip-link"/,
    );
  });

  it("marks the current page with aria-current, in code that chooses between two fixed tags", () => {
    const nav = file("src/components/app-sidebar/nav.ts");
    expect(nav).toContain('aria-current="page"');
    expect(nav).not.toMatch(/aria-current="\$\{/);
  });
});

// ─── What runs where ──────────────────────────────────────────────────────────

describe("what runs where", () => {
  it("renders one piece per request: the stream script in <live-orders>", () => {
    const requestTime = [...files.entries()]
      .filter(([path]) => path.endsWith(".html"))
      .filter(([, text]) =>
        scriptTags(text).some((tag) => /data-bascik-(server|stream)/.test(tag)),
      )
      .map(([path]) => path);
    expect(requestTime).toEqual([
      "src/components/live-orders/live-orders.html",
    ]);
    expect(pathsMatching(/^src\/api\//)).toEqual([]);
  });

  it("prints a build-time snapshot before the stream script, so a static host shows a working tile", () => {
    const live = file("src/components/live-orders/live-orders.html");
    const snapshot = live.indexOf("<script data-bascik-build-once");
    const stream = live.indexOf("<script data-bascik-stream");
    expect(snapshot).toBeGreaterThan(-1);
    expect(stream).toBeGreaterThan(snapshot);
    // The snapshot is replaced through CSS, with no client script.
    expect(live).toContain(".panel:has([data-live]) .snapshot");
    expect(live).not.toMatch(/<script(?![^>]*data-bascik)/);
  });

  it("keeps the build reproducible: no unseeded randomness and no clock in build-time code", () => {
    for (const [path, text] of files) {
      if (path.endsWith(".test.ts") || path.startsWith("e2e/")) continue;
      const source = code(text);
      expect(source, path).not.toMatch(
        /Math\.random|Date\.now|performance\.now/,
      );
      // Only the per-request tile reads the clock.
      if (path !== "src/components/live-orders/live-orders.html")
        expect(source, path).not.toMatch(/new Date\(\s*\)/);
    }
  });

  it("reads the request nowhere on the server, and checks the one query parameter the browser reads", () => {
    for (const [path, text] of files)
      if (!path.endsWith(".test.ts") && !path.startsWith("e2e/"))
        expect(code(text), path).not.toMatch(
          /request\.(url|headers)|\.searchParams/,
        );
    const table = file("src/components/orders-table/orders-table.ts");
    expect(table).toContain(
      'new URLSearchParams(location.search).get("status")',
    );
    expect(table).toContain("option.value === wanted");
  });

  it("says in the generated site that there is no authentication, and where it would go", () => {
    expect(file("src/pages/index.html")).toMatch(/No authentication:/);
    expect(file("src/components/live-orders/live-orders.html")).toMatch(
      /No authentication:[\s\S]*session/,
    );
    expect(file("src/components/settings-form/settings-form.html")).toContain(
      "<strong>Demo.</strong>",
    );
  });

  it("builds a page per title through a dynamic route", () => {
    const page = file("src/pages/titles/[slug].html");
    expect(page).toContain("<script data-bascik-routes");
    expect(page).toContain("params: { slug: title.slug }");
    expect(page).toContain("<title-detail />");
  });
});

// ─── The data generator ───────────────────────────────────────────────────────

describe("the generated data module", () => {
  it("is deterministic: the same SQLite orders on every call and in every project", () => {
    const { shop } = project;
    expect(shop.generateOrders()).toEqual(shop.generateOrders());
    expect(shop.generateOrders()).toEqual([...shop.ORDERS]);
    expect(hostile.shop.ORDERS).toEqual(shop.ORDERS);
  });

  it("gives the numbers the pages are written around", () => {
    const { shop } = project;
    // Pinned, so a change to the generator or the seed shows up here.
    expect(shop.PERIOD_END).toBe("2026-10-31");
    expect(shop.ORDERS).toHaveLength(160);
    expect(shop.currentOrders()).toHaveLength(80);
    expect(shop.ORDERS[0].id).toBe("IMSA-1061");
    expect(shop.ORDERS[0].date).toBe("2026-10-31");
  });

  it("uses Porsche, IMSA, WEC, and racing references, with one car on preorder", () => {
    const { shop } = project;
    expect(shop.TITLES).toHaveLength(12);
    expect(shop.TITLES.filter((title) => title.preorder)).toHaveLength(1);
    expect(shop.TITLES.map((title) => title.title).join(" ")).toMatch(
      /Porsche 917|Porsche 935|Porsche 962|Porsche 963/,
    );
    expect(shop.ORDERS[0].customer).toMatch(
      /Hurley Haywood|Jordan Taylor|Ross Bentley|Paul Newman/,
    );
    const ordered = new Set(
      shop.ORDERS.flatMap((order) => order.lines.map((line) => line.slug)),
    );
    for (const title of shop.TITLES)
      expect(ordered.has(title.slug), title.slug).toBe(!title.preorder);
  });

  it("misuse: no days, or a negative number of days, gives no orders", () => {
    expect(project.shop.generateOrders(1, 0)).toEqual([]);
    expect(project.shop.generateOrders(1, -5)).toEqual([]);
  });

  it("misuse: a comparison with zero or with a value that is not a number never prints NaN", () => {
    for (const [current, previous] of [
      [5, 0],
      [0, 0],
      [Number.NaN, 3],
      [3, Number.POSITIVE_INFINITY],
    ])
      expect(project.shop.changeFrom(current, previous).text).not.toMatch(
        /NaN|Infinity|undefined/,
      );
    for (const figure of project.figures.keyFigures([], [])) {
      expect(figure.value).not.toMatch(/NaN|Infinity|undefined/);
      expect(figure.change.text).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});

// ─── The chart helpers ────────────────────────────────────────────────────────

describe("the generated chart helpers", () => {
  const points = (...values: number[]): ChartPoint[] =>
    values.map((value, index) => ({ label: `Day ${index + 1}`, value }));
  const options: ChartOptions = { label: "Copies sold per day" };

  /** Every number in the markup's geometry attributes. */
  const numbersIn = (markup: string): number[] => [
    ...[
      ...markup.matchAll(
        /\b(?:x|y|x1|x2|y1|y2|cx|cy|r|rx|width|height)="([^"]*)"/g,
      ),
    ].map((match) => Number(match[1])),
    ...[...markup.matchAll(/points="([^"]*)"/g)].flatMap((match) =>
      match[1].split(/[ ,]+/).map(Number),
    ),
  ];

  /** Valid SVG for this chart: one balanced <svg> with a viewBox, a label, and finite geometry. */
  const expectDrawn = (markup: string): void => {
    expect(markup).toMatch(/^<svg\b[^>]*\bviewBox="0 0 \d+ \d+"/);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Copies sold per day"');
    expect(markup.match(/<svg\b/g)).toHaveLength(1);
    expect(markup.match(/<\/svg>/g)).toHaveLength(1);
    expect(markup.trimEnd().endsWith("</svg>")).toBe(true);
    expect((markup.match(/<text\b/g) ?? []).length).toBe(
      (markup.match(/<\/text\s*>/g) ?? []).length,
    );
    expect(markup).not.toMatch(/NaN|Infinity|undefined|null/);
    const numbers = numbersIn(markup);
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.every((value) => Number.isFinite(value))).toBe(true);
    for (const size of markup.matchAll(/\b(?:width|height|r)="([^"]*)"/g))
      expect(Number(size[1])).toBeGreaterThanOrEqual(0);
  };

  const expectEmptyState = (markup: string): void => {
    expect(markup).not.toContain("<svg");
    expect(markup).toMatch(/^<p class="chart-empty">[^<]+<\/p>$/);
    expect(markup).not.toMatch(/NaN|Infinity|undefined/);
  };

  describe.each(["lineChart", "barChart"] as const)("%s", (name) => {
    const chart = (series: ChartPoint[], with_ = options): string =>
      String(project.charts[name](series, with_));

    it("draws a series as SVG with a viewBox and a label", () => {
      expectDrawn(chart(points(3, 9, 4, 12)));
    });

    it("misuse: an empty series is a deliberate, written empty state", () => {
      expectEmptyState(chart([]));
      expect(chart([], { ...options, emptyText: "Nothing yet" })).toContain(
        "Nothing yet",
      );
    });

    it("draws a single point", () => {
      expectDrawn(chart(points(7)));
      expectDrawn(chart(points(0)));
    });

    it("draws values that are all equal", () => {
      expectDrawn(chart(points(5, 5, 5, 5)));
      expectDrawn(chart(points(0, 0, 0)));
      expectDrawn(chart(points(-2, -2)));
    });

    it("draws zero and negative values", () => {
      expectDrawn(chart(points(-4, 0, 6, -2)));
      expectDrawn(chart(points(-4, -9, -1)));
      expectDrawn(chart(points(0.001, -0.002)));
    });

    it("misuse: leaves out values that are not finite, and never prints NaN", () => {
      expectDrawn(
        chart(
          points(
            2,
            Number.NaN,
            8,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            1e300,
          ),
        ),
      );
      expectEmptyState(chart(points(Number.NaN)));
      expectEmptyState(
        chart(points(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)),
      );
    });

    it("misuse: escapes labels that hold markup", () => {
      const markup = String(
        project.charts[name](
          [{ label: '<img src=x onerror="alert(1)">', value: 2 }],
          { label: 'Sales of "Tom & Ann"' },
        ),
      );
      expect(markup).not.toContain("<img");
      expect(markup).toContain("Tom &amp; Ann");
    });

    it("draws a long series without losing a point", () => {
      const markup = chart(
        points(...Array.from({ length: 365 }, (_, i) => i % 17)),
      );
      expectDrawn(markup);
    });
  });

  it("keeps a chart's meaning out of color alone: bar values are text, and the table has every number", () => {
    const bars = String(
      project.charts.barChart(points(3, 12), {
        ...options,
        format: (value) => `${value} sold`,
      }),
    );
    expect(bars).toContain("3 sold");
    expect(bars).toContain("12 sold");
    const table = String(
      project.charts.chartTable(points(3, Number.NaN), {
        caption: "Copies",
        labelHeading: "Day",
        valueHeading: "Copies",
      }),
    );
    expect(table).toMatch(/<caption>\s*Copies\s*<\/caption>/);
    expect(table.match(/scope="col"/g)).toHaveLength(2);
    expect(table.match(/scope="row"/g)).toHaveLength(2);
    expect(table).toContain("Not available");
    expect(table).not.toContain("NaN");
  });

  it("styles charts from tokens that follow the theme, with text sized to stay legible", () => {
    const css = file("src/pages/css/styles.css");
    expect(css).toContain("color-scheme: light dark;");
    expect(css).toMatch(/--color-accent: light-dark\(/);
    expect(css).toMatch(/\.chart-line \{[^}]*stroke: var\(--color-accent\)/);
    expect(css).toMatch(/\.chart-text \{[^}]*font-size: 13px/);
    // The wide chart scrolls inside its box on a phone instead of shrinking its labels.
    expect(css).toMatch(/\.chart-wide \{[^}]*min-width:/);
    expect(file("src/lib/charts.ts")).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});

// ─── The orders table and the settings form ───────────────────────────────────

describe("the orders table", () => {
  const table = file("src/components/orders-table/orders-table.html");

  it("is a <table> with a <caption>, a scope on every heading, and aria-sort on the sortable ones", () => {
    expect(table).toMatch(
      /<caption>\s*Orders from the last 30 days\s*<\/caption>/,
    );
    // The heading row is printed from the column list in head.ts.
    const head = file("src/components/orders-table/head.ts");
    expect(table).toMatch(
      /<thead[^>]*>\s*<script data-bascik-build-once type="text\/typescript">/,
    );
    expect(head.match(/<th\b/g)).toHaveLength(2);
    expect(head.match(/<th\s+scope="col"/g)).toHaveLength(2);
    expect(head).toMatch(/aria-sort="\$\{/);
    expect(head.match(/key: "[a-z]+"/g)).toHaveLength(5);
    expect(file("src/lib/order-table.ts")).toContain('<th scope="row">');
  });

  it("prints every row at build time, so the table is whole without JavaScript", () => {
    expect(table).toMatch(
      /<tbody[^>]*>\s*<script data-bascik-build-once type="text\/typescript">/,
    );
    expect(table).toContain("orderRows(currentOrders())");
    // The controls only a script can serve stay hidden or disabled until it runs.
    expect(table).toMatch(/<search[^>]*\bhidden\b/);
    expect(file("src/components/orders-table/head.ts")).toMatch(
      /<button\b[^>]*\bdisabled\b/,
    );
    expect(file("src/components/orders-table/orders-table.ts")).toContain(
      "button.disabled = false;",
    );
  });

  it("shows a status as text in a badge, with a mark per status", () => {
    expect(file("src/lib/order-table.ts")).toMatch(
      /<status-badge\s+data-bascik-prop-status="\$\{order\.status\}"/,
    );
    expect(file("src/components/status-badge/status-badge.html")).toContain(
      "data-bascik-prop-status",
    );
  });

  it("has an empty state and a pager", () => {
    expect(table).toContain("No orders match these filters.");
    expect(table).toContain('data-testid="orders-table-clear"');
    expect(table).toContain('data-testid="orders-table-previous"');
    expect(tagWithId(table, "summary")).toContain('role="status"');
  });
});

describe("the settings form", () => {
  const form = file("src/components/settings-form/settings-form.html");

  it("labels every control", () => {
    const controls = form.match(/<(input|select)\b[^>]*>/g) ?? [];
    expect(controls).toHaveLength(5);
    for (const control of controls) {
      const id = /\bid="([^"]+)"/.exec(control)![1];
      expect(form, id).toContain(`for="${id}"`);
    }
  });

  it("has a live region for the confirmation and an alert for the error state", () => {
    expect(tagWithId(form, "saved")).toContain('role="status"');
    expect(tagWithId(form, "problem")).toContain('role="alert"');
  });

  it("is marked as a demo that saves to the browser only", () => {
    expect(form).toContain("saved in this browser only");
    const script = file("src/components/settings-form/settings-form.ts");
    expect(script).toContain("localStorage.setItem(STORAGE_KEY");
    expect(script).not.toMatch(/\bfetch\(/);
  });
});

// ─── The generated tests ──────────────────────────────────────────────────────

describe("the generated e2e spec", () => {
  const spec = file("e2e/app.spec.ts");

  it.each([
    ["the overview", "shows the stat tiles"],
    ["sorting both ways", "sorts a column both ways"],
    [
      "filtering to an empty state",
      "shows an empty state when nothing matches",
    ],
    ["pagination", "pages through the rows"],
    ["a detail page", "opens the page built for one"],
    ["the settings form", "saves valid settings to this browser"],
    ["the theme toggle across a reload", "keeps it across a reload"],
    ["the sidebar toggle at phone width", "at phone width"],
    ["the live tile", "renders the live tile per request"],
    ["the 404", "answers an unknown address with the 404 page"],
  ])("covers %s", (_what, title) => {
    expect(spec).toContain(title);
  });

  it("finds elements by role and data-testid, never by a scoped class or id", () => {
    expect(spec).not.toMatch(/locator\(['"][.#]/);
    expect(spec).not.toMatch(/bascik__|\.nth\(|locator\(['"]\.\./);
    expect(spec).toMatch(/toHaveAttribute\(\s*"aria-sort",\s*"ascending"/);
    expect(spec).toMatch(/toHaveAttribute\(\s*"aria-sort",\s*"descending"/);
  });
});
