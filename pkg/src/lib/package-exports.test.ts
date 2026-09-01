import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("package exports surface", () => {
  it("exposes root and config exports without wildcard leakage", async () => {
    const pkgJsonPath = join(process.cwd(), "package.json");
    const raw = await readFile(pkgJsonPath, "utf8");
    const pkg = JSON.parse(raw) as {
      exports?: Record<string, unknown>;
      types?: string;
      files?: string[];
    };

    expect(pkg.exports).toBeTruthy();
    expect(pkg.exports).toHaveProperty(".");
    expect(pkg.exports).toHaveProperty("./config");
    expect(pkg.exports).not.toHaveProperty("./*");
    expect(pkg.types).toBe("./dist/lib/defineConfig.d.ts");
    expect(pkg.files).not.toContain("src/");
  });
});
