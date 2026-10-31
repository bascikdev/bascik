import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build, type Message } from "esbuild";

const bundleForWeb = async (
  entry: string,
): Promise<{ errors: Message[]; bytes: number }> => {
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
    return {
      errors: result.errors,
      bytes: result.outputFiles?.[0]?.contents.byteLength ?? 0,
    };
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

    const runtimeExport = pkg.exports?.["./runtime"] as
      { types?: string; default?: string } | undefined;
    expect(runtimeExport?.types).toBe("./dist/runtime.d.ts");
    expect(runtimeExport?.default).toBe("./dist/runtime.js");

    const adapterExport = pkg.exports?.["./adapter"] as
      { types?: string; default?: string } | undefined;
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

// ─── @bascik/bascik/html (safety helpers for server and stream scripts) ─────

const bundleHtml = async (
  entry: string,
  platform: "browser" | "neutral",
): Promise<{ errors: Message[]; minified: number; text: string }> => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform,
    format: "esm",
    target: "es2022",
    minify: true,
    logLevel: "silent",
  });
  const text = result.outputFiles?.[0]?.text ?? "";
  return {
    errors: result.errors,
    minified: Buffer.byteLength(text),
    text,
  };
};

describe("@bascik/bascik/html export", () => {
  it("is declared with types and default, like the other subpaths", async () => {
    const pkg = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as { exports: Record<string, { types?: string; default?: string }> };
    expect(pkg.exports["./html"]).toEqual({
      types: "./dist/html.d.ts",
      default: "./dist/html.js",
    });
  });

  it("src/html.ts exports exactly the documented API", async () => {
    const mod = await import("../html.ts");
    expect(Object.keys(mod).sort()).toEqual(
      ["HtmlError", "esc", "html", "isHtml", "json", "raw", "safeUrl"].sort(),
    );
  });

  it("is not re-exported from ./runtime (scripts import it by its own subpath)", async () => {
    const runtime = await import("../runtime.ts");
    expect(runtime).not.toHaveProperty("html");
    expect(runtime).not.toHaveProperty("safeUrl");
  });

  it.each(["browser", "neutral"] as const)(
    "src/html.ts bundles for platform %s with zero node: imports and stays under 9 KB gzipped",
    async (platform) => {
      const { errors, minified, text } = await bundleHtml(
        resolve(process.cwd(), "src/html.ts"),
        platform,
      );
      expect(errors).toEqual([]);
      expect(text).not.toMatch(/["']node:/);
      expect(minified).toBeGreaterThan(0);
      // About 4 KB of the minified size is the located error messages
      // (template, hole, why and the fix), which are part of the API. The
      // parser-differential readings (raw-text bodies as markup, foreign
      // content as HTML) added about 1.5 KB in the red-team fix pass, and
      // the tree builder's end-tag rule for foreign content, <plaintext> as
      // markup and the unconvertible-value and array-depth errors about
      // 1.2 KB in the second one.
      expect(minified).toBeLessThanOrEqual(22 * 1024);
      expect(gzipSync(text).byteLength).toBeLessThanOrEqual(9 * 1024);
    },
  );

  it("dist/html.js (when built) bundles for the web with zero node: imports", async () => {
    const dist = resolve(process.cwd(), "dist/html.js");
    if (!existsSync(dist)) return;
    const { errors, text } = await bundleHtml(dist, "browser");
    expect(errors).toEqual([]);
    expect(text).not.toMatch(/["']node:/);
  });

  it("the html module graph is html.ts, html-template.ts and url-safety.ts only", async () => {
    const result = await build({
      entryPoints: [resolve(process.cwd(), "src/html.ts")],
      bundle: true,
      write: false,
      metafile: true,
      platform: "neutral",
      format: "esm",
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile!.inputs)
      .map((p) => p.replace(/^.*src\//, "src/"))
      .sort();
    expect(inputs).toEqual([
      "src/html.ts",
      "src/lib/html-template.ts",
      "src/lib/url-safety.ts",
    ]);
  });
});

describe("package files list", () => {
  const readManifest = async () =>
    JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      files: string[];
      bin: string | Record<string, string>;
      scripts: Record<string, string>;
    };

  // npm silently skips a `files` entry that matches nothing, so a stale entry
  // (CHANGELOG.md before 1.0.0) advertises a file the tarball never has.
  // Every entry other than the built dist/ must exist in pkg/ or be copied in
  // by `prepack`.
  it("lists only files that exist in pkg/ or that prepack creates", async () => {
    const pkg = await readManifest();
    const prepack = pkg.scripts.prepack ?? "";
    const missing = pkg.files.filter(
      (entry) =>
        entry !== "dist/" &&
        !existsSync(join(process.cwd(), entry)) &&
        !new RegExp(
          `\\s${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`,
        ).test(prepack),
    );
    expect(missing).toEqual([]);
  });

  // bin/ also holds repo-maintenance scripts (code-map.mjs, the coverage
  // updaters) that reference folders an install does not have.
  it("ships only the CLI entry from bin/, not the maintenance scripts", async () => {
    const pkg = await readManifest();
    const binTargets = (
      typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin)
    ).map((target) => target.replace(/^\.\//, ""));
    const binEntries = pkg.files.filter((entry) => entry.startsWith("bin"));
    expect(binEntries.sort()).toEqual(binTargets.sort());
    for (const target of binTargets) {
      expect(existsSync(join(process.cwd(), target)), target).toBe(true);
    }
  });
});
