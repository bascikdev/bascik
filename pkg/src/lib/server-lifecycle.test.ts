import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setServerHealthState,
  getServerHealthState,
  isHealthEndpoint,
  handleHealthCheck,
  createGracefulShutdownHandler,
} from "./server-lifecycle.ts";

describe("Health state management", () => {
  beforeEach(() => {
    setServerHealthState("booting");
  });

  it("reports non-200 (503) during booting", () => {
    expect(getServerHealthState()).toBe("booting");
    const result = handleHealthCheck();
    expect(result.status).toBe(503);
    expect(result.body).toContain("booting");
  });

  it("reports 200 OK when ready", () => {
    setServerHealthState("ready");
    expect(getServerHealthState()).toBe("ready");
    const result = handleHealthCheck();
    expect(result.status).toBe(200);
    expect(result.body).toContain("ok");
  });

  it("reports non-200 (503) during draining / shutting-down", () => {
    setServerHealthState("draining");
    expect(getServerHealthState()).toBe("draining");
    const result = handleHealthCheck();
    expect(result.status).toBe(503);
    expect(result.body).toContain("draining");
  });

  it("identifies health endpoint path correctly", () => {
    expect(isHealthEndpoint("/_health")).toBe(true);
    expect(isHealthEndpoint("/_health/ready")).toBe(true);
    expect(isHealthEndpoint("/_health/live")).toBe(true);
    expect(isHealthEndpoint("/health")).toBe(false);
    expect(isHealthEndpoint("/about")).toBe(false);
  });

  it("returns no-cache headers on health response", () => {
    setServerHealthState("ready");
    const result = handleHealthCheck();
    expect(result.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");
  });
});

describe("executeGracefulShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sets health state to draining and calls onShutdown and runShutdownHandlers", async () => {
    setServerHealthState("ready");
    const mockExit = vi.fn();
    const mockOnShutdown = vi.fn();
    const mockRunShutdownHandlers = vi.fn().mockResolvedValue(undefined);
    const mockServer = {
      close: vi.fn((cb?: (err?: Error) => void) => {
        cb?.();
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 5000,
      onShutdown: mockOnShutdown,
      runShutdownHandlers: mockRunShutdownHandlers,
      exit: mockExit,
    });

    shutdown("SIGTERM");

    expect(getServerHealthState()).toBe("draining");
    expect(mockServer.closeIdleConnections).toHaveBeenCalled();
    expect(mockOnShutdown).toHaveBeenCalled();
    expect(mockServer.closeAllConnections).not.toHaveBeenCalled();
    expect(mockRunShutdownHandlers).toHaveBeenCalled();
    expect(mockServer.close).toHaveBeenCalled();

    // Await promise microtasks
    await Promise.resolve();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("waits for both server close and async shutdown handlers before exiting", async () => {
    const mockExit = vi.fn();
    let resolveHandlers: () => void = () => {};
    const handlersPromise = new Promise<void>((res) => {
      resolveHandlers = res;
    });
    let closeCallback: ((err?: Error) => void) | undefined;
    const mockServer = {
      close: vi.fn((cb?: (err?: Error) => void) => {
        closeCallback = cb;
      }),
      closeIdleConnections: vi.fn(),
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 5000,
      runShutdownHandlers: () => handlersPromise,
      exit: mockExit,
    });

    shutdown("SIGTERM");

    // Server close completes first
    closeCallback?.();
    await Promise.resolve();
    expect(mockExit).not.toHaveBeenCalled();

    // Now async handlers resolve
    resolveHandlers();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 if shutdown handlers reject", async () => {
    const mockExit = vi.fn();
    const mockServer = {
      close: vi.fn((cb?: (err?: Error) => void) => {
        cb?.();
      }),
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 5000,
      runShutdownHandlers: vi.fn().mockRejectedValue(new Error("cleanup failed")),
      exit: mockExit,
    });

    shutdown("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("invokes onForceClose and closeAllConnections only when drain timeout expires", () => {
    const mockExit = vi.fn();
    const mockOnForceClose = vi.fn();
    const mockServer = {
      close: vi.fn(), // Hangs
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 5000,
      onForceClose: mockOnForceClose,
      exit: mockExit,
    });

    shutdown("SIGTERM");
    expect(mockServer.closeAllConnections).not.toHaveBeenCalled();
    expect(mockOnForceClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(mockServer.closeAllConnections).toHaveBeenCalled();
    expect(mockOnForceClose).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("is idempotent on repeated invocations (e.g. SIGTERM followed by SIGINT)", () => {
    const mockExit = vi.fn();
    const mockServer = {
      close: vi.fn(),
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 5000,
      exit: mockExit,
    });

    shutdown("SIGTERM");
    shutdown("SIGINT");

    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });

  it("cancels force-exit timer when server close completes before deadline", async () => {
    const mockExit = vi.fn();
    let closeCallback: ((err?: Error) => void) | undefined;
    const mockServer = {
      close: vi.fn((cb?: (err?: Error) => void) => {
        closeCallback = cb;
      }),
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 5000,
      runShutdownHandlers: vi.fn().mockResolvedValue(undefined),
      exit: mockExit,
    });

    shutdown("SIGTERM");
    await Promise.resolve();
    expect(mockExit).not.toHaveBeenCalled();

    // Server close succeeds at 1000ms
    vi.advanceTimersByTime(1000);
    closeCallback?.();
    await Promise.resolve();
    expect(mockExit).toHaveBeenCalledWith(0);

    // Advance past drainTimeout: force-exit must not fire
    vi.advanceTimersByTime(10000);
    expect(mockExit).toHaveBeenCalledTimes(1);
  });

  it("forces exit with code 1 if server close does not complete before deadline", () => {
    const mockExit = vi.fn();
    const mockServer = {
      close: vi.fn(), // Hangs, never calls callback
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 5000,
      exit: mockExit,
    });

    shutdown("SIGTERM");

    vi.advanceTimersByTime(4999);
    expect(mockExit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("shutdown-handler rejection does not prevent server.close or force-exit fail-safe", () => {
    const mockExit = vi.fn();
    const mockRunShutdownHandlers = vi.fn().mockRejectedValue(new Error("shutdown error"));
    const mockServer = {
      close: vi.fn(),
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 3000,
      runShutdownHandlers: mockRunShutdownHandlers,
      exit: mockExit,
    });

    shutdown("SIGTERM");
    expect(mockServer.close).toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("late close after force-exit timeout does not double-exit", () => {
    const mockExit = vi.fn();
    let closeCallback: ((err?: Error) => void) | undefined;
    const mockServer = {
      close: vi.fn((cb?: (err?: Error) => void) => {
        closeCallback = cb;
      }),
    };

    const shutdown = createGracefulShutdownHandler({
      server: mockServer as any,
      drainTimeout: 5000,
      exit: mockExit,
    });

    shutdown("SIGTERM");

    // Advance past deadline -> exits with 1
    vi.advanceTimersByTime(5000);
    expect(mockExit).toHaveBeenCalledWith(1);

    // Late server close fires
    closeCallback?.();
    expect(mockExit).toHaveBeenCalledTimes(1);
  });

  it("allows real in-flight HTTP request to complete before shutdown exit", async () => {
    vi.useRealTimers();
    const http = await import("node:http");
    let releaseRequest: () => void = () => {};
    const requestHoldPromise = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });

    const server = http.createServer((_req, res) => {
      requestHoldPromise.then(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("completed-ok");
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    let exitCode: number | null = null;
    const shutdown = createGracefulShutdownHandler({
      server,
      drainTimeout: 5000,
      exit: (code) => {
        exitCode = code;
      },
    });

    // Start request with connection: close so client drops socket upon completion
    const responsePromise = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const clientReq = http.get(
        `http://127.0.0.1:${port}/test`,
        { headers: { connection: "close" }, agent: false },
        (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
        }
      );
      clientReq.on("error", reject);
    });

    // Give time for request to reach server
    await new Promise((r) => setTimeout(r, 50));

    // Initiate graceful shutdown while request is in flight
    shutdown("SIGTERM");

    // Release in-flight request
    releaseRequest();

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("completed-ok");

    // Wait for server close to settle exit
    await new Promise((r) => setTimeout(r, 50));
    expect(exitCode).toBe(0);
  });
});
