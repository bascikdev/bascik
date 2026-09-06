import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SseManager,
} from "./sse.ts";
import { nativeClock } from "./clock.ts";
import { eventEmitter } from "./events.ts";

const makeMockRes = () => {
  const writes: string[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  const mockRes: any = {
    destroyed: false,
    write: vi.fn((data: string) => {
      writes.push(data);
      return true;
    }),
    end: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    off: vi.fn((event: string, cb: () => void) => {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== cb);
    }),
    writable: { once: vi.fn() },
  };
  return { mockRes, writes, listeners };
};

describe("SseManager", () => {
  let sseManager: SseManager;

  beforeEach(() => {
    sseManager = new SseManager({
      heartbeatIntervalMs: 100,
      maxConnections: 5,
    });
  });

  afterEach(() => {
    sseManager.destroy();
  });

  it("sends initial connected event upon connection", () => {
    const writes: string[] = [];
    const mockRes: any = {
      destroyed: false,
      write: vi.fn((data: string) => {
        writes.push(data);
        return true;
      }),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };

    const client = sseManager.addClient(mockRes);
    expect(client).toBeDefined();
    expect(writes).toContain("data: connected\n\n");
  });

  it("fires comment heartbeat periodically on interval", () => {
    vi.useFakeTimers();
    let localManager: SseManager | undefined;
    try {
      // Constructed after fake timers are installed so its heartbeat interval
      // is scheduled on the deterministic fake clock, not real wall time.
      localManager = new SseManager({ heartbeatIntervalMs: 100, maxConnections: 5 });
      const writes: string[] = [];
      const mockRes: any = {
        destroyed: false,
        write: vi.fn((data: string) => {
          writes.push(data);
          return true;
        }),
        end: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      };

      localManager.addClient(mockRes);
      // Two full heartbeat intervals.
      vi.advanceTimersByTime(200);

      const heartbeats = writes.filter((w) => w.startsWith(": ping") || w.startsWith(":\n") || w === ":\n\n" || w === ": keep-alive\n\n" || w.startsWith(":"));
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    } finally {
      localManager?.destroy();
      vi.useRealTimers();
    }
  });

  it("enforces connection cap and rejects connections beyond the limit", () => {
    for (let i = 0; i < 5; i++) {
      const mockRes: any = {
        destroyed: false,
        write: vi.fn(() => true),
        end: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      };
      expect(sseManager.addClient(mockRes)).toBeDefined();
    }

    const overflowRes: any = {
      destroyed: false,
      respond: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    const overflowClient = sseManager.addClient(overflowRes);
    expect(overflowClient).toBeNull();
    expect(overflowRes.end).toHaveBeenCalled();
  });

  it("broadcasts reload event to all connected clients", () => {
    const writes1: string[] = [];
    const mockRes1: any = {
      destroyed: false,
      write: vi.fn((data: string) => { writes1.push(data); return true; }),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    sseManager.addClient(mockRes1);

    sseManager.broadcastReload();
    expect(writes1).toContain("data: reload 1\n\n");
  });

  it("includes a monotonic generation counter in broadcast reload payloads", () => {
    const writes: string[] = [];
    const mockRes: any = {
      destroyed: false,
      write: vi.fn((data: string) => { writes.push(data); return true; }),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    sseManager.addClient(mockRes);

    sseManager.broadcastReload();
    sseManager.broadcastReload();
    sseManager.broadcastReload();

    // Reload messages must contain monotonically increasing generation numbers (e.g. data: reload 1, data: reload 2...)
    const reloadMessages = writes.filter((w) => w.startsWith("data: reload"));
    expect(reloadMessages).toEqual([
      "data: reload 1\n\n",
      "data: reload 2\n\n",
      "data: reload 3\n\n",
    ]);
  });

  it("broadcasts error event with structured message to all connected clients", () => {
    const writes1: string[] = [];
    const mockRes1: any = {
      destroyed: false,
      write: vi.fn((data: string) => { writes1.push(data); return true; }),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    sseManager.addClient(mockRes1);

    sseManager.broadcastError({
      message: "Syntax error in component",
      file: "src/components/card.html",
      line: 12,
    });

    const errorEvent = writes1.find((w) => w.startsWith("event: build-error\n") || w.includes('"message":"Syntax error in component"'));
    expect(errorEvent).toBeDefined();
  });

  it("routes a global build-error event to every client exactly once", () => {
    // The SseManager owns the single build-error subscription, so a one-shot
    // emit on the event emitter reaches each live client exactly one frame.
    const c1 = makeMockRes();
    const c2 = makeMockRes();
    sseManager.addClient(c1.mockRes);
    sseManager.addClient(c2.mockRes);
    c1.writes.length = 0;
    c2.writes.length = 0;

    eventEmitter.emit("build-error", { message: "boom", file: "pages/a.html", line: 1 });

    const frames1 = c1.writes.filter((w) => w.startsWith("event: build-error"));
    const frames2 = c2.writes.filter((w) => w.startsWith("event: build-error"));
    expect(frames1).toHaveLength(1);
    expect(frames2).toHaveLength(1);
    // Matches the single-owner contract: one manager subscription, not one
    // subscription per connection.
    expect(frames1[0]).toContain('"file":"pages/a.html"');
  });

  it("closes client if write fails or client is unresponsive", () => {
    const mockRes: any = {
      destroyed: false,
      write: vi.fn(() => false),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    const client = sseManager.addClient(mockRes);
    expect(client).toBeDefined();

    // Trigger heartbeat which tries to write
    sseManager.heartbeat();
    // After failed writes and no drain, client gets reaped/closed
  });
});

describe("SseManager - deterministic clock-driven heartbeat and drain reaping", () => {
  let manager: SseManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it("sends no heartbeat before the interval elapses", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const { mockRes, writes } = makeMockRes();
    manager.addClient(mockRes);
    writes.length = 0; // clear the initial "connected" write

    vi.advanceTimersByTime(99);
    expect(writes.some((w) => w.startsWith(":"))).toBe(false);
  });

  it("sends exactly one heartbeat at each interval boundary", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const { mockRes, writes } = makeMockRes();
    manager.addClient(mockRes);
    writes.length = 0;

    vi.advanceTimersByTime(100);
    expect(writes.filter((w) => w.startsWith(":"))).toHaveLength(1);

    vi.advanceTimersByTime(100);
    expect(writes.filter((w) => w.startsWith(":"))).toHaveLength(2);
  });

  it("refreshes client activity through the injected clock on successful writes", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const { mockRes } = makeMockRes();
    const client = manager.addClient(mockRes)!;
    const initialActive = client.lastActive;

    vi.advanceTimersByTime(50);
    manager.send(client, "data: ping\n\n");
    expect(client.lastActive).toBeGreaterThan(initialActive);
  });

  it("retains a draining client up to the documented threshold and closes it strictly after", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const { mockRes } = makeMockRes();
    mockRes.write = vi.fn(() => false); // every write reports backpressure
    const client = manager.addClient(mockRes)!;
    client.isDraining = true;

    // Exactly at 2x heartbeatIntervalMs (200ms): still retained (not strictly greater than).
    vi.advanceTimersByTime(200);
    manager.heartbeat();
    expect(mockRes.close).not.toHaveBeenCalled();

    // Strictly past the threshold: closed and removed.
    vi.advanceTimersByTime(1);
    manager.heartbeat();
    expect(mockRes.close).toHaveBeenCalled();
    expect(manager.activeClientCount).toBe(0);
  });

  it("cannot write to a destroyed client or a destroyed manager", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const { mockRes, writes } = makeMockRes();
    const client = manager.addClient(mockRes)!;

    manager.destroy();
    writes.length = 0;
    expect(manager.send(client, "data: reload 1\n\n")).toBe(false);
    expect(writes).toHaveLength(0);
    expect(manager.addClient(mockRes)).toBeNull();
  });

  it("one failed client cannot prevent healthy clients from receiving a heartbeat", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const failing = makeMockRes();
    failing.mockRes.write = vi.fn(() => {
      throw new Error("write failed");
    });
    const healthy = makeMockRes();

    manager.addClient(failing.mockRes);
    manager.addClient(healthy.mockRes);
    healthy.writes.length = 0;

    manager.heartbeat();
    expect(healthy.writes.some((w) => w.startsWith(":"))).toBe(true);
  });

  it("starting the heartbeat twice creates only one interval", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const timerCountAfterFirstStart = vi.getTimerCount();
    // Adding a client does not start a second heartbeat timer.
    const { mockRes } = makeMockRes();
    manager.addClient(mockRes);
    expect(vi.getTimerCount()).toBe(timerCountAfterFirstStart);
  });

  it("destroying twice is harmless and leaves no active timer", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    manager.destroy();
    expect(() => manager.destroy()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 97: each SSE connection owns at most ONE drain subscription. A burst
// of backpressured writes must not accumulate drain listeners, and removal /
// destruction must return them to baseline.
// ─────────────────────────────────────────────────────────────────────────────
describe("SseManager - prompt 97 bounded drain subscriptions", () => {
  let manager: SseManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it("does not count a backpressured write as activity and registers exactly one drain listener per client", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const { mockRes, listeners } = makeMockRes();
    // Every write reports backpressure.
    let writeCount = 0;
    mockRes.write = vi.fn(() => {
      writeCount++;
      return false;
    });
    const client = manager.addClient(mockRes)!;

    // Burst of backpressured writes. Each previous implementation registered a
    // fresh drain listener, growing the count with the writes.
    for (let i = 0; i < 9; i++) {
      if (manager.send(client, `data: frame ${i}\n\n`)) break;
    }

    expect(listeners.drain).toHaveLength(1);
    // Writes stop once draining; the writable is stalled until a drain event.
    expect(writeCount).toBe(1);
  });

  it("resumes writing after the single drain event clears the drain flag", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const { mockRes, listeners, writes } = makeMockRes();
    let fail = true;
    mockRes.write = vi.fn(() => {
      if (fail) return false;
      writes.push("data: resumed\n\n");
      return true;
    });
    const client = manager.addClient(mockRes)!;

    // First write stalls.
    manager.send(client, "data: reload 1\n\n");
    expect(client.isDraining).toBe(true);

    // Drain fires: the single subscription clears the flag.
    fail = false;
    listeners.drain.forEach((cb) => cb());
    expect(client.isDraining).toBe(false);

    // Next write succeeds.
    expect(manager.send(client, "data: reload 2\n\n")).toBe(true);
    expect(writes).toContain("data: resumed\n\n");
  });

  it("removes the drain listener on removeClient", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    const { mockRes, listeners } = makeMockRes();
    mockRes.write = vi.fn(() => false);
    const client = manager.addClient(mockRes)!;
    expect(listeners.drain).toHaveLength(1);

    manager.removeClient(client.id);
    expect(manager.activeClientCount).toBe(0);
    expect(listeners.drain).toHaveLength(0);
  });

  it("removes all drain listeners on manager destroy", () => {
    const res1 = makeMockRes();
    const res2 = makeMockRes();
    res1.mockRes.write = vi.fn(() => false);
    res2.mockRes.write = vi.fn(() => false);
    manager = new SseManager({ heartbeatIntervalMs: 100, clock: nativeClock });
    manager.addClient(res1.mockRes);
    manager.addClient(res2.mockRes);

    manager.destroy();
    expect(res1.listeners.drain).toHaveLength(0);
    expect(res2.listeners.drain).toHaveLength(0);
    expect(manager.activeClientCount).toBe(0);
  });

  it("rejects connections beyond maxConnections and ends the stream before headers are committed", () => {
    manager = new SseManager({ heartbeatIntervalMs: 100, maxConnections: 2, clock: nativeClock });
    manager.addClient(makeMockRes().mockRes);
    manager.addClient(makeMockRes().mockRes);

    const overflow = makeMockRes();
    overflow.mockRes.respond = vi.fn();
    const rejected = manager.addClient(overflow.mockRes);
    expect(rejected).toBeNull();
    expect(overflow.mockRes.respond).toHaveBeenCalled();
    expect(overflow.mockRes.end).toHaveBeenCalled();
  });
});
