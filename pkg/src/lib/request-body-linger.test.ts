/**
 * The bounded drain behind the lingering close: it reads a rejected body to
 * its end, but never past the byte cap or the time cap, and reports a client
 * that went away. The wire-level behavior is covered by
 * body-limit-linger.integration.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import {
  drainRequestBody,
  isLingeringSocket,
  markLingeringSocket,
  LINGER_IDLE_MS,
  LINGER_MAX_BYTES,
  LINGER_MAX_MS,
  type DrainOutcome,
} from "./request-body-linger.ts";

const limits = { maxBytes: 100, idleMs: 1_000, maxMs: 3_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe("drainRequestBody", () => {
  it("reads the body to its end and reports end", async () => {
    const body = new PassThrough();
    const outcome = new Promise<DrainOutcome>((r) =>
      drainRequestBody(body, r, limits),
    );
    body.write(Buffer.alloc(60));
    body.end(Buffer.alloc(30));
    expect(await outcome).toBe("end");
  });

  it("stops at the byte cap and pauses the body (a client that never stops)", async () => {
    const body = new PassThrough();
    const outcome = new Promise<DrainOutcome>((r) =>
      drainRequestBody(body, r, limits),
    );
    body.write(Buffer.alloc(60));
    body.write(Buffer.alloc(60));
    expect(await outcome).toBe("cap");
    expect(body.isPaused()).toBe(true);
  });

  it("stops at the idle cap when the client stalls", async () => {
    vi.useFakeTimers();
    const body = new PassThrough();
    const onSettled = vi.fn();
    drainRequestBody(body, onSettled, limits);
    body.write(Buffer.alloc(1));
    await vi.advanceTimersByTimeAsync(limits.idleMs - 1);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettled).toHaveBeenCalledWith("cap");
  });

  it("every chunk restarts the idle cap, so a slow but steady upload keeps draining", async () => {
    vi.useFakeTimers();
    const body = new PassThrough();
    const onSettled = vi.fn();
    drainRequestBody(body, onSettled, limits);
    // Two gaps just under the idle cap add up to more than it, which would
    // end a drain whose idle timer was set once and never restarted.
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(limits.idleMs - 100);
      body.write(Buffer.alloc(1));
    }
    expect(onSettled).not.toHaveBeenCalled();
    body.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledWith("end");
  });

  it("a trickle that never goes idle is still cut off by the total cap (slowloris)", async () => {
    vi.useFakeTimers();
    const body = new PassThrough();
    const onSettled = vi.fn();
    drainRequestBody(body, onSettled, limits);
    // One byte every 200 ms: never idle, never near the byte cap.
    for (let t = 200; t < limits.maxMs; t += 200) {
      await vi.advanceTimersByTimeAsync(200);
      body.write(Buffer.alloc(1));
    }
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(onSettled).toHaveBeenCalledWith("cap");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("reports gone when the client aborts mid-body", async () => {
    const body = new PassThrough();
    const outcome = new Promise<DrainOutcome>((r) =>
      drainRequestBody(body, r, limits),
    );
    body.write(Buffer.alloc(10));
    body.destroy();
    expect(await outcome).toBe("gone");
  });

  it("reports gone, without throwing, when the body errors", async () => {
    const body = new PassThrough();
    const outcome = new Promise<DrainOutcome>((r) =>
      drainRequestBody(body, r, limits),
    );
    body.destroy(new Error("ECONNRESET"));
    expect(await outcome).toBe("gone");
  });

  it("settles at once for a body that already ended or was destroyed", async () => {
    const ended = new PassThrough();
    ended.resume();
    ended.end();
    await new Promise((r) => ended.once("end", r));
    const onEnded = vi.fn();
    drainRequestBody(ended, onEnded, limits);
    expect(onEnded).toHaveBeenCalledWith("end");

    const destroyed = new PassThrough();
    destroyed.destroy();
    const onDestroyed = vi.fn();
    drainRequestBody(destroyed, onDestroyed, limits);
    expect(onDestroyed).toHaveBeenCalledWith("gone");
  });

  it("settles exactly once and leaves no listeners behind", async () => {
    vi.useFakeTimers();
    const body = new PassThrough();
    const onSettled = vi.fn();
    drainRequestBody(body, onSettled, limits);
    body.write(Buffer.alloc(200)); // byte cap
    await vi.advanceTimersByTimeAsync(limits.maxMs * 2); // and the time cap
    body.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(body.listenerCount("data")).toBe(0);
  });

  it("detaches a stalled pipe so its backpressure cannot stop the drain", async () => {
    const body = new PassThrough();
    // A reader that gave up: it never calls back, so the pipe would pause
    // `body` after its first write and the drain would read nothing.
    const stuck = new Writable({ highWaterMark: 1, write() {} });
    body.pipe(stuck);
    const outcome = new Promise<DrainOutcome>((r) =>
      drainRequestBody(body, r, limits),
    );
    for (let i = 0; i < 5; i++) body.write(Buffer.alloc(10));
    body.end();
    expect(await outcome).toBe("end");
  });

  it("defaults to the documented caps", () => {
    expect(LINGER_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(LINGER_IDLE_MS).toBe(5_000);
    expect(LINGER_MAX_MS).toBe(30_000);
  });
});

describe("lingering sockets", () => {
  it("only a marked socket is lingering; null and undefined are not", () => {
    const socket = {};
    expect(isLingeringSocket(socket)).toBe(false);
    markLingeringSocket(socket);
    expect(isLingeringSocket(socket)).toBe(true);
    expect(isLingeringSocket({})).toBe(false);
    expect(isLingeringSocket(null)).toBe(false);
    expect(isLingeringSocket(undefined)).toBe(false);
  });
});
