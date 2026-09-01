import { describe, it, expect } from "vitest";
import { resolveCliAction, filterNodeArgs } from "./cli.ts";
import { LOG_LEVELS } from "./config.ts";

describe("cli helper tests", () => {
  describe("filterNodeArgs", () => {
    it("should keep standard bascik flags", () => {
      expect(filterNodeArgs(["--build"])).toEqual(["--build"]);
      expect(filterNodeArgs(["--server"])).toEqual(["--server"]);
      expect(filterNodeArgs(["--check"])).toEqual(["--check"]);
    });

    it("should filter out node profiling flags", () => {
      const args = [
        "--prof",
        "--logfile=/path/to/log.log",
        "--print-opt-source",
        "--build",
      ];
      expect(filterNodeArgs(args)).toEqual(["--build"]);
    });

    it("should filter out node pre-require/loader flags and their values", () => {
      const args = [
        "-r",
        "some-preload-module.js",
        "--require",
        "other-module.js",
        "--import",
        "tsx",
        "--server",
      ];
      expect(filterNodeArgs(args)).toEqual(["--server"]);
    });

    it("should filter out Node diagnostic and experimental flags", () => {
      const args = [
        "--experimental-strip-types",
        "--heapprofile",
        "--heapprofile=my.heapprofile",
        "--cpuprof",
        "--cpuprof=my.cpuprof",
        "--inspect",
        "--inspect-brk",
        "--inspect=127.0.0.1:9229",
        "--conditions=react-server",
        "--check",
      ];
      expect(filterNodeArgs(args)).toEqual(["--check"]);
    });
  });

  describe("resolveCliAction", () => {
    it("should successfully resolve standard commands when profiling flags are present", () => {
      const args = [
        "--prof",
        "--logfile=/Users/collin/github/bascik/docs/%p-v8.log",
        "--print-opt-source",
        "-r",
        "/Users/collin/github/bascik/node_modules/0x/lib/preload.js",
        "--build",
      ];
      const decision = resolveCliAction(args);
      expect(decision.action).toBe("build");
    });

    it("should still report unknown bascik flags, with a near-match suggestion", () => {
      const args = ["--builds"];
      const decision = resolveCliAction(args);
      expect(decision.action).toBe("error");
      expect(decision.unknownFlags).toContain("--builds");
      expect(decision.errorMessage).toContain("--builds");
      expect(decision.errorMessage).toContain('Did you mean "--build"?');
    });

    it("suggests --server for a near-miss flag", () => {
      // Regression anchor for the parser/config desync: config used to derive
      // its mode from its own argv scan, so a spelling the CLI rejected could
      // still flip the config. One parser now drives both, and an unknown
      // near-match flag gets a suggestion from the generic machinery.
      const decision = resolveCliAction(["--serverr"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--serverr");
      expect(decision.errorMessage).toContain('Did you mean "--server"?');
    });

    it("should recognize --site-url and --env-file in both forms", () => {
      expect(
        resolveCliAction(["--build", "--site-url", "https://example.com"]).action,
      ).toBe("build");
      expect(
        resolveCliAction(["--build", "--site-url=https://example.com"]).action,
      ).toBe("build");
      expect(resolveCliAction(["--build", "--env-file", ".env.staging"]).action)
        .toBe("build");
      expect(resolveCliAction(["--build", "--env-file=.env.staging"]).action)
        .toBe("build");
    });

    it("parses --site-url and --env-file values into flags", () => {
      const spaced = resolveCliAction([
        "--build",
        "--site-url",
        "https://example.com",
        "--env-file",
        ".env.staging",
      ]);
      expect(spaced.flags.siteUrl).toBe("https://example.com");
      expect(spaced.flags.envFiles).toEqual([".env.staging"]);

      const inline = resolveCliAction([
        "--build",
        "--site-url=https://example.com",
        "--env-file=.env.staging",
      ]);
      expect(inline.flags.siteUrl).toBe("https://example.com");
      expect(inline.flags.envFiles).toEqual([".env.staging"]);
    });

    it("should recognize repeated --env-file flags", () => {
      const decision = resolveCliAction([
        "--build",
        "--env-file=.env.a",
        "--env-file=.env.b",
      ]);
      expect(decision.action).toBe("build");
      expect(decision.flags.envFiles).toEqual([".env.a", ".env.b"]);
    });
  });

  describe("conflicting flags", () => {
    it("rejects --build --server, naming both flags", () => {
      const decision = resolveCliAction(["--build", "--server"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--build");
      expect(decision.errorMessage).toContain("--server");
    });

    it("rejects --server --build regardless of order", () => {
      const decision = resolveCliAction(["--server", "--build"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--build");
      expect(decision.errorMessage).toContain("--server");
    });
  });

  describe("positional validation", () => {
    it("rejects 'bascik build' (no dashes) with a --build suggestion", () => {
      const decision = resolveCliAction(["build"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain('"build"');
      expect(decision.errorMessage).toContain('Did you mean "--build"?');
    });

    it("rejects a misspelled positional with a near-match suggestion", () => {
      const decision = resolveCliAction(["buld"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain('"buld"');
      expect(decision.errorMessage).toContain('Did you mean "--build"?');
    });

    it("rejects an unexpected argument to a flag that takes none", () => {
      const decision = resolveCliAction(["--check", "somefile.html"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain('"somefile.html"');
    });

    it("rejects extra positionals after init", () => {
      const decision = resolveCliAction(["init", "extra"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain('"extra"');
    });
  });

  describe("--flag=value forms", () => {
    const cases: { flag: string; value: string; read: (d: ReturnType<typeof resolveCliAction>) => unknown }[] = [
      { flag: "--config", value: "./conf/bascik.config.js", read: (d) => d.flags.config },
      { flag: "--port", value: "4321", read: (d) => d.flags.port },
      { flag: "--host", value: "0.0.0.0", read: (d) => d.flags.host },
      { flag: "--log-level", value: "debug", read: (d) => d.flags.logLevel },
      { flag: "--site-url", value: "https://example.com", read: (d) => d.flags.siteUrl },
      { flag: "--env-file", value: ".env.staging", read: (d) => d.flags.envFiles[0] },
      { flag: "--log", value: "./out.log", read: (d) => d.flags.log },
    ];

    for (const { flag, value, read } of cases) {
      it(`${flag} accepts "--flag value" and "--flag=value" identically`, () => {
        const spaced = resolveCliAction(["--build", flag, value]);
        const inline = resolveCliAction(["--build", `${flag}=${value}`]);
        expect(spaced.action).toBe("build");
        expect(inline.action).toBe("build");
        expect(read(spaced)).toEqual(read(inline));
      });
    }

    it("rejects a value on a boolean flag", () => {
      const decision = resolveCliAction(["--build=yes"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--build");
    });
  });

  describe("duplicate flags", () => {
    it("treats a repeated boolean flag as a no-op", () => {
      expect(resolveCliAction(["--build", "--build"]).action).toBe("build");
    });

    it("lets the last occurrence win for value flags", () => {
      const decision = resolveCliAction(["--build", "--port", "1111", "--port", "2222"]);
      expect(decision.action).toBe("build");
      expect(decision.flags.port).toBe(2222);
    });
  });

  describe("node flag resilience", () => {
    it("does not hard-fail on an unrecognized leading node flag", () => {
      expect(
        resolveCliAction(["--max-old-space-size=4096", "--build"]).action,
      ).toBe("build");
      expect(
        resolveCliAction(["--enable-source-maps", "--server"]).action,
      ).toBe("server");
    });

    it("still rejects unknown flags once a bascik flag is present", () => {
      const decision = resolveCliAction(["--build", "--bogus"]);
      expect(decision.action).toBe("error");
      expect(decision.unknownFlags).toContain("--bogus");
    });
  });

  describe("value validation", () => {
    it("rejects a non-integer --port", () => {
      const decision = resolveCliAction(["--build", "--port", "abc"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--port");
      expect(decision.errorMessage).toContain('"abc"');
    });

    it("rejects an out-of-range --port", () => {
      const decision = resolveCliAction(["--build", "--port=70000"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--port");
    });

    it("rejects an unknown --log-level", () => {
      const decision = resolveCliAction(["--build", "--log-level", "bogus"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--log-level");
      expect(decision.errorMessage).toContain('"bogus"');
    });

    it("accepts every level the config knows about (drift guard)", () => {
      for (const level of LOG_LEVELS) {
        const decision = resolveCliAction(["--build", "--log-level", level]);
        expect(decision.action).toBe("build");
        expect(decision.flags.logLevel).toBe(level);
      }
    });

    it("errors when a value flag is missing its value", () => {
      const decision = resolveCliAction(["--build", "--config"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--config");
      expect(decision.errorMessage).toContain("requires a value");
    });
  });

  describe("new flags", () => {
    it("parses --port, --host, and --log-level", () => {
      const decision = resolveCliAction([
        "--server",
        "--port",
        "4321",
        "--host",
        "0.0.0.0",
        "--log-level",
        "warn",
      ]);
      expect(decision.action).toBe("server");
      expect(decision.flags.port).toBe(4321);
      expect(decision.flags.host).toBe("0.0.0.0");
      expect(decision.flags.logLevel).toBe("warn");
    });
  });

  describe("--log gating", () => {
    it("resolves the default log path for a bare --log", () => {
      const decision = resolveCliAction(["--build", "--log"]);
      expect(decision.flags.log).toBe(".bascik/build.log");
    });

    it("rejects --log without --build", () => {
      const devDecision = resolveCliAction(["--log", "x.log"]);
      expect(devDecision.action).toBe("error");
      expect(devDecision.errorMessage).toContain("--log");
      expect(devDecision.errorMessage).toContain("--build");

      const serverDecision = resolveCliAction(["--server", "--log"]);
      expect(serverDecision.action).toBe("error");
      expect(serverDecision.errorMessage).toContain("--log");
    });
  });
});
