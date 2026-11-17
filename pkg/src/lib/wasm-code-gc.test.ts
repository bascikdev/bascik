import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  avoidWasmWrapperRace,
  hasWasmWrapperRace,
  resetWasmWrapperRaceForTests,
} from "./wasm-code-gc.ts";

beforeEach(() => resetWasmWrapperRaceForTests());

const run = (
  options: {
    v8Version?: string;
    execArgv?: string[];
    nodeOptions?: string;
    setFlags?: (flags: string) => void;
  } = {},
) => {
  const setFlags = vi.fn(options.setFlags ?? (() => {}));
  const changed = avoidWasmWrapperRace({
    v8Version: "13.6.233.17-node.53",
    execArgv: [],
    nodeOptions: "",
    ...options,
    setFlags,
  });
  return { changed, setFlags };
};

describe("hasWasmWrapperRace", () => {
  it.each([
    ["13.6.233.17-node.53", true],
    ["13.6.233.17-node.63", true],
    ["13.0.1", true],
    ["12.4.254.21-node.33", false],
    ["14.1.146.11-node.18", false],
    ["14.6.202.34-node.40", false],
    ["", false],
    ["not a version", false],
  ])("%s -> %s", (version, expected) => {
    expect(hasWasmWrapperRace(version)).toBe(expected);
  });
});

describe("avoidWasmWrapperRace", () => {
  it("turns wasm code GC off on V8 13", () => {
    const { changed, setFlags } = run();
    expect(changed).toBe(true);
    expect(setFlags).toHaveBeenCalledExactlyOnceWith("--no-wasm-code-gc");
  });

  it("leaves V8 versions without the race alone", () => {
    for (const v8Version of ["12.4.254.21-node.33", "14.6.202.34-node.40"]) {
      resetWasmWrapperRaceForTests();
      const { changed, setFlags } = run({ v8Version });
      expect(changed).toBe(false);
      expect(setFlags).not.toHaveBeenCalled();
    }
  });

  it("sets the flag once per process, however many pools start", () => {
    const first = run();
    const second = run();
    expect(first.setFlags).toHaveBeenCalledTimes(1);
    expect(second.changed).toBe(false);
    expect(second.setFlags).not.toHaveBeenCalled();
  });

  it.each([
    ["execArgv", { execArgv: ["--wasm-code-gc"] }],
    ["execArgv, underscore spelling", { execArgv: ["--wasm_code_gc"] }],
    [
      "NODE_OPTIONS",
      { nodeOptions: "--max-old-space-size=4096 --wasm-code-gc" },
    ],
    [
      "NODE_OPTIONS, overriding an earlier --no-wasm-code-gc",
      { nodeOptions: "--no-wasm-code-gc --wasm-code-gc" },
    ],
  ])(
    "keeps wasm code GC when the user turned it on in %s",
    (_where, options) => {
      const { changed, setFlags } = run(options);
      expect(changed).toBe(false);
      expect(setFlags).not.toHaveBeenCalled();
    },
  );

  it("still turns it off when the user's last word was --no-wasm-code-gc", () => {
    const { changed } = run({
      nodeOptions: "--wasm-code-gc",
      execArgv: ["--no-wasm-code-gc"],
    });
    expect(changed).toBe(true);
  });

  it("reads V8's --nowasm-code-gc spelling as turning it off", () => {
    const { changed } = run({
      nodeOptions: "--wasm-code-gc",
      execArgv: ["--nowasm_code_gc"],
    });
    expect(changed).toBe(true);
  });

  it("ignores flags that only look similar", () => {
    const { changed } = run({
      execArgv: ["--stress-wasm-code-gc", "--trace-wasm-code-gc"],
      nodeOptions: "--no-wasm-code-gc-foo",
    });
    expect(changed).toBe(true);
  });

  it("never throws when V8 refuses the flag", () => {
    const { changed } = run({
      setFlags: () => {
        throw new Error("flags are frozen");
      },
    });
    expect(changed).toBe(false);
  });

  it("defaults to this process's V8, arguments and NODE_OPTIONS", () => {
    const setFlags = vi.fn();
    avoidWasmWrapperRace({ setFlags });
    expect(setFlags.mock.calls.length).toBe(
      hasWasmWrapperRace(process.versions.v8) &&
        !process.execArgv.includes("--wasm-code-gc") &&
        !(process.env.NODE_OPTIONS ?? "").includes("--wasm-code-gc")
        ? 1
        : 0,
    );
  });
});
