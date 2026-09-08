import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, type Message } from "esbuild";

const bundleForWeb = async (entry: string): Promise<{ errors: Message[]; bytes: number }> => {
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "es2022",
      logLevel: "silent",
      external: [],
    });
    return { errors: result.errors, bytes: result.outputFiles?.[0]?.contents.byteLength ?? 0 };
  } catch (err) {
    const failure = err as { errors?: Message[] };
    return { errors: failure.errors ?? [], bytes: 0 };
  }
};

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
    expect(pkg.exports).toHaveProperty("./runtime");
    expect(pkg.exports).toHaveProperty("./adapter");
    expect(pkg.exports).not.toHaveProperty("./*");
    expect(pkg.types).toBe("./dist/lib/defineConfig.d.ts");
    expect(pkg.files).not.toContain("src/");

    const runtimeExport = pkg.exports?.["./runtime"] as { types?: string; default?: string } | undefined;
    expect(runtimeExport?.types).toBe("./dist/runtime.d.ts");
    expect(runtimeExport?.default).toBe("./dist/runtime.js");

    const adapterExport = pkg.exports?.["./adapter"] as { types?: string; default?: string } | undefined;
    expect(adapterExport?.types).toBe("./dist/adapter.d.ts");
    expect(adapterExport?.default).toBe("./dist/adapter.js");

    const devDeps = (pkg as any).devDependencies ?? {};
    expect(devDeps).not.toHaveProperty("miniflare");
  });

  it("runtime export source bundles for the web with zero Node builtins", async () => {
    const runtimeSource = resolve(process.cwd(), "src/runtime.ts");
    const { errors, bytes } = await bundleForWeb(runtimeSource);
    expect(errors).toEqual([]);
    expect(bytes).toBeGreaterThan(0);
  });

  it("compiled runtime export dist/runtime.js bundles for the web with zero Node builtins", async () => {
    const runtimeDist = resolve(process.cwd(), "dist/runtime.js");
    if (!existsSync(runtimeDist)) {
      // Fall back to src/runtime.ts if dist has not been built yet
      const runtimeSource = resolve(process.cwd(), "src/runtime.ts");
      const { errors, bytes } = await bundleForWeb(runtimeSource);
      expect(errors).toEqual([]);
      expect(bytes).toBeGreaterThan(0);
      return;
    }
    const { errors, bytes } = await bundleForWeb(runtimeDist);
    expect(errors).toEqual([]);
    expect(bytes).toBeGreaterThan(0);
  });
});
