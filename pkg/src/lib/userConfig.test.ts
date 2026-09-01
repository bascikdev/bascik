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

const writeConfig = async (contents: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
  dirs.push(dir);
  const p = join(dir, "bascik.config.js");
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
    const p = await writeConfig(`export default null; export const build = "invalid";`);
    const { config, build } = await loadUserConfig(p);
    expect(config).toEqual({});
    expect(build).toEqual({});
  });

  it("returns empty config silently when the file does not exist", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    const { config } = await loadUserConfig("/nonexistent/bascik.config.js");
    expect(config).toEqual({});
    // Zero-config is the default posture: a missing config is not a problem,
    // so no warning fires. A warning should mean something is wrong.
    expect(warn).not.toHaveBeenCalled();
  });

  it("surfaces an ENOENT thrown from inside the config, not the no-config path", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
    const p = await writeConfig(
      `import { readFileSync } from "node:fs";
       readFileSync("./data/site.json", "utf8");
       export default {};`,
    );
    // The config file exists but readFileSync inside it hit a missing file.
    // That real ENOENT must propagate with its message; it must never be
    // misreported as "no config found" and defaults silently applied.
    await expect(loadUserConfig(p)).rejects.toThrow(/ENOENT/);
    await expect(loadUserConfig(p)).rejects.toThrow(/Failed to load bascik\.config/);
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

  it("loads a bascik.config.ts file (Node 22.18+ strips types natively)", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    const p = join(dir, "bascik.config.ts");
    await writeFile(p, `const cfg: Record<string, unknown> = { scopeScriptBlocks: false }; export default cfg;`, "utf8");
    const { config } = await loadUserConfig(p);
    expect(config).toEqual({ scopeScriptBlocks: false });
  });

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
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), "../index.ts");
    const result = spawnSync(process.execPath, [cliPath, "--build"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to load bascik.config");
    expect(result.stderr).toMatch(/enum/i);
  }, 30000);
});

describe("resolveConfigPath", () => {
  it("prefers bascik.config.js over bascik.config.ts when both exist", async () => {
    const { resolveConfigPath } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    await writeFile(join(dir, "bascik.config.js"), `export default {};`, "utf8");
    await writeFile(join(dir, "bascik.config.ts"), `export default {};`, "utf8");
    const { path, explicit } = await resolveConfigPath([], dir);
    expect(path).toBe(join(dir, "bascik.config.js"));
    expect(explicit).toBe(false);
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
    const { path, explicit } = await resolveConfigPath(["--config", "conf/custom.js"], dir);
    expect(path).toBe(join(dir, "conf/custom.js"));
    expect(explicit).toBe(true);
  });

  it("honors --config=<path> inline form", async () => {
    const { resolveConfigPath } = await import("./userConfig.ts");
    const dir = await mkdtemp(join(tmpdir(), "bascik-cfg-"));
    dirs.push(dir);
    const { path, explicit } = await resolveConfigPath(["--config=conf/custom.ts"], dir);
    expect(path).toBe(join(dir, "conf/custom.ts"));
    expect(explicit).toBe(true);
  });

  it("errors when an explicit --config path does not exist", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    await expect(
      loadUserConfig("/nonexistent/custom.config.js", { explicit: true }),
    ).rejects.toThrow(/does not exist/);
  });
});
