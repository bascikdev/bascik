import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("documented Vitest setup", () => {
  it("installs the required Vite peer alongside Vitest and coverage", async () => {
    const docs = await readFile(
      new URL("../content/testing/unit-testing.md", import.meta.url),
      "utf8",
    );
    const install = /npm install -D ([^\n]+)/.exec(docs)?.[1].split(/\s+/);
    const vitest = require("vitest/package.json");
    expect(vitest.peerDependencies.vite).toBeDefined();
    expect(vitest.peerDependenciesMeta.vite.optional).toBe(false);
    expect(install).toEqual(
      expect.arrayContaining(["vitest", "@vitest/coverage-v8", "vite"]),
    );
  });
});
