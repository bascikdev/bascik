import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readScripts = async (
  packagePath: string,
): Promise<Record<string, string>> => {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
};

describe("E2E script composition", () => {
  it("includes static, dev, HTTP/1.1, and HTTP/2 package modes in every all-E2E entry point", async () => {
    const rootScripts = await readScripts(
      resolve(process.cwd(), "../package.json"),
    );
    const packageScripts = await readScripts(
      resolve(process.cwd(), "package.json"),
    );

    // The serial chains name each mode.
    for (const mode of ["pkg:e2e", "pkg:e2e:dev", "pkg:e2e:prod"])
      expect(rootScripts["pkg:e2e:all:serial"]).toContain(mode);
    for (const mode of ["e2e", "e2e:dev", "e2e:prod"])
      expect(packageScripts["e2e:all:serial"]).toContain(mode);

    // The parallel entry points start the lane runner with no lane names, so it
    // runs its default set, which must be all four modes.
    expect(rootScripts["pkg:e2e:all"]).toMatch(
      /node e2e\/scripts\/run-lanes\.ts$/,
    );
    expect(packageScripts["e2e:all"]).toBe("node e2e/scripts/run-lanes.ts");
    const runner = await readFile(
      resolve(process.cwd(), "e2e/scripts/run-lanes.ts"),
      "utf8",
    );
    for (const config of [
      'static: "playwright.config.ts"',
      'dev: "playwright.dev.config.ts"',
      'http1: "playwright.server.config.ts"',
      'http2: "playwright.server-http2.config.ts"',
    ])
      expect(runner).toContain(config);
    // That the runner defaults to all four lanes is a behavior, pinned by
    // e2e/scripts/run-lanes.test.ts ("runs all four lanes when no lane is named").
  });
});
