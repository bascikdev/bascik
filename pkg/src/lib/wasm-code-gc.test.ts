import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  avoidWasmWrapperRace,
  hasWasmWrapperRace,
  hasWasmWrapperTierUpRace,
  resetWasmWrapperRaceForTests,
  WRAPPER_TIERING_BUDGET_FLAG,
} from "./wasm-code-gc.ts";

beforeEach(() => resetWasmWrapperRaceForTests());

const run = (
  options: {
    v8Version?: string;
    arch?: string;
    execArgv?: string[];
    nodeOptions?: string;
    setFlags?: (flags: string) => void;
  } = {},
) => {
  const setFlags = vi.fn(options.setFlags ?? (() => {}));
  const changed = avoidWasmWrapperRace({
    v8Version: "13.6.233.17-node.53",
    arch: "x64",
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

  it("defaults to this process's V8, architecture, arguments and NODE_OPTIONS", () => {
    const setFlags = vi.fn();
    avoidWasmWrapperRace({ setFlags });
    const userArgs = [
      ...process.execArgv,
      ...(process.env.NODE_OPTIONS ?? "").split(/\s+/),
    ].join(" ");
    const expected = hasWasmWrapperRace(process.versions.v8)
      ? !userArgs.includes("--wasm-code-gc")
      : hasWasmWrapperTierUpRace(process.versions.v8, process.arch) &&
        !userArgs.includes("--wasm-wrapper-tiering-budget");
    expect(setFlags.mock.calls.length).toBe(expected ? 1 : 0);
  });
});

describe("hasWasmWrapperTierUpRace", () => {
  it.each([
    ["14.6.202.34-node.40", "arm64", true],
    ["14.1.146.11-node.18", "arm64", true],
    ["14.6.202.34-node.40", "x64", false],
    ["13.6.233.17-node.53", "arm64", false],
    ["15.0.1", "arm64", false],
    ["", "arm64", false],
  ])("%s on %s -> %s", (version, arch, expected) => {
    expect(hasWasmWrapperTierUpRace(version, arch)).toBe(expected);
  });
});

describe("avoidWasmWrapperRace on Node 26 (V8 14) on arm64", () => {
  const node26 = { v8Version: "14.6.202.34-node.40", arch: "arm64" };

  it("holds wasm wrapper tier-up off, and leaves wasm code GC on", () => {
    const { changed, setFlags } = run(node26);
    expect(changed).toBe(true);
    expect(setFlags).toHaveBeenCalledExactlyOnceWith(
      WRAPPER_TIERING_BUDGET_FLAG,
    );
  });

  it("sets it once per process", () => {
    run(node26);
    const second = run(node26);
    expect(second.changed).toBe(false);
    expect(second.setFlags).not.toHaveBeenCalled();
  });

  it.each([
    ["execArgv", { execArgv: ["--wasm-wrapper-tiering-budget=50"] }],
    [
      "execArgv, underscore spelling",
      { execArgv: ["--wasm_wrapper_tiering_budget=50"] },
    ],
    [
      "NODE_OPTIONS",
      {
        nodeOptions:
          "--max-old-space-size=4096 --wasm-wrapper-tiering-budget=50",
      },
    ],
  ])("respects a budget the user set in %s", (_where, options) => {
    const { changed, setFlags } = run({ ...node26, ...options });
    expect(changed).toBe(false);
    expect(setFlags).not.toHaveBeenCalled();
  });

  it("is not stopped by the user's --wasm-code-gc, which is the Node 24 guard's flag", () => {
    const { setFlags } = run({ ...node26, execArgv: ["--wasm-code-gc"] });
    expect(setFlags).toHaveBeenCalledExactlyOnceWith(
      WRAPPER_TIERING_BUDGET_FLAG,
    );
  });

  it("never throws when V8 refuses the flag", () => {
    const { changed } = run({
      ...node26,
      setFlags: () => {
        throw new Error("flags frozen");
      },
    });
    expect(changed).toBe(false);
  });

  it("leaves Node 26 on x64 alone", () => {
    const { changed, setFlags } = run({ ...node26, arch: "x64" });
    expect(changed).toBe(false);
    expect(setFlags).not.toHaveBeenCalled();
  });
});
