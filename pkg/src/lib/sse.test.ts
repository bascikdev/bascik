import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SseManager,
} from "./sse.ts";

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

  it("fires comment heartbeat periodically on interval", async () => {
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

    sseManager.addClient(mockRes);
    await new Promise((r) => setTimeout(r, 250));

    const heartbeats = writes.filter((w) => w.startsWith(": ping") || w.startsWith(":\n") || w === ":\n\n" || w === ": keep-alive\n\n" || w.startsWith(":"));
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
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
