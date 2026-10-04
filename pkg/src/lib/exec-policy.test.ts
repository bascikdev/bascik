import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { config, emitted } = vi.hoisted(() => ({
  config: { isBuild: false, pipeline: {} as { onExecError?: "error" | "warn" } },
  emitted: [] as [string, unknown][],
}));

vi.mock("./config.ts", () => ({ BascikConfig: config }));
vi.mock("./events.ts", () => ({
  eventEmitter: { emit: (name: string, payload: unknown) => emitted.push([name, payload]) },
  runShutdownHandlers: vi.fn(),
}));

import {
  getExecErrorAction,
  reportToleratedExecFailure,
  stopAfterExecFailure,
  toleratingExecFailure,
} from "./exec-policy.ts";

beforeEach(() => {
  config.isBuild = false;
  config.pipeline = {};
  emitted.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("getExecErrorAction", () => {
  it("defaults to warn in dev and error in a build", () => {
    expect(getExecErrorAction()).toBe("warn");
    config.isBuild = true;
    expect(getExecErrorAction()).toBe("error");
  });

  it("lets the configured value win in either mode", () => {
    config.pipeline = { onExecError: "error" };
    expect(getExecErrorAction()).toBe("error");
    config.isBuild = true;
    config.pipeline = { onExecError: "warn" };
    expect(getExecErrorAction()).toBe("warn");
  });
});

describe("toleratingExecFailure", () => {
  it("resolves true when the work succeeds", async () => {
    await expect(toleratingExecFailure(async () => undefined)).resolves.toBe(true);
  });

  it("rethrows under the error action", async () => {
    config.pipeline = { onExecError: "error" };
    await expect(toleratingExecFailure(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(emitted).toEqual([]);
  });

  it("reports a build-error and resolves false under the warn action in dev", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => { });
    await expect(toleratingExecFailure(async () => { throw new Error("boom"); })).resolves.toBe(false);
    expect(errors).toHaveBeenCalledOnce();
    expect(emitted).toEqual([["build-error", { message: "exec failed: boom" }]]);
  });

  it("logs but does not publish a build-error under the warn action in a build", async () => {
    config.isBuild = true;
    config.pipeline = { onExecError: "warn" };
    const errors = vi.spyOn(console, "error").mockImplementation(() => { });
    await expect(toleratingExecFailure(async () => { throw new Error("boom"); })).resolves.toBe(false);
    expect(errors).toHaveBeenCalledOnce();
    expect(emitted).toEqual([]);
  });
});

describe("reportToleratedExecFailure", () => {
  it("names the option so the author knows how to change the behavior", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => { });
    reportToleratedExecFailure(new Error("x"));
    expect(String(errors.mock.calls[0][0])).toContain("pipeline.onExecError");
  });
});

describe("stopAfterExecFailure", () => {
  it("runs shutdown handlers and then exits 1, once, however many failures arrive", async () => {
    vi.spyOn(console, "error").mockImplementation(() => { });
    const order: string[] = [];
    const exit = vi.fn(() => { order.push("exit"); });
    const shutdown = vi.fn(async () => { order.push("shutdown"); });
    stopAfterExecFailure(new Error("one"), { exit, runShutdownHandlers: shutdown });
    stopAfterExecFailure(new Error("two"), { exit, runShutdownHandlers: shutdown });
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(order).toEqual(["shutdown", "exit"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
