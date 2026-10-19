import { describe, it, expect } from "vitest";
import {
  resolveCliAction,
  filterNodeArgs,
  CLI_FLAGS,
  CLI_USAGE,
} from "./cli.ts";
import { LOG_LEVELS } from "./config.ts";

describe("cli helper tests", () => {
  describe("filterNodeArgs", () => {
    it("should keep standard bascik flags", () => {
      expect(filterNodeArgs(["--build"])).toEqual(["--build"]);
      expect(filterNodeArgs(["--server"])).toEqual(["--server"]);
      expect(filterNodeArgs(["--check"])).toEqual(["--check"]);
      expect(filterNodeArgs(["--fix"])).toEqual(["--fix"]);
    });

    it("resolves --check --fix to the check action with the fix flag", () => {
      const fixDecision = resolveCliAction(["--check", "--fix"]);
      expect(fixDecision.action).toBe("check");
      expect(fixDecision.flags.fix).toBe(true);
    });

    it("rejects --lint and bare lint without suggesting anything: it is not an alias for --check", () => {
      for (const args of [["--lint"], ["lint"]]) {
        const decision = resolveCliAction(args);
        expect(decision.action).toBe("error");
        expect(decision.errorMessage).not.toContain("Did you mean");
      }
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
        resolveCliAction(["--build", "--site-url", "https://example.com"])
          .action,
      ).toBe("build");
      expect(
        resolveCliAction(["--build", "--site-url=https://example.com"]).action,
      ).toBe("build");
      expect(
        resolveCliAction(["--build", "--env-file", ".env.staging"]).action,
      ).toBe("build");
      expect(
        resolveCliAction(["--build", "--env-file=.env.staging"]).action,
      ).toBe("build");
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
    const cases: {
      flag: string;
      value: string;
      read: (d: ReturnType<typeof resolveCliAction>) => unknown;
    }[] = [
      {
        flag: "--config",
        value: "./conf/bascik.config.js",
        read: (d) => d.flags.config,
      },
      { flag: "--port", value: "4321", read: (d) => d.flags.port },
      { flag: "--host", value: "0.0.0.0", read: (d) => d.flags.host },
      { flag: "--log-level", value: "debug", read: (d) => d.flags.logLevel },
      {
        flag: "--site-url",
        value: "https://example.com",
        read: (d) => d.flags.siteUrl,
      },
      {
        flag: "--env-file",
        value: ".env.staging",
        read: (d) => d.flags.envFiles[0],
      },
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
      const decision = resolveCliAction([
        "--build",
        "--port",
        "1111",
        "--port",
        "2222",
      ]);
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

    it("parses --strict and --json flags with --check", () => {
      const decision = resolveCliAction(["--check", "--strict", "--json"]);
      expect(decision.action).toBe("check");
      expect(decision.flags.strict).toBe(true);
      expect(decision.flags.json).toBe(true);
    });

    it("rejects --strict without --check", () => {
      const decision = resolveCliAction(["--build", "--strict"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain(
        "--strict only applies to --check",
      );
    });

    it("rejects --json without --check", () => {
      const decision = resolveCliAction(["--build", "--json"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--json");
      expect(decision.errorMessage).toContain("--check");
    });

    it("parses --target flag with any non-empty value during build", () => {
      const customDecision = resolveCliAction([
        "--build",
        "--target",
        "@acme/adapter-foo",
      ]);
      expect(customDecision.action).toBe("build");
      expect(customDecision.flags.target).toBe("@acme/adapter-foo");

      const localDecision = resolveCliAction([
        "--build",
        "--target=./my-adapter.ts",
      ]);
      expect(localDecision.action).toBe("build");
      expect(localDecision.flags.target).toBe("./my-adapter.ts");
    });

    it("rejects --target without --build", () => {
      const decision = resolveCliAction(["--target", "cloudflare-pages"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--target");
      expect(decision.errorMessage).toContain("--build");
    });

    it("rejects --target with --only", () => {
      const decision = resolveCliAction([
        "--build",
        "--target",
        "cloudflare-pages",
        "--only",
        "index.html",
      ]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--target");
      expect(decision.errorMessage).toContain("--only");
    });
  });

  describe("--quiet and -q", () => {
    it.each(["--quiet", "-q"])(
      "%s selects the warn level on every run mode",
      (flag) => {
        expect(resolveCliAction([flag])).toMatchObject({
          action: "dev",
          flags: { logLevel: "warn" },
        });
        expect(resolveCliAction(["--build", flag])).toMatchObject({
          action: "build",
          flags: { logLevel: "warn" },
        });
        expect(resolveCliAction(["--server", flag])).toMatchObject({
          action: "server",
          flags: { logLevel: "warn" },
        });
      },
    );

    it("can come before or after the mode flag", () => {
      expect(resolveCliAction(["-q", "--build"]).flags.logLevel).toBe("warn");
    });

    it("rejects --quiet together with --log-level, naming both, instead of letting one win", () => {
      for (const args of [
        ["--quiet", "--log-level", "debug"],
        ["--log-level=debug", "-q"],
      ]) {
        const decision = resolveCliAction(args);
        expect(decision.action).toBe("error");
        expect(decision.errorMessage).toContain("--quiet");
        expect(decision.errorMessage).toContain("--log-level");
      }
    });

    it("does not take a value", () => {
      const decision = resolveCliAction(["--quiet=yes"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("does not take a value");
    });

    it("leaves the level unset when it is not passed, so the config and BASCIK_LOG_LEVEL decide", () => {
      expect(resolveCliAction(["--build"]).flags.logLevel).toBeUndefined();
    });
  });

  describe("--no-pin", () => {
    it("is accepted by the dev server", () => {
      expect(resolveCliAction(["--no-pin"])).toMatchObject({
        action: "dev",
        flags: { noPin: true },
      });
    });

    it("is off unless passed", () => {
      expect(resolveCliAction([]).flags.noPin).toBeUndefined();
    });

    it.each([["--build"], ["--server"], ["--check"]])(
      "is rejected with %s, where nothing is pinned",
      (mode) => {
        const decision = resolveCliAction([mode, "--no-pin"]);
        expect(decision.action).toBe("error");
        expect(decision.errorMessage).toContain(
          "--no-pin only applies to the dev server",
        );
      },
    );

    it("is suggested for a near miss", () => {
      expect(resolveCliAction(["--build", "--nopin"]).errorMessage).toContain(
        'Did you mean "--no-pin"?',
      );
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

  describe("add subcommand", () => {
    it("parses bascik add with package target and flags", () => {
      const decision = resolveCliAction([
        "add",
        "@acme/ui",
        "--force",
        "--yes",
        "--dry-run",
      ]);
      expect(decision.action).toBe("add");
      expect(decision.flags.addTargets).toEqual(["@acme/ui"]);
      expect(decision.flags.force).toBe(true);
      expect(decision.flags.yes).toBe(true);
      expect(decision.flags.dryRun).toBe(true);
    });

    it("parses bascik add with multiple targets", () => {
      const decision = resolveCliAction([
        "add",
        "@acme/ui/card",
        "@acme/ui/button",
      ]);
      expect(decision.action).toBe("add");
      expect(decision.flags.addTargets).toEqual([
        "@acme/ui/card",
        "@acme/ui/button",
      ]);
    });

    it("rejects bascik add without targets", () => {
      const decision = resolveCliAction(["add"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain(
        "`bascik add` expects at least one package or component target",
      );
    });

    it("rejects --force without add", () => {
      const decision = resolveCliAction(["--build", "--force"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--force only applies to add");
    });

    it("rejects --dry-run without add", () => {
      const decision = resolveCliAction(["--build", "--dry-run"]);
      expect(decision.action).toBe("error");
      expect(decision.errorMessage).toContain("--dry-run only applies to add");
    });
  });
});

describe("CLI_USAGE", () => {
  // Every flag the parser accepts must be discoverable from --help.
  it.each([...CLI_FLAGS])("documents %s", (flag) => {
    const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    expect(CLI_USAGE).toMatch(
      new RegExp(`(?:^|[\\s,])${escapedFlag}(?![\\w-])`, "m"),
    );
  });
});
