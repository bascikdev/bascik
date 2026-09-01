import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readScripts = async (packagePath: string): Promise<Record<string, string>> => {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
};

describe("E2E script composition", () => {
  it("includes static, dev, HTTP/1.1, and HTTP/2 package modes in every all-E2E entry point", async () => {
    const rootScripts = await readScripts(resolve(process.cwd(), "../package.json"));
    const packageScripts = await readScripts(resolve(process.cwd(), "package.json"));

    expect(rootScripts["pkg:e2e:all"]).toContain("pkg:e2e:dev");
    expect(rootScripts["pkg:e2e:all"]).toContain("pkg:e2e");
    expect(rootScripts["pkg:e2e:all"]).toContain("pkg:e2e:prod");

    expect(packageScripts["e2e:all"]).toContain("e2e:dev");
    expect(packageScripts["e2e:all"]).toContain("e2e");
    expect(packageScripts["e2e:all"]).toContain("e2e:prod");
  });
});