import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateLighthouseAllConfig } from "./generate-config.ts";

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
    expect(config.ci.collect.url).toContain("http://localhost:8080/search");
    expect(config.ci.collect.url).toContain("http://localhost:8080/libraries");
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
      expect(config.ci.collect.url).toContain(`http://localhost:8080${page}`);
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
    expect(config.ci.collect.url).toContain("http://localhost:8080/sitemap");
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
    expect(collect.startServerCommand).toBe("bascik --server");
    expect(collect.startServerReadyPattern).toBe(
      "Server running at http://localhost:8080",
    );
    expect(Array.isArray(collect.url)).toBe(true);
    expect(collect.url).toEqual([
      "http://localhost:8080/",
      "http://localhost:8080/getting-started",
      "http://localhost:8080/components",
      "http://localhost:8080/search",
      "http://localhost:8080/libraries",
      "http://localhost:8080/sitemap",
    ]);
  });

  it("contains valid light theme Lighthouse CI configuration JSON with a11y category only", async () => {
    const raw = await readFile(lightConfigPath, "utf8");
    const config = JSON.parse(raw);

    expect(config).toBeDefined();
    expect(config.ci).toBeDefined();

    const collect = config.ci.collect;
    expect(collect.startServerCommand).toBe("bascik --server");
    expect(collect.startServerReadyPattern).toBe(
      "Server running at http://localhost:8080",
    );
    expect(collect.url).toEqual([
      "http://localhost:8080/?theme=light",
      "http://localhost:8080/getting-started?theme=light",
      "http://localhost:8080/components?theme=light",
    ]);
    expect(collect.settings.onlyCategories).toEqual(["accessibility"]);

    const assertions = config.ci.assert.assertions;
    expect(assertions["categories:accessibility"]).toBeDefined();
    expect(assertions["categories:performance"]).toBeUndefined();
  });

  it("generates lighthouserc.all.json and lighthouserc.all-light.json dynamically from nav.ts", async () => {
    const urls = await generateLighthouseAllConfig();
    expect(urls.length).toBeGreaterThan(40);
    expect(urls).toContain("http://localhost:8080/");
    expect(urls).toContain("http://localhost:8080/getting-started");
    expect(urls).toContain("http://localhost:8080/components");
    expect(urls).toContain("http://localhost:8080/lighthouse");
    expect(urls).toContain("http://localhost:8080/lighthouse/performance");

    const allConfigRaw = await readFile(
      join(process.cwd(), "lighthouse/lighthouserc.all.json"),
      "utf8",
    );
    const allConfig = JSON.parse(allConfigRaw);
    expect(allConfig.ci.collect.url).toHaveLength(urls.length);
    expect(allConfig.ci.collect.startServerReadyPattern).toBe(
      "Server running at http://localhost:8080",
    );

    const allLightConfigRaw = await readFile(
      join(process.cwd(), "lighthouse/lighthouserc.all-light.json"),
      "utf8",
    );
    const allLightConfig = JSON.parse(allLightConfigRaw);
    expect(allLightConfig.ci.collect.url).toHaveLength(urls.length);
    expect(allLightConfig.ci.collect.startServerReadyPattern).toBe(
      "Server running at http://localhost:8080",
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
