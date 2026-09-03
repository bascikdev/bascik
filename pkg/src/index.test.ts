import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { resolveCliAction, CLI_USAGE } from "./lib/cli.ts";

describe("resolveCliAction", () => {
  it("starts the dev server when called with no args", () => {
    expect(resolveCliAction([])).toMatchObject({ action: "dev" });
  });

  it("maps --help to help", () => {
    expect(resolveCliAction(["--help"])).toMatchObject({ action: "help" });
  });

  it("maps -h to help", () => {
    expect(resolveCliAction(["-h"])).toMatchObject({ action: "help" });
  });

  it("maps --version to version", () => {
    expect(resolveCliAction(["--version"])).toMatchObject({ action: "version" });
  });

  it("maps -v to version", () => {
    expect(resolveCliAction(["-v"])).toMatchObject({ action: "version" });
  });

  it("maps init to init", () => {
    expect(resolveCliAction(["init"])).toMatchObject({ action: "init" });
  });

  it("maps --check to check", () => {
    expect(resolveCliAction(["--check"])).toMatchObject({ action: "check" });
  });

  it("maps --server to server", () => {
    expect(resolveCliAction(["--server"])).toMatchObject({ action: "server" });
  });

  it("maps --build to build", () => {
    expect(resolveCliAction(["--build"])).toMatchObject({ action: "build" });
  });

  it("accepts --log alongside --build", () => {
    expect(resolveCliAction(["--build", "--log"])).toMatchObject({ action: "build" });
  });

  it("accepts --log with a custom path", () => {
    expect(resolveCliAction(["--build", "--log", "./logs/build.log"])).toMatchObject({
      action: "build",
    });
  });

  it("returns error with the offending flag for a single unknown flag", () => {
    const decision = resolveCliAction(["--frobnicate"]);
    expect(decision.action).toBe("error");
    expect(decision.unknownFlags).toEqual(["--frobnicate"]);
    expect(decision.errorMessage).toContain("--frobnicate");
  });

  it("collects multiple unknown flags", () => {
    const decision = resolveCliAction(["--build", "--nope", "-x"]);
    expect(decision.action).toBe("error");
    expect(decision.unknownFlags).toEqual(["--nope", "-x"]);
  });

  it("treats unknown short flags as errors", () => {
    expect(resolveCliAction(["-z"]).action).toBe("error");
  });

  it("errors on unknown flags even when a known flag is also present", () => {
    const decision = resolveCliAction(["--build", "--bogus"]);
    expect(decision.action).toBe("error");
    expect(decision.unknownFlags).toEqual(["--bogus"]);
  });

  it("prefers help over other known flags", () => {
    expect(resolveCliAction(["--build", "--help"])).toMatchObject({ action: "help" });
  });

  it("prefers version over other known flags", () => {
    expect(resolveCliAction(["--server", "-v"])).toMatchObject({ action: "version" });
  });

  it("accepts init alongside a known flag", () => {
    expect(resolveCliAction(["init", "--check"])).toMatchObject({ action: "init" });
  });

  it("rejects non-flag positional args instead of silently starting the dev server", () => {
    // Regression anchor: `bascik somepath` used to fall through to a watching
    // dev server. Unknown positionals are now an error.
    const decision = resolveCliAction(["somepath"]);
    expect(decision.action).toBe("error");
    expect(decision.errorMessage).toContain('"somepath"');
  });

  it("rejects the --build --server combination", () => {
    const decision = resolveCliAction(["--build", "--server"]);
    expect(decision.action).toBe("error");
    expect(decision.errorMessage).toContain("--build");
    expect(decision.errorMessage).toContain("--server");
  });
});

describe("CLI_USAGE", () => {
  it("documents all recognized flags and the init subcommand", () => {
    for (const token of [
      "--build",
      "--server",
      "--check",
      "--help",
      "-h",
      "--version",
      "-v",
      "--log",
      "--site-url",
      "--env-file",
      "--config",
      "--port",
      "--host",
      "--log-level",
      "init",
    ]) {
      expect(CLI_USAGE).toContain(token);
    }
  });

  it("describes --server honestly (HTTP/1.1 by default, HTTP/2 with TLS)", () => {
    const serverLine = CLI_USAGE.split("\n").find((l) => l.includes("--server"));
    expect(serverLine).toBeDefined();
    expect(serverLine).toContain("HTTP/1.1");
    expect(serverLine).not.toMatch(/over HTTP\/2\b(?!.*HTTP\/1\.1)/);
  });

  it("states that --log only applies to --build", () => {
    const logIndex = CLI_USAGE.indexOf("--log [path]");
    expect(logIndex).toBeGreaterThan(-1);
    const logBlurb = CLI_USAGE.slice(logIndex, CLI_USAGE.indexOf("--port"));
    expect(logBlurb).toContain("--build");
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
    expect(resolveBuildLogPath(["--build", "--log=inline.log"])).toBe("inline.log");
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

  it("runCli executes subcommands init, check, server, and dev/build", async () => {
    const { runCli } = await import("./index.ts");

    const initSpy = vi.spyOn(await import("./lib/init.ts"), "initProject").mockResolvedValueOnce(undefined);
    const checkSpy = vi.spyOn(await import("./lib/check.ts"), "checkProject").mockResolvedValueOnce({
      errors: 0,
      warnings: 0,
      pagesChecked: 1,
      componentsChecked: 0,
      items: [],
    });
    const serveSpy = vi.spyOn(await import("./lib/serve.ts"), "serverProduction").mockResolvedValueOnce("http://localhost:8080");
    const transpileSpy = vi.spyOn(await import("./transpile.ts"), "runTranspile").mockResolvedValue(undefined);

    const initRes = await runCli(["init"], { exitOnFinish: false });
    expect(initRes.action).toBe("init");
    expect(initSpy).toHaveBeenCalled();

    const checkRes = await runCli(["--check"], { exitOnFinish: false });
    expect(checkRes.action).toBe("check");
    expect(checkRes.exitCode).toBe(0);
    expect(checkSpy).toHaveBeenCalled();

    const serveRes = await runCli(["--server"], { exitOnFinish: false });
    expect(serveRes.action).toBe("server");
    expect(serveSpy).toHaveBeenCalled();

    const buildRes = await runCli(["--build"], { exitOnFinish: false });
    expect(buildRes.action).toBe("build");
    expect(transpileSpy).toHaveBeenCalled();
  });

  it("prints a clean error (no unhandled rejection banner, no Node stack) when the config fails to load", async () => {
    // Regression anchor: a syntax error in bascik.config must surface as one
    // clean [bascik] line, not a top-level unhandled rejection with a stack.
    // Spawning the real CLI is the honest test: the bug lives at the module
    // top-level boundary, which in-process tests cannot reach.
    const dir = await mkdtemp(join(tmpdir(), "bascik-cli-err-"));
    try {
      await writeFile(
        join(dir, "bascik.config.js"),
        "this is not valid javascript {{{",
        "utf8",
      );
      const cliPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
      const result = spawnSync(process.execPath, [cliPath, "--build"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Failed to load bascik.config");
      expect(result.stderr).not.toMatch(/unhandled|Unhandled/);
      expect(result.stderr).not.toMatch(/\n\s+at\s/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("prints a clean error (no unhandled rejection banner, no Node stack) when --server finds no dist/", async () => {
    // Regression anchor: the `--server` guard message in serve.ts used to
    // surface as an unhandled top-level rejection with a full stack trace.
    const dir = await mkdtemp(join(tmpdir(), "bascik-cli-serve-"));
    try {
      const cliPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
      const result = spawnSync(process.execPath, [cliPath, "--server"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("could not read");
      expect(result.stderr).toContain("bascik --build");
      expect(result.stderr).not.toMatch(/unhandled|Unhandled/);
      expect(result.stderr).not.toMatch(/\n\s+at\s/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("runCli reports conflicting flags as a clean error", async () => {
    const { runCli } = await import("./index.ts");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    try {
      const res = await runCli(["--build", "--server"], { exitOnFinish: false });
      expect(res).toEqual({ action: "error", exitCode: 1 });
      const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toContain("--build");
      expect(printed).toContain("--server");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("runCli propagates init and check failures to the single error boundary", async () => {
    const { runCli } = await import("./index.ts");

    const initSpy = vi
      .spyOn(await import("./lib/init.ts"), "initProject")
      .mockRejectedValueOnce(new Error("init boom"));
    await expect(runCli(["init"], { exitOnFinish: false })).rejects.toThrow("init boom");
    expect(initSpy).toHaveBeenCalled();

    const checkSpy = vi
      .spyOn(await import("./lib/check.ts"), "checkProject")
      .mockRejectedValueOnce(new Error("check boom"));
    await expect(runCli(["--check"], { exitOnFinish: false })).rejects.toThrow("check boom");
    expect(checkSpy).toHaveBeenCalled();
  });

  describe("runCli --check flags (--strict, --json)", () => {
    it("exits 0 on warnings without --strict", async () => {
      const { runCli } = await import("./index.ts");
      vi.spyOn(await import("./lib/check.ts"), "checkProject").mockResolvedValueOnce({
        errors: 0,
        warnings: 2,
        pagesChecked: 1,
        componentsChecked: 1,
        items: [
          {
            category: "unmatched-tag",
            severity: "warning",
            message: "<model-viewer>",
            locations: [{ filePath: "pages/index.html", line: 1 }],
          },
        ],
      });
      const res = await runCli(["--check"], { exitOnFinish: false });
      expect(res.action).toBe("check");
      expect(res.exitCode).toBe(0);
    });

    it("exits 1 on warnings with --strict", async () => {
      const { runCli } = await import("./index.ts");
      vi.spyOn(await import("./lib/check.ts"), "checkProject").mockResolvedValueOnce({
        errors: 0,
        warnings: 1,
        pagesChecked: 1,
        componentsChecked: 0,
        items: [
          {
            category: "unmatched-tag",
            severity: "warning",
            message: "<model-viewer>",
            locations: [{ filePath: "pages/index.html", line: 1 }],
          },
        ],
      });
      const res = await runCli(["--check", "--strict"], { exitOnFinish: false });
      expect(res.action).toBe("check");
      expect(res.exitCode).toBe(1);
    });

    it("emits JSON when --json is passed", async () => {
      const { runCli } = await import("./index.ts");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
      try {
        vi.spyOn(await import("./lib/check.ts"), "checkProject").mockResolvedValueOnce({
          errors: 0,
          warnings: 1,
          pagesChecked: 1,
          componentsChecked: 0,
          items: [
            {
              category: "unmatched-tag",
              severity: "warning",
              message: "<model-viewer>",
              locations: [{ filePath: "pages/index.html", line: 1 }],
            },
          ],
        });
        const res = await runCli(["--check", "--json"], { exitOnFinish: false });
        expect(res.action).toBe("check");
        expect(res.exitCode).toBe(0);
        expect(logSpy).toHaveBeenCalled();
        const logged = logSpy.mock.calls[0][0];
        const parsed = JSON.parse(logged);
        expect(parsed.warnings).toBe(1);
        expect(parsed.findings[0].category).toBe("unmatched-tag");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("uses custom logger option for check output instead of console.log", async () => {
      const { runCli } = await import("./index.ts");
      const customLogger = vi.fn();
      const consoleLogSpy = vi.spyOn(console, "log");
      try {
        vi.spyOn(await import("./lib/check.ts"), "checkProject").mockResolvedValueOnce({
          errors: 0,
          warnings: 1,
          pagesChecked: 1,
          componentsChecked: 0,
          items: [
            {
              category: "unmatched-tag",
              severity: "warning",
              message: "<model-viewer>",
              locations: [{ filePath: "pages/index.html", line: 1 }],
            },
          ],
        });
        const res = await runCli(["--check", "--json"], {
          exitOnFinish: false,
          logger: customLogger,
        });
        expect(res.action).toBe("check");
        expect(res.exitCode).toBe(0);
        expect(customLogger).toHaveBeenCalled();
        const logged = customLogger.mock.calls[0][0];
        const parsed = JSON.parse(logged);
        expect(parsed.warnings).toBe(1);
        expect(consoleLogSpy).not.toHaveBeenCalled();
      } finally {
        consoleLogSpy.mockRestore();
      }
    });

    it("reports invalid config shape through check findings model instead of startup crash", async () => {
      const dir = await mkdtemp(join(tmpdir(), "bascik-cli-check-invalid-config-"));
      try {
        await writeFile(
          join(dir, "bascik.config.js"),
          "export default { http: { prt: 8080 } };",
          "utf8",
        );
        await mkdir(join(dir, "src/pages"), { recursive: true });
        await writeFile(join(dir, "src/pages/index.html"), "<p>ok</p>", "utf8");
        const cliPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
        const result = spawnSync(process.execPath, [cliPath, "--check", "--json"], {
          cwd: dir,
          encoding: "utf8",
        });

        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain("Failed to load bascik.config");

        const parsed = JSON.parse(result.stdout);
        expect(parsed.errors).toBeGreaterThan(0);
        const configFinding = parsed.findings.find((f: { category: string; message: string }) => f.category === "config-validation");
        expect(configFinding).toBeDefined();
        expect(configFinding.message).toContain("http.prt");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30000);
  });
});

