import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { resolveCliAction, CLI_USAGE } from "./lib/cli.ts";

describe("resolveCliAction", () => {
  it("starts the dev server when called with no args", () => {
    expect(resolveCliAction([])).toEqual({ action: "dev" });
  });

  it("maps --help to help", () => {
    expect(resolveCliAction(["--help"])).toEqual({ action: "help" });
  });

  it("maps -h to help", () => {
    expect(resolveCliAction(["-h"])).toEqual({ action: "help" });
  });

  it("maps --version to version", () => {
    expect(resolveCliAction(["--version"])).toEqual({ action: "version" });
  });

  it("maps -v to version", () => {
    expect(resolveCliAction(["-v"])).toEqual({ action: "version" });
  });

  it("maps init to init", () => {
    expect(resolveCliAction(["init"])).toEqual({ action: "init" });
  });

  it("maps --check to check", () => {
    expect(resolveCliAction(["--check"])).toEqual({ action: "check" });
  });

  it("maps --serve to serve", () => {
    expect(resolveCliAction(["--serve"])).toEqual({ action: "prodServer" });
  });

  it("maps --build to build", () => {
    expect(resolveCliAction(["--build"])).toEqual({ action: "build" });
  });

  it("accepts --log alongside --build", () => {
    expect(resolveCliAction(["--build", "--log"])).toEqual({ action: "build" });
  });

  it("accepts --log with a custom path", () => {
    expect(resolveCliAction(["--build", "--log", "./logs/build.log"])).toEqual({
      action: "build",
    });
  });

  it("returns error with the offending flag for a single unknown flag", () => {
    expect(resolveCliAction(["--frobnicate"])).toEqual({
      action: "error",
      unknownFlags: ["--frobnicate"],
    });
  });

  it("collects multiple unknown flags", () => {
    expect(resolveCliAction(["--nope", "-x"])).toEqual({
      action: "error",
      unknownFlags: ["--nope", "-x"],
    });
  });

  it("treats unknown short flags as errors", () => {
    expect(resolveCliAction(["-z"]).action).toBe("error");
  });

  it("errors on unknown flags even when a known flag is also present", () => {
    expect(resolveCliAction(["--build", "--bogus"])).toEqual({
      action: "error",
      unknownFlags: ["--bogus"],
    });
  });

  it("prefers help over other known flags", () => {
    expect(resolveCliAction(["--build", "--help"])).toEqual({ action: "help" });
  });

  it("prefers version over other known flags", () => {
    expect(resolveCliAction(["--serve", "-v"])).toEqual({ action: "version" });
  });

  it("accepts init alongside a known flag", () => {
    expect(resolveCliAction(["init", "--check"])).toEqual({ action: "init" });
  });

  it("ignores non-flag positional args", () => {
    expect(resolveCliAction(["somepath"])).toEqual({ action: "dev" });
  });
});

describe("CLI_USAGE", () => {
  it("documents all recognized flags and the init subcommand", () => {
    for (const token of [
      "--build",
      "--serve",
      "--check",
      "--help",
      "-h",
      "--version",
      "-v",
      "init",
    ]) {
      expect(CLI_USAGE).toContain(token);
    }
  });
});

describe("index.ts CLI runner functions", () => {
  it("readVersion returns valid version from package.json or unknown on failure", async () => {
    const { readVersion } = await import("./index.ts");
    const ver = await readVersion();
    expect(typeof ver).toBe("string");
    expect(ver.length).toBeGreaterThan(0);

    const fallbackVer = await readVersion("/non/existent/path/for/test");
    expect(fallbackVer).toBe("unknown");
  });

  it("resolveBuildLogPath resolves default or custom log paths", async () => {
    const { resolveBuildLogPath } = await import("./index.ts");
    expect(resolveBuildLogPath(["--build"])).toBeUndefined();
    expect(resolveBuildLogPath(["--build", "--log"])).toBe(".bascik/build.log");
    expect(resolveBuildLogPath(["--build", "--log", "custom.log"])).toBe("custom.log");
  });

  it("runCli handles help and version flags", async () => {
    const { runCli } = await import("./index.ts");
    const helpRes = await runCli(["--help"], { exitOnFinish: false });
    expect(helpRes).toEqual({ action: "help", exitCode: 0 });

    const verRes = await runCli(["--version"], { exitOnFinish: false });
    expect(verRes).toEqual({ action: "version", exitCode: 0 });
  });

  it("runCli handles unknown flags with error", async () => {
    const { runCli } = await import("./index.ts");
    const errRes = await runCli(["--unknown-flag"], { exitOnFinish: false });
    expect(errRes).toEqual({ action: "error", exitCode: 1 });
  });

  it("setupBuildLogging creates log directory and tees console logs", async () => {
    const { setupBuildLogging } = await import("./index.ts");
    const tmpLogPath = join(tmpdir(), "bascik-test-logs", "build.log");
    const path = await setupBuildLogging(tmpLogPath);
    expect(path).toContain("build.log");

    console.log("Log test message");
    console.warn("Warn test message");
    console.error("Error test message");

    await rm(dirname(tmpLogPath), { recursive: true, force: true }).catch(() => { });
  });

  it("runCli executes subcommands init, check, prodServer, and dev/build", async () => {
    const { runCli } = await import("./index.ts");

    const initSpy = vi.spyOn(await import("./lib/init.ts"), "initProject").mockResolvedValueOnce(undefined);
    const checkSpy = vi.spyOn(await import("./lib/check.ts"), "checkProject").mockResolvedValueOnce(true);
    const serveSpy = vi.spyOn(await import("./lib/serve.ts"), "serveProduction").mockResolvedValueOnce("http://localhost:8080");
    const transpileSpy = vi.spyOn(await import("./transpile.ts"), "runTranspile").mockResolvedValue(undefined);

    const initRes = await runCli(["init"], { exitOnFinish: false });
    expect(initRes.action).toBe("init");
    expect(initSpy).toHaveBeenCalled();

    const checkRes = await runCli(["--check"], { exitOnFinish: false });
    expect(checkRes.action).toBe("check");
    expect(checkSpy).toHaveBeenCalled();

    const serveRes = await runCli(["--serve"], { exitOnFinish: false });
    expect(serveRes.action).toBe("prodServer");
    expect(serveSpy).toHaveBeenCalled();

    const buildRes = await runCli(["--build"], { exitOnFinish: false });
    expect(buildRes.action).toBe("build");
    expect(transpileSpy).toHaveBeenCalled();
  });
});

