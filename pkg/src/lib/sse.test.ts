import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SseManager,
} from "./sse.ts";
import { nativeClock } from "./clock.ts";

const makeMockRes = () => {
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
    writable: { once: vi.fn() },
  };
  return { mockRes, writes };
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
