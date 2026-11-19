/**
 * dashboard.integration.test.ts
 *
 * The dashboard template through the real compiler and the real hosts.
 *
 * Boundary tested:
 * `scaffold()` on the real filesystem -> the Bascik CLI as a child process ->
 * the emitted static tree, Cloudflare Worker (run in workerd through
 * Miniflare) and Netlify Function (called in-process, as Netlify calls it).
 *
 * Contract asserted:
 * 1. A plain `--build` is a complete dashboard: every page, a page per title,
 *    charts and tables printed, no `NaN`, no unexpanded component tag, and the
 *    live tile left as a build-time snapshot beside an inert placeholder.
 * 2. Two builds of the same project are byte-identical: the data is seeded
 *    and nothing built reads the clock.
 * 3. On Cloudflare and on Netlify the overview is rendered per request: the
 *    stream script's `<stat-tile>` arrives rendered, marked `data-live`, after
 *    the snapshot it replaces.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scaffold, type Adapter } from "../scaffold.ts";
import { DASHBOARD_TEMPLATE } from "./dashboard.ts";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const PKG_CLI = join(REPO_ROOT, "pkg/bin/bascik.js");
const CLOUDFLARE_ADAPTER = join(REPO_ROOT, "adapters/cloudflare");
const NETLIFY_ADAPTER = join(REPO_ROOT, "adapters/netlify");
const BUILT = [
  join(REPO_ROOT, "pkg/dist/index.js"),
  join(CLOUDFLARE_ADAPTER, "dist/index.js"),
  join(NETLIFY_ADAPTER, "dist/index.js"),
];

const tempDirs: string[] = [];

/** Scaffold the dashboard into a new temporary folder and link the workspace packages it resolves. */
async function scaffoldDashboard(adapter?: Adapter): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "bascik-dashboard-test-"));
  tempDirs.push(parent);
  await scaffold("my-dashboard", parent, {
    template: DASHBOARD_TEMPLATE,
    adapter,
  });
  const project = join(parent, "my-dashboard");
  const scope = join(project, "node_modules", "@bascik");
  await mkdir(scope, { recursive: true });
  await symlink(join(REPO_ROOT, "pkg"), join(scope, "bascik"), "dir");
  await symlink(CLOUDFLARE_ADAPTER, join(scope, "adapter-cloudflare"), "dir");
  await symlink(NETLIFY_ADAPTER, join(scope, "adapter-netlify"), "dir");
  return project;
}

async function build(project: string, args: string[] = []): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [PKG_CLI, "--build", ...args],
    {
      cwd: project,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NO_COLOR: "1",
        BASCIK_SITE_URL: "https://example.com",
      },
      timeout: 90_000,
    },
  );
  return `${stdout}\n${stderr}`;
}

/** Every file under `dir`, as a path relative to it, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** A page's markup without its inline scripts and styles, where "undefined" is ordinary code. */
const markupOf = (html: string): string =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/g, () => "")
    .replace(/<style\b[\s\S]*?<\/style>/g, () => "")
    .replace(/<!--[\s\S]*?-->/g, () => "");

/** The live tile a host rendered for one request, or null. */
const liveTileIn = (html: string): string | null =>
  /<article\b[^>]*data-testid="live-orders-reading"[^>]*>[\s\S]*?<\/article>/.exec(
    html,
  )?.[0] ?? null;

const expectLiveOverview = (html: string): void => {
  const tile = liveTileIn(html);
  expect(tile, "the live tile, rendered").not.toBeNull();
  expect(tile).toContain('data-live="true"');
  expect(tile).toContain("Open orders right now");
  expect(tile).toMatch(/rendered for this request at \d\d:\d\d:\d\d UTC/);
  // The request-time tile is the <stat-tile> component, rendered: not the tag.
  expect(html).not.toContain("<stat-tile");
  // The snapshot the build printed comes first, and CSS hides it once the live tile is there.
  expect(html.indexOf("Build-time snapshot from Oct 31, 2026")).toBeGreaterThan(
    -1,
  );
  expect(html.indexOf("Build-time snapshot from Oct 31, 2026")).toBeLessThan(
    html.indexOf('data-testid="live-orders-reading"'),
  );
  // The rest of the page is the build's: the tiles, both charts, the recent orders.
  expect(html.match(/data-testid="stat-tile"/g)).toHaveLength(5);
  expect(html.match(/<svg\b/g)).toHaveLength(2);
  expect(markupOf(html)).not.toMatch(/NaN|undefined|Infinity/);
};

describe("dashboard template, built and served", () => {
  beforeAll(() => {
    const missing = BUILT.filter((path) => !existsSync(path));
    if (missing.length > 0)
      throw new Error(
        `[dashboard.integration.test] Required artifact missing: ${missing.join(", ")}. ` +
          "Run `yarn pkg:build && yarn adapter:cf:build && yarn adapter:nf:build` from the repository root first.",
      );
  });

  afterAll(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("a plain --build is a complete dashboard, with the live tile left as a build-time snapshot", async () => {
    const project = await scaffoldDashboard();
    expect(await readFile(join(project, "data/racing.sql"), "utf8")).toContain(
      "Porsche 917K",
    );
    expect(
      await readFile(join(project, "scripts/seed-database.ts"), "utf8"),
    ).toContain("DatabaseSync");
    expect(
      await readFile(join(project, "src/lib/racing-db.ts"), "utf8"),
    ).toContain("node:sqlite");
    expect(await readFile(join(project, ".gitignore"), "utf8")).toContain(
      "data/racing.db",
    );
    const packageJson = JSON.parse(
      await readFile(join(project, "package.json"), "utf8"),
    );
    expect(packageJson.scripts["db:seed"]).toBe(
      "node scripts/seed-database.ts",
    );
    expect(packageJson.scripts.predev).toBe("npm run db:seed");
    expect(packageJson.scripts.prebuild).toBe("npm run db:seed");

    const output = await build(project);
    expect(output).toContain("Build complete");
    expect(existsSync(join(project, "data/racing.db"))).toBe(false);
    const dist = join(project, "dist");

    const pages = (await filesUnder(dist)).filter((path) =>
      path.endsWith(".html"),
    );
    expect(pages).toEqual(
      expect.arrayContaining([
        "404.html",
        "index.html",
        "orders.html",
        "settings.html",
        "titles.html",
        join("titles", "porsche-917k.html"),
        join("titles", "porsche-718-rs-laguna.html"),
      ]),
    );
    expect(pages.filter((path) => path.startsWith("titles"))).toHaveLength(13);

    for (const page of pages) {
      const html = await readFile(join(dist, page), "utf8");
      const markup = markupOf(html);
      expect(markup, page).not.toMatch(/NaN|undefined|Infinity|\[object /);
      // A hyphenated tag left in the output is a component that did not expand.
      expect(markup.match(/<[a-z]+-[a-z-]+[\s/>]/g) ?? [], page).toEqual([]);
      expect(markup.match(/<main\b/g), page).toHaveLength(1);
      expect(markup.match(/<h1\b/g), page).toHaveLength(1);
      expect(html, page).toMatch(/<title>[^<]+ - my-dashboard<\/title>/);
      expect(markup.match(/aria-current="page"/g) ?? [], page).toHaveLength(
        page.startsWith("titles" + "/") ||
          page.startsWith("titles\\") ||
          page === "404.html"
          ? 0
          : 1,
      );
    }

    const overview = await readFile(join(dist, "index.html"), "utf8");
    expect(overview.match(/data-testid="stat-tile"/g)).toHaveLength(5);
    expect(
      overview.match(/<svg\b[^>]*viewBox="[^"]+"[^>]*role="img"/g),
    ).toHaveLength(2);
    expect(overview).toContain("Build-time snapshot from Oct 31, 2026");
    // The stream script is not in the static page: only an inert placeholder a browser ignores.
    expect(overview).toMatch(
      /<script type="text\/bascik-server"[^>]*data-bascik-stream><\/script>/,
    );
    expect(overview).not.toContain("liveReading");
    expect(liveTileIn(overview)).toBeNull();

    const orders = await readFile(join(dist, "orders.html"), "utf8");
    expect(orders.match(/<tr\b[^>]*data-order="IMSA-\d+"/g)).toHaveLength(80);
    expect(orders).toMatch(
      /<caption>\s*Orders from the last 30 days\s*<\/caption>/,
    );

    const preorder = await readFile(
      join(dist, "titles", "porsche-718-rs-laguna.html"),
      "utf8",
    );
    expect(preorder).toContain("No copies sold in the last 8 weeks.");
    expect(preorder).toContain("No orders include this title yet.");
    expect(preorder).not.toContain("<svg");
  }, 120_000);

  it("builds the same bytes with and without a seeded database", async () => {
    // One project, built twice in place: instance ids hash the source path,
    // so two copies of the project would differ for a reason that is not the data.
    const project = await scaffoldDashboard();
    const dist = join(project, "dist");
    await build(project);
    const files = await filesUnder(dist);
    expect(files.length).toBeGreaterThan(20);
    const firstBuild = new Map<string, Buffer>();
    for (const file of files)
      firstBuild.set(file, await readFile(join(dist, file)));

    await execFileAsync(process.execPath, ["scripts/seed-database.ts"], {
      cwd: project,
    });
    expect(existsSync(join(project, "data/racing.db"))).toBe(true);

    // The second build starts with no output and no cached script results, so every script runs again.
    await rm(dist, { recursive: true, force: true });
    await rm(join(project, "node_modules", ".cache"), {
      recursive: true,
      force: true,
    });
    await build(project);
    expect(await filesUnder(dist)).toEqual(files);
    for (const file of files)
      expect(
        (await readFile(join(dist, file))).equals(firstBuild.get(file)!),
        file,
      ).toBe(true);
  }, 180_000);

  it("reports a corrupt database instead of silently using demo data", async () => {
    const project = await scaffoldDashboard();
    await writeFile(join(project, "data/racing.db"), "not a database");
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "await import(process.argv[1])",
          pathToFileURL(join(project, "src/lib/racing-db.ts")).href,
        ],
        { cwd: project },
      ),
    ).rejects.toThrow(/not a database/i);
  });

  it("renders the overview per request in a Cloudflare Worker, live tile included", async () => {
    const project = await scaffoldDashboard("cloudflare");
    const output = await build(project, ["--target", "cloudflare"]);
    expect(output).toContain("Build complete");
    expect(output).not.toContain("does not declare components: true");
    const target = join(project, "dist/.bascik/cloudflare");
    // Pages with nothing request-time stay static files; the overview lives in the Worker.
    expect(existsSync(join(target, "public", "orders.html"))).toBe(true);
    expect(existsSync(join(target, "public", "titles.html"))).toBe(true);
    expect(existsSync(join(target, "public", "index.html"))).toBe(false);

    const { Miniflare } = await import("miniflare");
    // workerd rejects a symlinked prefix such as macOS /var/folders.
    const dir = await realpath(target);
    const wrangler = JSON.parse(
      await readFile(join(dir, "wrangler.jsonc"), "utf8"),
    ) as {
      compatibility_date: string;
      compatibility_flags: string[];
      assets: { run_worker_first: string[] };
    };
    const worker = new Miniflare({
      modules: true,
      modulesRoot: dir,
      scriptPath: join(dir, "worker.js"),
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      assets: {
        directory: join(dir, "public"),
        binding: "ASSETS",
        routerConfig: {
          has_user_worker: true,
          invoke_user_worker_ahead_of_assets: false,
          static_routing: { user_worker: wrangler.assets.run_worker_first },
        },
      },
    });
    try {
      const overview = await worker.dispatchFetch("http://localhost/");
      expect(overview.status).toBe(200);
      expectLiveOverview(await overview.text());
      const orders = await worker.dispatchFetch("http://localhost/orders");
      expect(orders.status).toBe(200);
      expect(await orders.text()).toContain('data-order="IMSA-1061"');
    } finally {
      await worker.dispose();
    }
  }, 120_000);

  it("renders the overview per request in a Netlify Function, live tile included", async () => {
    const project = await scaffoldDashboard("netlify");
    const output = await build(project, ["--target", "netlify"]);
    expect(output).toContain("Build complete");
    expect(output).not.toContain("does not declare components: true");

    // The package's install step, as the starter's build script runs it.
    const install = spawnSync(
      process.execPath,
      [join(NETLIFY_ADAPTER, "dist/cli.js")],
      { cwd: project, encoding: "utf8" },
    );
    expect(install.status, install.stderr).toBe(0);
    expect(existsSync(join(project, "publish", "orders.html"))).toBe(true);
    expect(existsSync(join(project, "publish", "index.html"))).toBe(false);

    const fn = (await import(
      pathToFileURL(join(project, ".netlify/v1/functions/bascik-pages.mjs"))
        .href
    )) as {
      default: (request: Request, context: object) => Promise<Response>;
      config: { path: string[] };
    };
    expect(fn.config.path).toEqual(expect.arrayContaining(["/", "/api/hello"]));
    expect(fn.config.path).not.toContain("/orders");
    const quiet = { info: console.info, log: console.log };
    console.info = () => {};
    console.log = () => {};
    try {
      const overview = await fn.default(new Request("https://example.com/"), {
        waitUntil: () => {},
      });
      expect(overview.status).toBe(200);
      expectLiveOverview(await overview.text());
    } finally {
      console.info = quiet.info;
      console.log = quiet.log;
    }
  }, 120_000);
});
