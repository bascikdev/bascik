import { afterEach, describe, expect, it } from "vitest";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  runRealBuild,
  writeFixtureFile,
} from "./build-fixtures.ts";

// Build script children share Node's on-disk compile cache, so a module the
// first child compiled is not recompiled by the next. Each script still runs
// in its own fresh process, and the emitted pages must not depend on whether
// the cache was cold, warm, or disabled.

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(cleanupFixture));
});

const listFiles = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir, { recursive: true })).map(String);
  } catch {
    return [];
  }
};

const withoutNodeCompileCacheSettings = (): Record<string, string | undefined> => ({
  NODE_COMPILE_CACHE: undefined,
  NODE_DISABLE_COMPILE_CACHE: undefined,
});

describe("build script compile cache", () => {
  it("fills a project-local cache and emits identical pages whether it is cold, warm, or disabled", async () => {
    const root = fixtureRoot("compile-cache");
    fixtureRoots.push(root);
    await createFixtureDirs(root);
    await writeFixtureFile(root, "bascik.config.js", `module.exports = {
  generate: { sitemap: false, robots: false },
};`);
    await writeFixtureFile(root, "src/lib/greet.ts", "export const greet = (name: string): string => `hello ${name}`;\n");
    for (const name of ["a", "b"]) {
      await writeFixtureFile(root, `src/pages/${name}.html`, `<!doctype html><html lang="en"><head><title>${name}</title></head><body>
<p><script data-bascik-build>
  import { greet } from '@/lib/greet.ts';
  export default () => greet(${JSON.stringify(name)}) + ':' + process.pid;
</script></p>
</body></html>`);
    }
    const cacheDir = join(root, "node_modules", ".cache", "bascik", "compile-cache");
    const scriptCache = join(root, "node_modules", ".cache", "bascik", "script-cache");
    const pids: string[] = [];
    const page = async (name: string) => {
      const html = await readFile(join(root, "dist", `${name}.html`), "utf8");
      pids.push(/hello [ab]:(\d+)/.exec(html)?.[1] ?? "");
      return html.replace(/(hello [ab]):\d+/, "$1:PID");
    };
    const build = async (env: Record<string, string | undefined>) => {
      // Clear script output caching so every build runs real children.
      await rm(scriptCache, { recursive: true, force: true });
      await runRealBuild({ projectRoot: root, env: env as Record<string, string> });
      return [await page("a"), await page("b")];
    };

    const cold = await build(withoutNodeCompileCacheSettings());
    expect(cold[0]).toContain("hello a:PID");
    expect(cold[1]).toContain("hello b:PID");
    expect((await listFiles(cacheDir)).length).toBeGreaterThan(0);
    // Each script still ran in its own child process.
    expect(pids[0]).not.toBe(pids[1]);

    expect(await build(withoutNodeCompileCacheSettings())).toEqual(cold);

    await rm(cacheDir, { recursive: true, force: true });
    expect(await build({ ...withoutNodeCompileCacheSettings(), NODE_DISABLE_COMPILE_CACHE: "1" })).toEqual(cold);
    expect(await listFiles(cacheDir)).toEqual([]);
  }, 120_000);
});
