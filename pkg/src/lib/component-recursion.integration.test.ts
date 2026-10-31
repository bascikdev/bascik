import { afterEach, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupFixture,
  fixtureRoot,
  runRealBuild,
  writeFixtureFile,
} from "./build-fixtures.ts";

// A component that includes its own tag must fail the build with the
// expansion limit error naming it, as the docs promise, not crash the process
// with a heap exhaustion that names nothing (F025). Each expanded instance used
// to keep slices of the page, which pinned a flat copy of the page apiece, so
// memory grew quadratically and a 4 GB heap ran out near 6,000 of the 10,000
// substitutions. A small heap shows the growth is gone.

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(cleanupFixture));
});

describe("a self-including component under a bounded heap", () => {
  it("fails with the expansion limit error naming the component", async () => {
    const root = fixtureRoot("self-including-component");
    fixtureRoots.push(root);
    await mkdir(join(root, "src/pages"), { recursive: true });
    await writeFixtureFile(
      root,
      "src/components/my-card.html",
      `<div class="card">\n  <h2>Card</h2>\n  <my-card></my-card>\n  <p>end</p>\n</div>\n`,
    );
    await writeFixtureFile(
      root,
      "src/pages/index.html",
      `<!doctype html><html lang="en"><head><title>P</title></head><body><my-card></my-card></body></html>`,
    );
    await writeFixtureFile(
      root,
      "bascik.config.js",
      `module.exports = {
  pipeline: { workers: false },
  generate: { sitemap: false, robots: false },
};`,
    );
    const failure = await runRealBuild({
      projectRoot: root,
      env: { NODE_OPTIONS: "--max-old-space-size=256" },
    }).then(
      () => undefined,
      (caught: { stdout?: string; stderr?: string }) =>
        `${caught.stdout ?? ""}${caught.stderr ?? ""}`,
    );
    expect(failure, "the build should fail").toBeDefined();
    expect(failure).not.toMatch(/heap out of memory|heap limit/i);
    expect(failure).toContain("index.html");
    expect(failure).toMatch(
      /exceeded safety limits \(10000 substitutions\)[^]*<my-card> contains its own tag/,
    );
    expect(failure).toContain("components.expansionLimits");
  }, 120_000);
});
