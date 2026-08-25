import { describe, it, expect } from "vitest";
import { resolveCliAction, filterNodeArgs } from "./cli.js";

describe("cli helper tests", () => {
  describe("filterNodeArgs", () => {
    it("should keep standard bascik flags", () => {
      expect(filterNodeArgs(["--build"])).toEqual(["--build"]);
      expect(filterNodeArgs(["--serve"])).toEqual(["--serve"]);
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
        "--serve",
      ];
      expect(filterNodeArgs(args)).toEqual(["--serve"]);
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
      expect(resolveCliAction(args)).toEqual({ action: "build" });
    });

    it("should still report unknown bascik flags", () => {
      const args = ["--builds"];
      const decision = resolveCliAction(args);
      expect(decision.action).toBe("error");
      expect(decision.unknownFlags).toContain("--builds");
    });
  });
});
