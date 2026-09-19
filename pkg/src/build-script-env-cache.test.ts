import { describe, it, expect } from "vitest";
import {
  buildScriptFixtureRoot,
  cleanupFixture,
  createFixtureDirs,
  readDistHtml,
  runRealBuildScriptBuild,
  writeBuildScriptConfig,
  writeFixtureFile,
} from "./lib/build-script-isolation.fixtures.ts";

/**
 * Environment-aware build-script cache keys. A build script that reads a
 * declared `scripts.cache.environment` variable must re-run (and re-emit) when
 * that variable's resolved value changes across two real `bascik --build`
 * invocations sharing the same on-disk cache. Unchanged values must reuse the
 * cached output. This exercises the real CLI, real child processes, and the
 * real disk cache under `node_modules/.cache/bascik/script-cache`.
 */
describe("scripts.cache.environment invalidates build-script cache (real CLI)", () => {
  const pageTemplate = (): string => `<!DOCTYPE html><html lang="en"><head><title>env</title></head><body>
<script data-bascik-build>
console.log('<span data-testid="flag">' + process.env.MY_FEATURE_FLAG + '</span>');
</script>
</body></html>`;

  const writeEnvConfig = async (root: string): Promise<void> => {
    await writeFixtureFile(
      root,
      "bascik.config.js",
      `module.exports = {
  directory: { pages: "src/pages", components: ["src/components"] },
  scripts: { cache: { enabled: true, environment: ["MY_FEATURE_FLAG"] } },
  pipeline: { workers: false },
  generate: { sitemap: false, robots: false, cspHashes: false, manifest: false },
  minify: { html: false, css: false, js: false, identifiers: false },
};`,
    );
  };

  it("re-emits when a declared env value changes across builds sharing the cache", async () => {
    const root = buildScriptFixtureRoot("env-cache");
    try {
      await createFixtureDirs(root);
      await writeEnvConfig(root);
      await writeFixtureFile(root, "src/pages/index.html", pageTemplate());
      await writeFixtureFile(root, ".env.on", "MY_FEATURE_FLAG=on\n");
      await writeFixtureFile(root, ".env.off", "MY_FEATURE_FLAG=off\n");

      // First build: flag "on".
      await runRealBuildScriptBuild(root, ["--env-file=.env.on"]);
      const htmlOn = await readDistHtml(root, "index.html");
      expect(htmlOn).toContain('data-testid="flag">on</span>');

      // Second build with a different env file: the declared value changed, so
      // the cache key must differ and the script must re-run.
      await runRealBuildScriptBuild(root, ["--env-file=.env.off"]);
      const htmlOff = await readDistHtml(root, "index.html");
      expect(htmlOff).toContain('data-testid="flag">off</span>');

      // Back to "on": the original cache entry is reused (no re-execution
      // needed), and the emitted HTML reflects the cached value.
      await runRealBuildScriptBuild(root, ["--env-file=.env.on"]);
      const htmlOnAgain = await readDistHtml(root, "index.html");
      expect(htmlOnAgain).toContain('data-testid="flag">on</span>');
    } finally {
      await cleanupFixture(root);
    }
  }, 90000);

  it("an unchanged declared env value reuses the cache across builds", async () => {
    const root = buildScriptFixtureRoot("env-cache-stable");
    try {
      await createFixtureDirs(root);
      await writeEnvConfig(root);
      await writeFixtureFile(root, "src/pages/index.html", pageTemplate());
      await writeFixtureFile(root, ".env.stable", "MY_FEATURE_FLAG=stable\n");

      await runRealBuildScriptBuild(root, ["--env-file=.env.stable"]);
      const html1 = await readDistHtml(root, "index.html");
      expect(html1).toContain('data-testid="flag">stable</span>');

      // Same value, same key: the cached output is reused.
      await runRealBuildScriptBuild(root, ["--env-file=.env.stable"]);
      const html2 = await readDistHtml(root, "index.html");
      expect(html2).toEqual(html1);
    } finally {
      await cleanupFixture(root);
    }
  }, 90000);
});