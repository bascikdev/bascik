import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The emitted declarations reach every consumer of `@bascik/language-server/server` through
 * `typescript-engine.d.ts`, so a production source must name the `typescript` peer, never the repo's
 * `typescript-6` test alias, or the package's types fail to resolve where they are installed.
 */
describe("published types", () => {
  it("name the typescript peer, not the typescript-6 test alias, in production sources", () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url));
    const offenders = fs
      .readdirSync(srcDir)
      .filter(
        (name) =>
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts") &&
          !name.endsWith(".test.util.ts"),
      )
      .filter((name) =>
        fs
          .readFileSync(path.join(srcDir, name), "utf8")
          .includes("typescript-6"),
      );
    expect(offenders).toEqual([]);
  });
});
