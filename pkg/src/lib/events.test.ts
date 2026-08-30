import { describe, it, expect, vi } from "vitest";
import EventEmitter from "node:events";
import { eventEmitter, registerShutdownHandler, runShutdownHandlers } from "./events.ts";

describe("eventEmitter", () => {
  it("is an EventEmitter instance", () => {
    expect(eventEmitter).toBeInstanceOf(EventEmitter);
  });

  it("can emit and listen to an arbitrary event", () => {
    const listener = vi.fn();
    eventEmitter.on("test-event", listener);
    eventEmitter.emit("test-event", "payload");
    expect(listener).toHaveBeenCalledWith("payload");
    eventEmitter.removeListener("test-event", listener);
  });

  it("supports multiple listeners for the same event", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    eventEmitter.on("multi-event", l1);
    eventEmitter.on("multi-event", l2);
    eventEmitter.emit("multi-event");
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
    eventEmitter.removeListener("multi-event", l1);
    eventEmitter.removeListener("multi-event", l2);
  });

  it("can emit the asset-changed event", () => {
    const handler = vi.fn();
    eventEmitter.on("asset-changed", handler);
    eventEmitter.emit("asset-changed");
    expect(handler).toHaveBeenCalledTimes(1);
    eventEmitter.removeListener("asset-changed", handler);
  });

  it("can emit the transpiled event with a payload", () => {
    const handler = vi.fn();
    eventEmitter.on("transpiled", handler);
    eventEmitter.emit("transpiled", { relativePagePath: "pages/index.html" });
    expect(handler).toHaveBeenCalledWith({
      relativePagePath: "pages/index.html",
    });
    eventEmitter.removeListener("transpiled", handler);
  });

  it("registers and executes shutdown handlers", async () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn(async () => { });
    registerShutdownHandler(fn1);
    registerShutdownHandler(fn2);
    await runShutdownHandlers();
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});
