import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  runRealBuild,
  writeFixtureFile,
} from "./build-fixtures.ts";

const source = `(() => {
  const seconds = Date.now() / 1e3;
  const tenant = "tenant-id";
  const message = \`See \${\`https://login.example/\${tenant}/errors\`} for details\`;
  globalThis.__bascikMinifiedAsset = { seconds, message };
})();`;

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(cleanupFixture));
});

describe("static JavaScript asset minification integration", () => {
  it("emits parseable, executable output for nested templates and URL slashes", async () => {
    const root = fixtureRoot("js-asset-minification");
    fixtureRoots.push(root);
    await createFixtureDirs(root);
    await writeFixtureFile(root, "bascik.config.js", `module.exports = {
  generate: { sitemap: false, robots: false },
  minify: { js: true },
};`);
    await writeFixtureFile(root, "src/pages/index.html", "<!doctype html><html><body>Asset fixture</body></html>");
    await writeFixtureFile(root, "src/pages/assets/app.js", source);

    await runRealBuild({ projectRoot: root });
    const emitted = await readFile(join(root, "dist/assets/app.js"), "utf8");
    expect(emitted.length).toBeLessThan(source.length);

    const context = {} as { __bascikMinifiedAsset?: { seconds: number; message: string } };
    expect(() => new Function("globalThis", emitted)(context)).not.toThrow();
    expect(context.__bascikMinifiedAsset?.seconds).toBeGreaterThan(0);
    expect(context.__bascikMinifiedAsset?.message).toBe("See https://login.example/tenant-id/errors for details");
  });
});