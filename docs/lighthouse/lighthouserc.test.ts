import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateLighthouseAllConfig } from "./generate-config.ts";
import { assertPortFree } from "./check-port.ts";
import lighthouseSiteConfig from "./bascik.config.ts";
import {
  LIGHTHOUSE_CONFIG_ARG,
  LIGHTHOUSE_DIST_DIR,
  LIGHTHOUSE_ORIGIN,
  LIGHTHOUSE_PORT,
  LIGHTHOUSE_SERVER_COMMAND,
} from "./site.ts";
import { DEV_PORT, E2E_DIST_DIR, parseE2ePort } from "../e2e/site.ts";

const docsDir = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = LIGHTHOUSE_ORIGIN;
const READY_PATTERN = `Server running at ${LIGHTHOUSE_ORIGIN}`;
const STATIC_CONFIGS = [
  "lighthouserc.json",
  "lighthouserc.desktop.json",
  "lighthouserc.light.json",
];

describe("Lighthouse CI configuration", () => {
  const configPath = join(process.cwd(), "lighthouse/lighthouserc.json");
  const lightConfigPath = join(
    process.cwd(),
    "lighthouse/lighthouserc.light.json",
  );

  it("contains valid Lighthouse CI configuration JSON", async () => {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw);

    expect(config).toBeDefined();
    expect(config.ci).toBeDefined();
  });

  it("fails on a performance score under 0.95, on mobile and desktop", async () => {
    for (const file of ["lighthouserc.json", "lighthouserc.desktop.json"]) {
      const config = JSON.parse(
        await readFile(join(process.cwd(), "lighthouse", file), "utf8"),
      );
      const all = config.ci.assert.assertMatrix.find(
        (entry: { matchingUrlPattern: string }) =>
          entry.matchingUrlPattern === ".*",
      ).assertions;
      expect(all["categories:performance"], file).toEqual([
        "error",
        { minScore: 0.95 },
      ]);
      // Budgets: DOM size, script bytes, and layout forced by scripts before first paint.
      expect(all["dom-size-insight"], file).toEqual([
        "error",
        { maxNumericValue: 4000 },
      ]);
      expect(all["resource-summary:script:size"], file).toEqual([
        "error",
        { maxNumericValue: 51200 },
      ]);
      expect(all["forced-reflow-insight"], file).toBe("warn");
    }
  });

  it("checks /search on mobile and the CLS of the /libraries demos", async () => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.ci.collect.url).toContain(ORIGIN + "/search");
    expect(config.ci.collect.url).toContain(ORIGIN + "/libraries");
    const libraries = config.ci.assert.assertMatrix.find(
      (entry: { matchingUrlPattern: string }) =>
        entry.matchingUrlPattern === ".*/libraries$",
    ).assertions;
    expect(libraries["cumulative-layout-shift"]).toEqual([
      "error",
      { maxNumericValue: 0.01 },
    ]);
  });

  it("runs the desktop preset where a demo recording is the LCP image, and reports how it is discovered", async () => {
    const config = JSON.parse(
      await readFile(
        join(process.cwd(), "lighthouse/lighthouserc.desktop.json"),
        "utf8",
      ),
    );
    expect(config.ci.collect.settings.preset).toBe("desktop");
    for (const page of ["/getting-started", "/stream-scripts", "/sitemap"])
      expect(config.ci.collect.url).toContain(`${ORIGIN}${page}`);
    const all = config.ci.assert.assertMatrix.find(
      (entry: { matchingUrlPattern: string }) =>
        entry.matchingUrlPattern === ".*",
    ).assertions;
    // A warning: the insight asks for fetchpriority="high", which the docs leave off because on a phone the
    // image is not the LCP and the hint makes it compete with the text that is (see md-renderer.ts).
    expect(all["lcp-discovery-insight"]).toBe("warn");
  });

  it("holds /sitemap's mobile LCP, which an eager high-priority recording once pushed from 1.5 s to 2.4 s", async () => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.ci.collect.url).toContain(ORIGIN + "/sitemap");
    const sitemap = config.ci.assert.assertMatrix.find(
      (entry: { matchingUrlPattern: string }) =>
        entry.matchingUrlPattern === ".*/sitemap$",
    ).assertions;
    expect(sitemap["largest-contentful-paint"]).toEqual([
      "error",
      { maxNumericValue: 2000 },
    ]);
  });

  it("runs every gate from the lighthouse scripts", async () => {
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    );
    for (const script of ["lighthouse", "lighthouse:ci"])
      expect(pkg.scripts[script]).toContain(
        "--config=./lighthouse/lighthouserc.desktop.json",
      );
  });

  it("configures server collection and the core documentation routes by default", async () => {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw);

    const collect = config.ci.collect;
    expect(collect.startServerCommand).toBe(LIGHTHOUSE_SERVER_COMMAND);
    expect(collect.startServerReadyPattern).toBe(READY_PATTERN);
    expect(Array.isArray(collect.url)).toBe(true);
    expect(collect.url).toEqual([
      ORIGIN + "/",
      ORIGIN + "/getting-started",
      ORIGIN + "/components",
      ORIGIN + "/search",
      ORIGIN + "/libraries",
      ORIGIN + "/sitemap",
    ]);
  });

  it("contains valid light theme Lighthouse CI configuration JSON with a11y category only", async () => {
    const raw = await readFile(lightConfigPath, "utf8");
    const config = JSON.parse(raw);

    expect(config).toBeDefined();
    expect(config.ci).toBeDefined();

    const collect = config.ci.collect;
    expect(collect.startServerCommand).toBe(LIGHTHOUSE_SERVER_COMMAND);
    expect(collect.startServerReadyPattern).toBe(READY_PATTERN);
    expect(collect.url).toEqual([
      ORIGIN + "/?theme=light",
      ORIGIN + "/getting-started?theme=light",
      ORIGIN + "/components?theme=light",
    ]);
    expect(collect.settings.onlyCategories).toEqual(["accessibility"]);

    const assertions = config.ci.assert.assertions;
    expect(assertions["categories:accessibility"]).toBeDefined();
    expect(assertions["categories:performance"]).toBeUndefined();
  });

  it("generates lighthouserc.all.json and lighthouserc.all-light.json dynamically from nav.ts", async () => {
    const urls = await generateLighthouseAllConfig();
    expect(urls.length).toBeGreaterThan(40);
    expect(urls).toContain(ORIGIN + "/");
    expect(urls).toContain(ORIGIN + "/getting-started");
    expect(urls).toContain(ORIGIN + "/components");
    expect(urls).toContain(ORIGIN + "/lighthouse");
    expect(urls).toContain(ORIGIN + "/lighthouse/performance");

    const allConfigRaw = await readFile(
      join(process.cwd(), "lighthouse/lighthouserc.all.json"),
      "utf8",
    );
    const allConfig = JSON.parse(allConfigRaw);
    expect(allConfig.ci.collect.url).toHaveLength(urls.length);
    expect(allConfig.ci.collect.startServerReadyPattern).toBe(READY_PATTERN);

    const allLightConfigRaw = await readFile(
      join(process.cwd(), "lighthouse/lighthouserc.all-light.json"),
      "utf8",
    );
    const allLightConfig = JSON.parse(allLightConfigRaw);
    expect(allLightConfig.ci.collect.url).toHaveLength(urls.length);
    expect(allLightConfig.ci.collect.startServerReadyPattern).toBe(
      READY_PATTERN,
    );
    expect(allLightConfig.ci.collect.url[0]).toContain("?theme=light");
    expect(allLightConfig.ci.collect.settings.onlyCategories).toEqual([
      "accessibility",
    ]);
  });

  it("defines assertion score thresholds for Lighthouse categories", async () => {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw);

    const assertions = config.ci.assert.assertMatrix[0].assertions;
    expect(assertions["categories:performance"]).toBeDefined();
    expect(assertions["categories:accessibility"]).toBeDefined();
    expect(assertions["categories:best-practices"]).toBeDefined();
    expect(assertions["categories:seo"]).toBeDefined();
  });
});

// The audits build and serve their own copy of the site, so they can run while `yarn docs:dev` serves port 8080 and
// writes docs/dist, and while the docs e2e run serves docs/.e2e/dist. Building into docs/dist rewrote the files the
// dev server was serving, and a server on 8080 failed to start beside the dev server.
describe("Lighthouse runs beside the dev server and the e2e run", () => {
  const scripts = async () =>
    (
      JSON.parse(await readFile(join(docsDir, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;

  it("serves on its own port, neither the dev server's nor the e2e default", () => {
    expect(LIGHTHOUSE_PORT).not.toBe(DEV_PORT);
    expect(LIGHTHOUSE_PORT).not.toBe(parseE2ePort(undefined));
    // The dev server walks up from 8080 when the port is taken; stay clear of the first few it tries.
    expect(LIGHTHOUSE_PORT - DEV_PORT).toBeGreaterThan(10);
  });

  it("builds into its own output directory with its own private folder", () => {
    expect(lighthouseSiteConfig.directory?.out).toBe(LIGHTHOUSE_DIST_DIR);
    // Bascik keeps private build files in <parent of out>/.bascik/<name of out>, so each output needs its own parent.
    const parents = [docsDir, dirname(E2E_DIST_DIR)].map((dir) =>
      dir.replace(/\/$/, ""),
    );
    expect(parents).not.toContain(dirname(LIGHTHOUSE_DIST_DIR));
    expect(LIGHTHOUSE_DIST_DIR.startsWith(docsDir)).toBe(true);
  });

  it("keeps the rest of the docs config, changing only the output directory", async () => {
    const base = (await import("../bascik.config.ts")).default;
    expect({
      ...lighthouseSiteConfig,
      directory: { ...lighthouseSiteConfig.directory, out: undefined },
    }).toEqual({ ...base, directory: { ...base.directory, out: undefined } });
  });

  it("starts the Lighthouse server, and audits only its origin, in every config", async () => {
    const all = await generateLighthouseAllConfig();
    expect(all.every((url) => url.startsWith(`${ORIGIN}/`))).toBe(true);
    for (const file of [
      ...STATIC_CONFIGS,
      "lighthouserc.all.json",
      "lighthouserc.all-light.json",
    ]) {
      const { collect } = JSON.parse(
        await readFile(join(docsDir, "lighthouse", file), "utf8"),
      ).ci;
      expect(collect.startServerCommand, file).toBe(LIGHTHOUSE_SERVER_COMMAND);
      expect(collect.startServerReadyPattern, file).toBe(READY_PATTERN);
      for (const url of collect.url)
        expect(url.startsWith(`${ORIGIN}/`), `${file}: ${url}`).toBe(true);
    }
  });

  it("checks the port, then builds with the Lighthouse config, in every lighthouse script", async () => {
    const all = await scripts();
    for (const name of ["lighthouse", "lighthouse:all", "lighthouse:ci"]) {
      const steps = all[name].split("&&").map((step) => step.trim());
      expect(steps[0], name).toBe("node lighthouse/check-port.ts");
      const builds = steps.filter((step) => /\bbascik\b.*--build/.test(step));
      expect(builds, name).toHaveLength(1);
      expect(builds[0], name).toContain(
        `bascik ${LIGHTHOUSE_CONFIG_ARG} --build`,
      );
      // A bare `bascik --build` would write docs/dist under a running dev server.
      expect(all[name], name).not.toMatch(/bascik --build/);
    }
  });
});

describe("assertPortFree", () => {
  it("resolves for a port nothing listens on", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });

  it("misuse: a port a leftover server holds rejects, naming the port and the fix", async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "localhost", resolve),
    );
    const { port } = server.address() as { port: number };
    try {
      await expect(assertPortFree(port)).rejects.toThrow(
        new RegExp(
          `Port ${port} is already in use.*docs/lighthouse/site\\.ts.*Stop the process`,
        ),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("misuse: a port that is not a port number rejects with the value it got", async () => {
    await expect(assertPortFree(0)).rejects.toThrow(/received 0/);
    await expect(assertPortFree(Number("80a"))).rejects.toThrow(
      /received null/,
    );
  });
});
