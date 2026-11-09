import { describe, expect, it } from "vitest";
import { chooseBinMode, BIN_USAGE } from "./bin-args.js";

describe("bascik-language-server argument handling", () => {
  it.each([["--help"], ["-h"], ["help"], ["--stdio", "--help"]])(
    "prints usage for %j and exits 0",
    (...args) => {
      expect(chooseBinMode(args)).toEqual({ mode: "help", exitCode: 0 });
    },
  );

  it("treats no arguments as a missing transport", () => {
    expect(chooseBinMode([])).toEqual({
      mode: "missing-transport",
      exitCode: 1,
    });
  });

  it("treats unrelated flags as a missing transport", () => {
    expect(chooseBinMode(["--bogus"])).toEqual({
      mode: "missing-transport",
      exitCode: 1,
    });
  });

  it.each([["--stdio"], ["--node-ipc"], ["--socket=3000"], ["--pipe=/tmp/x"]])(
    "starts the server for the %s transport",
    (arg) => {
      expect(chooseBinMode([arg, "--clientProcessId=1"]).mode).toBe("serve");
    },
  );

  it("runs the checker for --check and check, even with a transport flag", () => {
    expect(chooseBinMode(["--check"]).mode).toBe("check");
    expect(chooseBinMode(["check", "src"]).mode).toBe("check");
  });

  it("documents both uses in the usage text", () => {
    expect(BIN_USAGE).toContain("--check");
    expect(BIN_USAGE).toContain("--stdio");
  });
});
