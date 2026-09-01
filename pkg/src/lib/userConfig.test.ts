import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("returns empty config (with a warning) when the file does not exist", async () => {
    const { loadUserConfig } = await import("./userConfig.ts");
    vi.spyOn(console, "warn").mockImplementation(() => { });
    const { config } = await loadUserConfig("/nonexistent/bascik.config.js");
    expect(config).toEqual({});
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("No bascik.config found"),
    );
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
});
