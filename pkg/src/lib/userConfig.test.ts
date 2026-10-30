import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// userConfig.ts loads via loadUserConfig() using a real dynamic import of a
// file:// URL.  We exercise it with real temp config files — mocking a file://
// specifier is unreliable, and a real file round-trip is the honest test.
// ─────────────────────────────────────────────────────────────────────────────

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const writeConfig = async (
  contents: string,
  name = "bascik.config.js",
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
  dirs.push(dir);
  const p = join(dir, name);
  await writeFile(p, contents, "utf8");
  return p;
};

describe("loadUserConfig", () => {
  it("loads default and build exports from the file", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(
      `export default { scopeScriptBlocks: false };
       export const build = { minify: { css: false } };`,
    );
    const { config, build } = await loadUserConfig(p);
    expect(config).toEqual({ scopeScriptBlocks: false });
    expect(build).toEqual({ minify: { css: false } });
  });

  it("defaults missing exports to empty objects", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(`export const somethingElse = 1;`);
    const { config, build } = await loadUserConfig(p);
    expect(config).toEqual({});
    expect(build).toEqual({});
  });

  it("handles primitive or null exports cleanly", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(
      `export default null; export const build = "invalid";`,
    );
    const { config, build } = await loadUserConfig(p);
    expect(config).toEqual({});
    expect(build).toEqual({});
  });

  it("returns empty config silently when the file does not exist", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config } = await loadUserConfig("/nonexistent/bascik.config.js");
    expect(config).toEqual({});
    // Zero-config is the default posture: a missing config is not a problem,
    // so no warning fires. A warning should mean something is wrong.
    expect(warn).not.toHaveBeenCalled();
  });

  it("surfaces an ENOENT thrown from inside the config, not the no-config path", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = await writeConfig(
      `import { readFileSync } from "node:fs";
       readFileSync("./data/site.json", "utf8");
       export default {};`,
    );
    // The config file exists but readFileSync inside it hit a missing file.
    // That real ENOENT must propagate with its message; it must never be
    // misreported as "no config found" and defaults silently applied.
    await expect(loadUserConfig(p)).rejects.toThrow(/ENOENT/);
    await expect(loadUserConfig(p)).rejects.toThrow(
      /Failed to load bascik\.config/,
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("No bascik.config found"),
    );
  });

  it("includes the config file path when the config throws", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(`throw new Error("boom inside config");`);
    await expect(loadUserConfig(p)).rejects.toThrow(/boom inside config/);
    await expect(loadUserConfig(p)).rejects.toThrow(p);
  });

  it("throws (not process.exit) when the config file fails to load", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(`this is not valid javascript {{{`);
    await expect(loadUserConfig(p)).rejects.toThrow(
      /Failed to load bascik\.config/,
    );
  });

  it("imports via a file:// URL (Windows-safe)", async () => {
    // importUserConfig must convert to a file URL — importing a bare absolute
    // path fails with ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows.
    const { importUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(`export default { cacheHttp: true };`);
    const mod = await importUserConfig(p);
    expect(mod.default).toEqual({ cacheHttp: true });
  });

  it("loads a bascik.config.ts file (Node 22.22+ strips types natively)", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    const p = join(dir, "bascik.config.ts");
    await writeFile(
      p,
      `const cfg: Record<string, unknown> = { scopeScriptBlocks: false }; export default cfg;`,
      "utf8",
    );
    const { config } = await loadUserConfig(p);
    expect(config).toEqual({ scopeScriptBlocks: false });
  });

  it("loads a bascik.config.mjs file", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(
      `export default { scopeScriptBlocks: false };
       export const dev = { cacheHttp: false };`,
      "bascik.config.mjs",
    );
    const { config, dev } = await loadUserConfig(p);
    expect(config).toEqual({ scopeScriptBlocks: false });
    expect(dev).toEqual({ cacheHttp: false });
  });

  it("treats a bascik.config.mjs without a default export like a .js one: empty config", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const mjs = await writeConfig(
      `export const build = { minify: { css: false } };`,
      "bascik.config.mjs",
    );
    const js = await writeConfig(
      `export const build = { minify: { css: false } };`,
    );
    const fromMjs = await loadUserConfig(mjs);
    expect(fromMjs).toEqual(await loadUserConfig(js));
    expect(fromMjs.config).toEqual({});
    expect(fromMjs.build).toEqual({ minify: { css: false } });
  });

  // Under vitest a config import goes through vite's transform, which
  // reports syntax errors its own way, so these spawn plain Node to exercise
  // the real import path (as the enum test below does).
  const buildProject = (dir: string, args: string[] = []) =>
    spawnSync(
      process.execPath,
      [
        join(dirname(fileURLToPath(import.meta.url)), "../index.ts"),
        "--build",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    );

  it("names the file, line, and offending token for a syntax error in bascik.config.mjs", async () => {
    const p = await writeConfig(
      `export default {\n  minify: true,\n  this is bad\n};\n`,
      "bascik.config.mjs",
    );
    const result = buildProject(dirname(p));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to load bascik.config");
    expect(result.stderr).toContain(`${p}:3`);
    expect(result.stderr).toContain("  this is bad\n       ^^");
    expect(result.stderr).toContain("Unexpected identifier 'is'");
  }, 30000);

  it("names the line of a syntax error in bascik.config.js and in a --config file", async () => {
    const js = await writeConfig(`export default {\n  a: 1,,\n};\n`);
    const fromJs = buildProject(dirname(js));
    expect(fromJs.status).toBe(1);
    expect(fromJs.stderr).toContain(`${js}:2`);

    const custom = await writeConfig(
      `export default {\n\n  a: 1,,\n};\n`,
      "site.config.mjs",
    );
    const fromFlag = buildProject(dirname(custom), [
      "--config",
      "site.config.mjs",
    ]);
    expect(fromFlag.status).toBe(1);
    expect(fromFlag.stderr).toContain(`${custom}:3`);
  }, 30000);

  it("locates a syntax error in a CommonJS bascik.config.js at its real line", async () => {
    // With no "type" in package.json a .js config loads as CommonJS, where
    // sloppy-mode syntax such as a legacy octal literal is legal. Checking it
    // as a module would stop at line 1 instead of the real error on line 3.
    const p = await writeConfig(
      `const mode = 0755;\nmodule.exports = {\n  this is bad\n};\n`,
    );
    await writeFile(join(dirname(p), "package.json"), `{"name":"c"}`, "utf8");
    const result = buildProject(dirname(p));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected identifier 'is'");
    expect(result.stderr).toContain(`${p}:3`);
    expect(result.stderr).toContain("  this is bad\n       ^^");
    expect(result.stderr).not.toContain(`${p}:1`);
  }, 30000);

  it("names the loaded file, not bascik.config.ts, in configuration errors", async () => {
    const mjs = await writeConfig(
      `export default { http: { port: 70000 } };`,
      "bascik.config.mjs",
    );
    const fromMjs = buildProject(dirname(mjs));
    expect(fromMjs.status).toBe(1);
    expect(fromMjs.stderr).toContain(
      "Configuration errors in bascik.config.mjs",
    );
    expect(fromMjs.stderr).not.toContain("bascik.config.ts");

    const custom = await writeConfig(
      `export default { http: { port: 70000 } };`,
      "site.config.mjs",
    );
    const fromFlag = buildProject(dirname(custom), [
      "--config",
      "site.config.mjs",
    ]);
    expect(fromFlag.status).toBe(1);
    expect(fromFlag.stderr).toContain(
      "Configuration errors in site.config.mjs",
    );
  }, 30000);

  it("keeps the plain message when the config parses but an import does not link", async () => {
    // A SyntaxError raised while linking (a missing named export) is not a
    // parse error in the config itself, so there is no line to add.
    const p = await writeConfig(
      `import { nope } from "node:path";\nexport default { nope };\n`,
      "bascik.config.mjs",
    );
    const result = buildProject(dirname(p));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to load bascik.config");
    expect(result.stderr).toMatch(/does not provide an export named 'nope'/);
    expect(result.stderr).not.toContain(`${p}:`);
  }, 30000);

  it("handles non-Error exceptions when loading config file fails", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(`throw "custom string error";`);
    await expect(loadUserConfig(p)).rejects.toThrow("custom string error");
  });

  it("rejects a siteUrl key in the default export with a teaching error", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(
      `export default { siteUrl: 'https://example.com' };`,
    );
    await expect(loadUserConfig(p)).rejects.toThrow(
      /`siteUrl` is not a bascik\.config option/,
    );
    await expect(loadUserConfig(p)).rejects.toThrow(/BASCIK_SITE_URL/);
  });

  it("rejects a siteUrl key in a mode export", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const p = await writeConfig(
      `export const build = { siteUrl: 'https://example.com' };`,
    );
    await expect(loadUserConfig(p)).rejects.toThrow(
      /`siteUrl` is not a bascik\.config option/,
    );
  });

  it("produces a comprehensible error for non-erasable TypeScript syntax", async () => {
    // Node's type stripping only handles erasable syntax. An `enum` is a
    // runtime construct; the user must get a comprehensible failure, not a
    // raw Node crash with no context. Under vitest the import goes through
    // vite's transform (which supports enums), so this spawns plain Node to
    // exercise the real strip-only path.
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "bascik.config.ts"),
      `enum Mode { Fast }\nexport default { mode: Mode.Fast };`,
      "utf8",
    );
    const cliPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../index.ts",
    );
    const result = spawnSync(process.execPath, [cliPath, "--build"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to load bascik.config");
    expect(result.stderr).toMatch(/enum/i);
  }, 30000);
});

describe("checkOutputLocation", () => {
  const configPath = "C:\\Users\\me\\site\\bascik.config.js";
  const output = (eol: string) =>
    [
      `${configPath}:3`,
      "  this is bad",
      "       ^^",
      "",
      "SyntaxError: Unexpected identifier 'is'",
      "    at wrapSafe (node:internal/modules/cjs/loader:1)",
    ].join(eol);

  it("reads the file, line, source and caret from node --check output", async () => {
    const { checkOutputLocation } = await import("./userConfig.ts");
    expect(
      checkOutputLocation(
        output("\n"),
        configPath,
        "Unexpected identifier 'is'",
      ),
    ).toBe(`${configPath}:3\n  this is bad\n       ^^`);
  });

  it("reads Windows output, where node --check ends lines with CRLF", async () => {
    const { checkOutputLocation } = await import("./userConfig.ts");
    expect(
      checkOutputLocation(
        output("\r\n"),
        configPath,
        "Unexpected identifier 'is'",
      ),
    ).toBe(`${configPath}:3\n  this is bad\n       ^^`);
  });

  it("gives nothing when the output is about another file or another error", async () => {
    const { checkOutputLocation } = await import("./userConfig.ts");
    expect(
      checkOutputLocation(
        output("\n"),
        "C:\\other.js",
        "Unexpected identifier 'is'",
      ),
    ).toBe("");
    expect(
      checkOutputLocation(output("\n"), configPath, "Unexpected token '}'"),
    ).toBe("");
  });
});

describe("resolveConfigPath", () => {
  it("prefers bascik.config.js over bascik.config.ts when both exist", async () => {
    const { resolveConfigPath } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "bascik.config.js"),
      `export default {};`,
      "utf8",
    );
    await writeFile(
      join(dir, "bascik.config.ts"),
      `export default {};`,
      "utf8",
    );
    const { path, explicit } = await resolveConfigPath([], dir);
    expect(path).toBe(join(dir, "bascik.config.js"));
    expect(explicit).toBe(false);
  });

  it("discovers bascik.config.mjs when it is the only config", async () => {
    const { resolveConfigPath } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    await writeFile(join(dir, "bascik.config.mjs"), `export default {};`);
    const { path, explicit } = await resolveConfigPath([], dir);
    expect(path).toBe(join(dir, "bascik.config.mjs"));
    expect(explicit).toBe(false);
  });

  it("orders discovery .js, then .mjs, then .ts", async () => {
    const { resolveConfigPath, CONFIG_FILE_NAMES } =
      await import("./userConfig.ts");
    expect(CONFIG_FILE_NAMES).toEqual([
      "bascik.config.js",
      "bascik.config.mjs",
      "bascik.config.ts",
    ]);
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    await writeFile(join(dir, "bascik.config.mjs"), `export default {};`);
    await writeFile(join(dir, "bascik.config.ts"), `export default {};`);
    expect((await resolveConfigPath([], dir)).path).toBe(
      join(dir, "bascik.config.mjs"),
    );
    await writeFile(join(dir, "bascik.config.js"), `export default {};`);
    expect((await resolveConfigPath([], dir)).path).toBe(
      join(dir, "bascik.config.js"),
    );
  });

  it("honors --config with an .mjs path", async () => {
    const { resolveConfigPath, loadUserConfig } =
      await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "site.config.mjs"),
      `export default { cacheHttp: true };`,
    );
    const resolved = await resolveConfigPath(
      ["--config", "site.config.mjs"],
      dir,
    );
    expect(resolved).toEqual({
      path: join(dir, "site.config.mjs"),
      explicit: true,
    });
    const { config } = await loadUserConfig(resolved.path, {
      explicit: true,
    });
    expect(config).toEqual({ cacheHttp: true });
  });

  it("findConfigFile reports no file, a --config missing its value, and the discovered name", async () => {
    // config.ts and check.ts name the config from this synchronous lookup,
    // so it must agree with resolveConfigPath.
    const { findConfigFile } = await import("./config-file-names.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    expect(findConfigFile([], dir)).toEqual({
      path: undefined,
      explicit: false,
    });
    // `--config` followed by another flag has no value: not explicit.
    expect(findConfigFile(["--config", "--build"], dir)).toEqual({
      path: undefined,
      explicit: false,
    });
    await writeFile(join(dir, "bascik.config.mjs"), `export default {};`);
    expect(findConfigFile(["--build"], dir)).toEqual({
      path: join(dir, "bascik.config.mjs"),
      explicit: false,
    });
  });

  it("falls back to bascik.config.ts when no .js file exists", async () => {
    const { resolveConfigPath } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    const { path, explicit } = await resolveConfigPath([], dir);
    expect(path).toBe(join(dir, "bascik.config.ts"));
    expect(explicit).toBe(false);
  });

  it("honors --config <path> as an explicit location", async () => {
    const { resolveConfigPath } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    const { path, explicit } = await resolveConfigPath(
      ["--config", "conf/custom.js"],
      dir,
    );
    expect(path).toBe(join(dir, "conf/custom.js"));
    expect(explicit).toBe(true);
  });

  it("honors --config=<path> inline form", async () => {
    const { resolveConfigPath } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    const { path, explicit } = await resolveConfigPath(
      ["--config=conf/custom.ts"],
      dir,
    );
    expect(path).toBe(join(dir, "conf/custom.ts"));
    expect(explicit).toBe(true);
  });

  it("errors when an explicit --config path does not exist", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    await expect(
      loadUserConfig("/nonexistent/custom.config.js", { explicit: true }),
    ).rejects.toThrow(/does not exist/);
  });

  it("lists every discoverable filename in the missing --config error", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    await expect(
      loadUserConfig("/nonexistent/custom.config.mjs", { explicit: true }),
    ).rejects.toThrow(
      /bascik\.config\.js, \.\/bascik\.config\.mjs, or \.\/bascik\.config\.ts/,
    );
  });
});
