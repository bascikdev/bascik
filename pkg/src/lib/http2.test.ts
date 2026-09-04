import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockServer, mockCreateSecureServer, mockStartHttpServer } = vi.hoisted(() => {
  const mockServer = {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    listen: vi.fn().mockImplementation(
      (_port: number, hostnameOrCb: any, cb?: () => void) => {
        const callback = typeof hostnameOrCb === "function" ? hostnameOrCb : cb;
        callback?.();
      },
    ),
    close: vi.fn().mockImplementation((cb?: (err?: Error) => void) => { cb?.(); }),
  };
  const mockCreateSecureServer = vi.fn(() => mockServer);
  const mockStartHttpServer = vi.fn().mockResolvedValue("http://localhost:8443");
  return { mockServer, mockCreateSecureServer, mockStartHttpServer };
});

vi.mock("node:http2", () => ({
  default: {
    createSecureServer: mockCreateSecureServer,
    constants: { NGHTTP2_INTERNAL_ERROR: 2 },
  },
}));

vi.mock("./http.js", () => ({
  startHttpServer: mockStartHttpServer,
  adaptHttp1: vi.fn(() => ({ req: {}, res: {} })),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("mock-cert")),
  access: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn((_cmd: string, cb: any) => cb(null, "", "")),
  execFile: vi.fn((_cmd: string, _args: any, _opts: any, cb: any) => {
    const callback = typeof cb === "function" ? cb : (typeof _opts === "function" ? _opts : _args);
    callback(null, { stdout: "", stderr: "" });
  }),
}));

vi.mock("./config.js", () => ({
  BascikConfig: {
    directory: {
      out: "dist",
    },
    http: {
      tls: {
        enabled: true,
      },
    },
    logging: {
      level: "info",
      requests: true,
    },
  },
  shouldLog: vi.fn(() => true),
}));

import { startHttp2Server, adaptHttp2 } from "./http2.ts";

describe("startHttp2Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a secure HTTP/2 server", async () => {
    await startHttp2Server();
    expect(mockCreateSecureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        allowHTTP1: true,
      })
    );
  });

  it("handles HTTP/1.1 fallback requests via the 'request' listener and ignores HTTP/2 compatibility requests", async () => {
    await startHttp2Server();

    // Find the 'request' listener registered on the server
    const requestCall = mockServer.on.mock.calls.find(c => c[0] === "request");
    expect(requestCall).toBeDefined();
    if (!requestCall) throw new Error("request listener not registered");
    const requestListener = requestCall[1];

    // Case 1: HTTP/2 request (should be ignored by request listener because it is already handled by 'stream')
    const mockReqH2 = { httpVersion: "2.0" };
    const mockResH2 = {};
    const adaptHttp1Mock = vi.mocked(await import("./http.ts")).adaptHttp1;
    adaptHttp1Mock.mockClear();

    await requestListener(mockReqH2, mockResH2);
    expect(adaptHttp1Mock).not.toHaveBeenCalled();

    // Case 2: HTTP/1.1 request (should be handled by request listener)
    const mockReqH1 = { httpVersion: "1.1" };
    const mockResH1 = {};
    await requestListener(mockReqH1, mockResH1);
    expect(adaptHttp1Mock).toHaveBeenCalledWith(mockReqH1, mockResH1);
  });
});

describe("adaptHttp2", () => {
  it("adapts stream and headers and calls stream.end with no arguments when chunk is undefined", () => {
    const mockStream: any = {
      headersSent: false,
      destroyed: false,
      session: { socket: { remoteAddress: "127.0.0.1" } },
      respond: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };

    const { req, res } = adaptHttp2(mockStream, { ":method": "GET", ":path": "/api" });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api");
    expect(req.remoteIp).toBe("127.0.0.1");

    res.respond(200, { "content-type": "application/json" });
    expect(mockStream.respond).toHaveBeenCalledWith({ ":status": 200, "content-type": "application/json" });

    res.end(undefined);
    expect(mockStream.end).toHaveBeenCalledWith();
  });

  it("attaches error event listener to the stream to prevent unhandled error crashes", () => {
    const mockStream: any = {
      headersSent: false,
      destroyed: false,
      session: { socket: { remoteAddress: "127.0.0.1" } },
      respond: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };

    adaptHttp2(mockStream, { ":method": "GET", ":path": "/" });
    expect(mockStream.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("forwards on/off for drain and close to the stream, and off actually removes the listener (prompt 66)", async () => {
    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();
    const mockStream: any = Object.assign(emitter, {
      headersSent: false,
      destroyed: false,
      session: { socket: { remoteAddress: "127.0.0.1" } },
      respond: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      close: vi.fn(),
    });
    const { res } = adaptHttp2(mockStream, { ":method": "GET", ":path": "/" });
    let drains = 0;
    let closes = 0;
    const onDrain = () => { drains++; };
    const onClose = () => { closes++; };
    res.on("drain", onDrain);
    res.on("close", onClose);
    emitter.emit("drain");
    emitter.emit("close");
    expect(drains).toBe(1);
    expect(closes).toBe(1);
    res.off("drain", onDrain);
    res.off("close", onClose);
    emitter.emit("drain");
    emitter.emit("close");
    expect(drains).toBe(1);
    expect(closes).toBe(1);
  });
});
