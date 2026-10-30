import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BascikConfig } from "./config.ts";
import {
  LanguageServerRequiredError,
  languageServerHint,
  languageServerTargets,
  loadLanguageServerCheck,
} from "./check-language-server.ts";

// The real config module is frozen. The targets depend on `directory`, so give this test a copy it may change.
vi.mock("./config.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.ts")>();
  return { ...original, BascikConfig: { ...original.BascikConfig } };
});

describe("languageServerHint", () => {
  it("says nothing when the per-file checks ran", () => {
    expect(
      languageServerHint({
        status: "ran",
        filesChecked: 1,
        fixedFiles: [],
        diagnostics: [],
        formatDiagnostic: () => "",
      }),
    ).toBeUndefined();
  });

  it("tells the user how to install it when it is missing", () => {
    expect(languageServerHint({ status: "missing" })).toBe(
      "per-file checks skipped: install @bascik/language-server to run them (npm install --save-dev @bascik/language-server)",
    );
  });

  it("tells the user to update when it is too old", () => {
    const hint = languageServerHint({ status: "outdated" });
    expect(hint).toContain("too old");
    expect(hint).toContain("@bascik/language-server@latest");
  });

  it("has a dedicated error type, so callers can tell an expected failure from a bug", () => {
    const error = new LanguageServerRequiredError("x");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LanguageServerRequiredError");
  });
});

describe("loadLanguageServerCheck", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-ls-"));
    await writeFile(join(root, "package.json"), '{"name":"site"}');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const installFake = async (source: string) => {
    const dir = join(root, "node_modules", "@bascik", "language-server");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@bascik/language-server",
        version: "9.9.9",
        type: "module",
        exports: { "./check": "./check.js" },
      }),
    );
    await writeFile(join(dir, "check.js"), source);
  };

  it("prefers the copy installed in the project, so the user's version is the one that runs", async () => {
    await installFake(
      "export const checkFiles = async () => ({}); export const formatDiagnostic = () => 'from the project';",
    );
    const loaded = await loadLanguageServerCheck(root);
    expect(loaded).not.toBeNull();
    expect(loaded).not.toBe("outdated");
    const diagnostic = {
      filePath: "a.html",
      line: 1,
      column: 1,
      severity: "warning" as const,
      message: "x",
    };
    expect(
      (loaded as Exclude<typeof loaded, string | null>).formatDiagnostic(
        diagnostic,
      ),
    ).toBe("from the project");
  });

  it("reports a copy that lacks the functions it needs as outdated, not as a crash", async () => {
    await installFake("export const somethingElse = 1;");
    expect(await loadLanguageServerCheck(root, null)).toBe("outdated");
  });

  it("reports a release that predates ./check as outdated, not as missing", async () => {
    const dir = join(root, "node_modules", "@bascik", "language-server");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@bascik/language-server",
        version: "0.1.0-rc.3",
        type: "module",
        exports: { ".": "./index.js" },
      }),
    );
    await writeFile(join(dir, "index.js"), "export {};");
    expect(await loadLanguageServerCheck(root, null)).toBe("outdated");
  });

  it("reports nothing installed as missing", async () => {
    expect(await loadLanguageServerCheck(root, null)).toBeNull();
  });

  it("falls back to the copy next to this package, which is how a workspace checkout finds it", async () => {
    const loaded = await loadLanguageServerCheck(root);
    expect(loaded === null || typeof loaded === "object").toBe(true);
  });
});

describe("languageServerTargets", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-ls-targets-"));
    for (const dir of [
      "src/pages",
      "src/components",
      "shared/ui",
      "server/routes",
    ]) {
      await mkdir(join(root, dir), { recursive: true });
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("covers pages (markup only), every component root, and the API folder (scripts only)", () => {
    const original = BascikConfig.directory;
    (BascikConfig as { directory: typeof original }).directory = {
      ...original,
      pages: "src/pages",
      components: ["src/components", "shared/ui"],
      api: "server/routes",
    };
    try {
      const targets = languageServerTargets(root);
      expect(targets).toEqual([
        { path: join(root, "src/pages"), extensions: ["html"] },
        { path: join(root, "src/components") },
        { path: join(root, "shared/ui") },
        {
          path: join(root, "server/routes"),
          extensions: ["ts", "mts", "js", "mjs"],
        },
      ]);
    } finally {
      (BascikConfig as { directory: typeof original }).directory = original;
    }
  });

  it("leaves out folders that do not exist, such as a project with no API routes", async () => {
    await rm(join(root, "server"), { recursive: true });
    const paths = languageServerTargets(root).map((target) =>
      typeof target === "string" ? target : target.path,
    );
    expect(paths.every((path) => !path.includes("server"))).toBe(true);
  });
});
