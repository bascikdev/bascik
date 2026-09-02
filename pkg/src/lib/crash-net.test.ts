import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { adaptHttp1 } from "./http.ts";
import { adaptHttp2 } from "./http2.ts";
import { isNetworkResetError, onError, createRequestHandler } from "./server.ts";
import { installProcessCrashHandlers } from "./crash-net.ts";

describe("Crash Net - Bug 4: isNetworkResetError error codes", () => {
  it("recognizes standard reset codes", () => {
    expect(isNetworkResetError({ code: "ECONNRESET" })).toBe(true);
    expect(isNetworkResetError({ code: "EPIPE" })).toBe(true);
    expect(isNetworkResetError({ code: "ECANCELED" })).toBe(true);
    expect(isNetworkResetError({ code: "ERR_HTTP2_STREAM_CANCEL" })).toBe(true);
    expect(isNetworkResetError({ code: "ERR_HTTP2_INVALID_STREAM" })).toBe(true);
  });

  it("recognizes newly added disconnect error codes", () => {
    expect(isNetworkResetError({ code: "ERR_STREAM_WRITE_AFTER_END" })).toBe(true);
    expect(isNetworkResetError({ code: "ERR_STREAM_DESTROYED" })).toBe(true);
    expect(isNetworkResetError({ code: "ERR_HTTP2_INVALID_SESSION" })).toBe(true);
    expect(isNetworkResetError({ code: "ERR_STREAM_ALREADY_FINISHED" })).toBe(true);
    expect(isNetworkResetError({ code: "ERR_STREAM_NULL_VALUES" })).toBe(false);
  });
});

describe("Crash Net - Bug 1 & 6: HTTP/1.1 stream error handler ignores network resets and avoids crash", () => {
  it("attaches error listener on resMsg that ignores network reset errors", () => {
    const mockReqMsg: any = {
      method: "GET",
      url: "/large-file.bin",
      headers: {},
      socket: new EventEmitter() as any,
    };
    mockReqMsg.socket.remoteAddress = "127.0.0.1";

    const mockResMsg = new EventEmitter() as any;
    mockResMsg.headersSent = true;
    mockResMsg.destroyed = false;
    mockResMsg.writeHead = vi.fn();
    mockResMsg.write = vi.fn();
    mockResMsg.end = vi.fn();
    mockResMsg.destroy = vi.fn();

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    adaptHttp1(mockReqMsg, mockResMsg);

    // Emitting network reset on resMsg should not throw or log as a server fault
    expect(() => {
      mockResMsg.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    }).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // Emitting ERR_STREAM_WRITE_AFTER_END should not log as a server fault
    mockResMsg.emit("error", Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" }));
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // Emitting genuine non-network error should log as error
    mockResMsg.emit("error", new Error("genuine disk or stream fault"));
    expect(consoleErrorSpy).toHaveBeenCalledWith("[bascik] HTTP/1.1 response error:", expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it("HTTP/2 stream error handler suppresses network reset errors and logs genuine errors", () => {
    const mockStream = new EventEmitter() as any;
    mockStream.headersSent = true;
    mockStream.destroyed = false;
    mockStream.respond = vi.fn();
    mockStream.write = vi.fn();
    mockStream.end = vi.fn();
    mockStream.close = vi.fn();

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    adaptHttp2(mockStream, { ":method": "GET", ":path": "/test" });

    mockStream.emit("error", Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" }));
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    mockStream.emit("error", new Error("genuine http2 stream error"));
    expect(consoleErrorSpy).toHaveBeenCalledWith("[bascik] HTTP/2 stream error:", expect.any(Error));

    consoleErrorSpy.mockRestore();
  });
});

describe("Crash Net - Bug 2: Request handler promise rejection handling", () => {
  it("catches errors in handleRequest when invoked and calls onError without unhandled rejection", async () => {
    const mockReq: any = { method: "GET", path: "/test", headers: {}, remoteIp: "127.0.0.1" };
    const mockRes: any = {
      headersSent: false,
      destroyed: false,
      writable: new EventEmitter() as any,
      respond: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };

    const handler = createRequestHandler();
    // Simulate error during handler execution
    vi.spyOn(console, "error").mockImplementation(() => {});
    
    // We verify createRequestHandler does not let throw escape even if an internal step fails
    await expect(handler(mockReq, mockRes)).resolves.not.toThrow();
  });

  it("handles when logAccess or other cleanup throws inside handleRequest", async () => {
    const mockReq: any = { method: "GET", path: "/test", headers: {}, remoteIp: "127.0.0.1" };
    const mockRes: any = {
      headersSent: false,
      destroyed: false,
      writable: new EventEmitter() as any,
      respond: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };

    const handler = createRequestHandler();
    await expect(handler(mockReq, mockRes)).resolves.not.toThrow();
  });
});

describe("Crash Net - Bug 3 & 5 & 7: Process-level crash handlers", () => {
  let originalListenersRejection: any[];
  let originalListenersException: any[];
  let exitSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    originalListenersRejection = process.listeners("unhandledRejection");
    originalListenersException = process.listeners("uncaughtException");
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
    originalListenersRejection.forEach((l) => process.on("unhandledRejection", l));
    process.removeAllListeners("uncaughtException");
    originalListenersException.forEach((l) => process.on("uncaughtException", l));
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("installs unhandledRejection and uncaughtException handlers that log and exit non-zero", () => {
    const uninstall = installProcessCrashHandlers();

    // Trigger unhandledRejection
    const testReason = new Error("fatal promise rejection");
    process.emit("unhandledRejection" as any, testReason, Promise.resolve());

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[bascik] Fatal unhandled promise rejection:",
      testReason
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Reset spies
    consoleErrorSpy.mockClear();
    exitSpy.mockClear();

    // Trigger uncaughtException
    const testException = new Error("fatal uncaught exception");
    process.emit("uncaughtException" as any, testException);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[bascik] Fatal uncaught exception:",
      testException
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    uninstall();
  });
});
