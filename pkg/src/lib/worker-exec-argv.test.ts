import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worker, WorkerOptions } from "node:worker_threads";
import {
  rejectedExecArgv,
  resetWorkerExecArgvForTests,
  startWorker,
  withoutInputType,
  withoutRejected,
} from "./worker-exec-argv.ts";

/** The error Node throws, with its real message format (Node 24 and 26). */
const invalidExecArgv = (flags: string[]) =>
  Object.assign(
    new TypeError(
      `Initiated Worker with invalid execArgv flags: ${flags.join(", ")}`,
    ),
    { code: "ERR_WORKER_INVALID_EXEC_ARGV" },
  );

const FAKE_WORKER = {} as Worker;

/** A `new Worker` stand-in that rejects `refused` the way Node does. */
const nodeRefusing = (refused: (arg: string) => boolean) =>
  vi.fn((_script: string, options: WorkerOptions) => {
    const bad = (options.execArgv ?? []).filter(
      (arg) => typeof arg === "string" && refused(arg),
    ) as string[];
    if (bad.length > 0) throw invalidExecArgv(bad);
    return FAKE_WORKER;
  });

const isPerProcess = (arg: string) =>
  /^--(max-old-space-size|stack-size|expose-gc|no-wasm-code-gc|title)\b/.test(
    arg,
  );

beforeEach(() => resetWorkerExecArgvForTests());

describe("withoutInputType", () => {
  it("drops --input-type in every spelling Node accepts, and its separate value", () => {
    expect(
      withoutInputType([
        "--input-type=module",
        "--conditions=dev",
        "--input_type=commonjs",
        "--input-type",
        "module",
        "--import",
        "./preload.mjs",
      ]),
    ).toEqual(["--conditions=dev", "--import", "./preload.mjs"]);
  });

  it("never leaves a stray value that would stop Node reading the flags after it", () => {
    // Node ignores every option after the first argument that is not one.
    const kept = withoutInputType(["--input-type", "module", "--expose-gc"]);
    expect(kept).toEqual(["--expose-gc"]);
    expect(kept.every((arg) => arg.startsWith("-"))).toBe(true);
  });

  it("keeps a following flag when --input-type has no value of its own", () => {
    expect(withoutInputType(["--input-type", "--conditions=dev"])).toEqual([
      "--conditions=dev",
    ]);
  });

  it("leaves flags that only start with the same letters alone", () => {
    expect(withoutInputType(["--input-types-are-fine", "--inspect"])).toEqual([
      "--input-types-are-fine",
      "--inspect",
    ]);
  });

  it("returns an empty list for an empty execArgv", () => {
    expect(withoutInputType([])).toEqual([]);
  });
});

describe("rejectedExecArgv", () => {
  it("reads every flag Node names", () => {
    const execArgv = [
      "--max-old-space-size=4096",
      "--conditions=dev",
      "--stack-size=900",
    ];
    expect(
      rejectedExecArgv(
        invalidExecArgv(["--max-old-space-size=4096", "--stack-size=900"]),
        execArgv,
      ),
    ).toEqual(["--max-old-space-size=4096", "--stack-size=900"]);
  });

  it("finds a flag whose value contains the separator Node joins with", () => {
    expect(
      rejectedExecArgv(invalidExecArgv(["--title=a, b", "--expose-gc"]), [
        "--title=a, b",
        "--expose-gc",
        "--import=./a.mjs",
      ]),
    ).toEqual(["--title=a, b", "--expose-gc"]);
  });

  it("never matches a flag by prefix", () => {
    expect(
      rejectedExecArgv(invalidExecArgv(["--expose-gc"]), [
        "--expose-gc-extra",
        "--expose",
      ]),
    ).toEqual([]);
  });

  it("is empty for any other error, a NODE_OPTIONS error, or an unknown message", () => {
    const execArgv = ["--expose-gc"];
    expect(rejectedExecArgv(new Error("--expose-gc"), execArgv)).toEqual([]);
    expect(rejectedExecArgv(null, execArgv)).toEqual([]);
    expect(rejectedExecArgv("--expose-gc", execArgv)).toEqual([]);
    expect(
      rejectedExecArgv(
        Object.assign(
          new Error(
            "Initiated Worker with invalid NODE_OPTIONS env variable: --expose-gc",
          ),
          { code: "ERR_WORKER_INVALID_EXEC_ARGV" },
        ),
        execArgv,
      ),
    ).toEqual([]);
    expect(
      rejectedExecArgv(
        Object.assign(new Error("something else entirely"), {
          code: "ERR_WORKER_INVALID_EXEC_ARGV",
        }),
        execArgv,
      ),
    ).toEqual([]);
  });
});

describe("withoutRejected", () => {
  it("removes exactly the rejected flags and keeps the rest in order", () => {
    expect(
      withoutRejected(
        ["--import=./a.mjs", "--expose-gc", "--conditions=dev"],
        ["--expose-gc"],
      ),
    ).toEqual(["--import=./a.mjs", "--conditions=dev"]);
  });

  it("removes a separate value with its flag (Node names only `--title`)", () => {
    expect(
      withoutRejected(["--title", "a, b", "--conditions", "dev"], ["--title"]),
    ).toEqual(["--conditions", "dev"]);
  });

  it("keeps the flag after a rejected boolean flag", () => {
    expect(
      withoutRejected(["--expose-gc", "--conditions", "dev"], ["--expose-gc"]),
    ).toEqual(["--conditions", "dev"]);
  });
});

describe("startWorker", () => {
  it("passes this thread's flags on unchanged when Node accepts them all", () => {
    const create = nodeRefusing(() => false);
    const execArgv = ["--import=./a.mjs", "--conditions", "dev"];
    expect(startWorker("/w.mjs", { workerData: 1 }, { execArgv, create })).toBe(
      FAKE_WORKER,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith("/w.mjs", {
      workerData: 1,
      execArgv,
    });
  });

  it("passes an empty list for an empty execArgv", () => {
    const create = nodeRefusing(() => false);
    startWorker("/w.mjs", {}, { execArgv: [], create });
    expect(create.mock.calls[0][1].execArgv).toEqual([]);
  });

  it("retries once without exactly the flags Node rejects, keeping loaders and conditions", () => {
    const create = nodeRefusing(isPerProcess);
    const execArgv = [
      "--max-old-space-size=4096",
      "--import=./a.mjs",
      "--stack-size=900",
      "--conditions=dev",
      "--experimental-vm-modules",
    ];
    expect(startWorker("/w.mjs", {}, { execArgv, create })).toBe(FAKE_WORKER);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][1].execArgv).toEqual([
      "--import=./a.mjs",
      "--conditions=dev",
      "--experimental-vm-modules",
    ]);
  });

  it("drops a refused flag's separate value, so the flags after it still apply", () => {
    // Node names only `--title`; leaving `bascik` would end option parsing.
    const create = nodeRefusing((arg) => arg === "--title");
    startWorker(
      "/w.mjs",
      {},
      {
        execArgv: [
          "--title",
          "bascik",
          "--import",
          "./a.mjs",
          "--conditions",
          "dev",
        ],
        create,
      },
    );
    expect(create.mock.calls.at(-1)![1].execArgv).toEqual([
      "--import",
      "./a.mjs",
      "--conditions",
      "dev",
    ]);
  });

  it("drops a repeated refused flag every time it appears", () => {
    const create = nodeRefusing(isPerProcess);
    startWorker(
      "/w.mjs",
      {},
      {
        execArgv: [
          "--expose-gc",
          "--conditions=dev",
          "--expose-gc",
          "--max-old-space-size=1024",
          "--max-old-space-size=4096",
        ],
        create,
      },
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][1].execArgv).toEqual(["--conditions=dev"]);
  });

  it("remembers the working flags, so later workers start on the first try", () => {
    const create = nodeRefusing(isPerProcess);
    const execArgv = ["--expose-gc", "--conditions=dev"];
    startWorker("/w.mjs", {}, { execArgv, create });
    create.mockClear();
    startWorker("/w.mjs", {}, { execArgv, create });
    startWorker("/w.mjs", {}, { execArgv, create });
    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      expect(call[1].execArgv).toEqual(["--conditions=dev"]);
    }
  });

  it("works the flags out again when this thread's execArgv changed", () => {
    const create = nodeRefusing(isPerProcess);
    startWorker("/w.mjs", {}, { execArgv: ["--expose-gc"], create });
    create.mockClear();
    startWorker("/w.mjs", {}, { execArgv: ["--conditions=x"], create });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1].execArgv).toEqual(["--conditions=x"]);
  });

  it("drops --input-type and a rejected flag together", () => {
    const create = nodeRefusing(isPerProcess);
    startWorker(
      "/w.mjs",
      {},
      {
        execArgv: [
          "--input-type",
          "module",
          "--max-old-space-size=4096",
          "--x",
        ],
        create,
      },
    );
    expect(create.mock.calls.at(-1)![1].execArgv).toEqual(["--x"]);
  });

  it("leaves execArgv out (Node's own inheritance) when the error names no flag it was given", () => {
    const create = vi
      .fn<(script: string, options: WorkerOptions) => Worker>()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("a future message format"), {
          code: "ERR_WORKER_INVALID_EXEC_ARGV",
        });
      })
      .mockReturnValue(FAKE_WORKER);
    expect(
      startWorker(
        "/w.mjs",
        { workerData: 2 },
        { execArgv: ["--expose-gc"], create },
      ),
    ).toBe(FAKE_WORKER);
    expect(create.mock.calls[1][1]).toEqual({ workerData: 2 });
    expect(create.mock.calls[1][1]).not.toHaveProperty("execArgv");
  });

  it("throws instead of inheriting --input-type when the error names no flag", () => {
    const refusal = Object.assign(new Error("a future message format"), {
      code: "ERR_WORKER_INVALID_EXEC_ARGV",
    });
    const create = vi.fn(() => {
      throw refusal;
    });
    expect(() =>
      startWorker(
        "/w.mjs",
        {},
        { execArgv: ["--input-type=module", "--expose-gc"], create },
      ),
    ).toThrow(refusal);
    expect(create).toHaveBeenCalledOnce();
  });

  it("throws any other constructor error as is, without a retry", () => {
    const missing = Object.assign(new Error("Cannot find module /nope.mjs"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const create = vi.fn(() => {
      throw missing;
    });
    expect(() =>
      startWorker("/nope.mjs", {}, { execArgv: ["--expose-gc"], create }),
    ).toThrow(missing);
    expect(create).toHaveBeenCalledOnce();
  });

  it("follows Node through several rounds of refusals", () => {
    // Node 24 and 26 refuse `--max-old-space-size=4096 --title x --expose-gc`
    // for the first two, and only then for `--expose-gc`.
    const rounds = [["--max-old-space-size=4096", "--title"], ["--expose-gc"]];
    const create = vi.fn((_script: string, options: WorkerOptions) => {
      const round = rounds.shift();
      if (round) throw invalidExecArgv(round);
      return Object.assign({}, FAKE_WORKER, { execArgv: options.execArgv });
    });
    const worker = startWorker(
      "/w.mjs",
      {},
      {
        execArgv: [
          "--max-old-space-size=4096",
          "--title",
          "a, b",
          "--expose-gc",
          "--conditions=dev",
        ],
        create,
      },
    );
    expect(create).toHaveBeenCalledTimes(3);
    expect((worker as unknown as { execArgv: string[] }).execArgv).toEqual([
      "--conditions=dev",
    ]);
  });

  it("gives up when Node keeps refusing, and does not remember the failure", () => {
    const create = vi.fn(() => {
      throw invalidExecArgv(["--expose-gc"]);
    });
    expect(() =>
      startWorker("/w.mjs", {}, { execArgv: ["--expose-gc"], create }),
    ).toThrow(/invalid execArgv flags/);
    // Without the flag, then with execArgv left out, then it stops.
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[1]).toEqual(["/w.mjs", { execArgv: [] }]);
    expect(create.mock.calls[2]).toEqual(["/w.mjs", {}]);
    const accepting = nodeRefusing(() => false);
    startWorker("/w.mjs", {}, { execArgv: ["--expose-gc"], create: accepting });
    expect(accepting.mock.calls[0][1].execArgv).toEqual(["--expose-gc"]);
  });
});
