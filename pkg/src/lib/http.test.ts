import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockServer, mockCreateServer } = vi.hoisted(() => {
  const mockServer = {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    listen: vi
      .fn()
      .mockImplementation(
        (_port: number, _hostname: string, cb?: () => void) => {
          cb?.();
        },
      ),
    close: vi.fn().mockImplementation((cb?: (err?: Error) => void) => {
      cb?.();
    }),
  };
  const mockCreateServer = vi.fn(() => mockServer);
  return { mockServer, mockCreateServer };
});

vi.mock("node:http", () => ({
  default: {
    createServer: mockCreateServer,
  },
}));

vi.mock("./config.js", () => ({
  BascikConfig: {
    http: {
      hostname: "localhost",
      port: 8443,
    },
  },
}));

vi.mock("./server.js", () => ({
  createRequestHandler: vi.fn(() => vi.fn()),
  startServerInstance: vi.fn(async () => "http://localhost:8443"),
}));

import { startHttpServer, adaptHttp1, handleCheckContinue } from "./http.ts";

describe("startHttpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a standard http server", async () => {
    const res = await startHttpServer();
    expect(mockCreateServer).toHaveBeenCalled();
    expect(res).toBe("http://localhost:8443");
  });

  it("applies http.timeouts (defaults when unset) to the server", async () => {
    await startHttpServer();
    expect(mockCreateServer).toHaveBeenCalledWith(
      expect.objectContaining({
        requestTimeout: 30000,
        headersTimeout: 10000,
        connectionsCheckingInterval: 5000,
        keepAliveTimeout: 5000,
      }),
    );
  });

  it("adapts standard http request and response messages", () => {
    const mockReqMsg: any = {
      method: "GET",
      url: "/home",
      headers: { accept: "text/html" },
      socket: { remoteAddress: "192.168.1.1" },
      once: vi.fn(),
    };

    const mockResMsg: any = {
      headersSent: false,
      destroyed: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };

    const { req, res } = adaptHttp1(mockReqMsg, mockResMsg);

    expect(req.method).toBe("GET");
    expect(req.path).toBe("/home");
    expect(req.remoteIp).toBe("192.168.1.1");

    res.respond(200, { "content-type": "text/html" });
    expect(mockResMsg.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "text/html",
    });

    res.write("content");
    expect(mockResMsg.write).toHaveBeenCalledWith("content");

    res.end("ending");
    expect(mockResMsg.end).toHaveBeenCalledWith("ending");
  });

  it("calls resMsg.end with no arguments when chunk is undefined", () => {
    const mockReqMsg: any = {
      method: "HEAD",
      url: "/home",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      once: vi.fn(),
    };
    const mockResMsg: any = {
      headersSent: false,
      destroyed: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };

    const { res } = adaptHttp1(mockReqMsg, mockResMsg);
    res.end(undefined);
    expect(mockResMsg.end).toHaveBeenCalledWith();
  });

  it("handles missing method and remoteAddress, and handles close/on", () => {
    const mockReqMsg: any = {
      method: undefined,
      url: "/",
      headers: {},
      socket: {},
      once: vi.fn(),
    };
    const mockResMsg: any = {
      headersSent: false,
      destroyed: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };

    const { req, res } = adaptHttp1(mockReqMsg, mockResMsg);
    expect(req.method).toBe("GET");
    expect(req.remoteIp).toBe("unknown");

    res.respond(200, { "content-type": "text/plain" });
    expect(mockResMsg.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "text/plain",
    });

    res.close();
    expect(mockResMsg.destroy).toHaveBeenCalled();

    const cb = () => {};
    res.on("close", cb);
    expect(mockResMsg.on).toHaveBeenCalledWith("close", cb);
  });

  it("forwards on/off for drain and close to the response, and off actually removes the listener (prompt 66)", async () => {
    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();
    const mockResMsg: any = Object.assign(emitter, {
      headersSent: false,
      destroyed: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const { res } = adaptHttp1(
      {
        method: "GET",
        url: "/",
        headers: {},
        socket: {},
        once: vi.fn(),
      } as any,
      mockResMsg,
    );
    let drains = 0;
    let closes = 0;
    const onDrain = () => {
      drains++;
    };
    const onClose = () => {
      closes++;
    };
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

  it("passes an onForceClose callback to startServerInstance that destroys open sockets even if socket.destroy throws", async () => {
    let connectionCb: ((socket: any) => void) | undefined;
    let forceCloseCb: (() => void) | undefined;

    mockServer.on.mockImplementation((event: string, cb: any) => {
      if (event === "connection") connectionCb = cb;
      return mockServer;
    });

    const { startServerInstance } = await import("./server.ts");
    (startServerInstance as any).mockImplementation(
      async (
        _server: any,
        _protocol: string,
        _onShutdown?: () => void,
        onForceClose?: () => void,
      ) => {
        forceCloseCb = onForceClose;
        return "http://localhost:8443";
      },
    );

    await startHttpServer();

    expect(connectionCb).toBeDefined();
    expect(forceCloseCb).toBeDefined();

    const mockSocket = {
      destroy: vi.fn().mockImplementation(() => {
        throw new Error("Socket error");
      }),
      once: vi.fn(),
    };

    connectionCb!(mockSocket);
    expect(() => forceCloseCb!()).not.toThrow();
    expect(mockSocket.destroy).toHaveBeenCalled();
  });
});

describe("adaptHttp1 lingering close", () => {
  const makeMessages = async () => {
    const { PassThrough } = await import("node:stream");
    const body = new PassThrough();
    const reqMsg: any = Object.assign(body, {
      method: "POST",
      url: "/api/upload",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    });
    const resMsg: any = {
      headersSent: false,
      destroyed: false,
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };
    return { body, reqMsg, resMsg };
  };

  it("forces Connection: close, replacing any case variant", async () => {
    const { reqMsg, resMsg } = await makeMessages();
    const { res } = adaptHttp1(reqMsg, resMsg);
    res.lingerClose!();
    res.respond(413, { Connection: "keep-alive", "content-length": 17 });
    expect(resMsg.writeHead).toHaveBeenCalledWith(413, {
      "content-length": 17,
      connection: "close",
    });
  });

  it("writes the response at once but ends it only after the body is drained", async () => {
    const { body, reqMsg, resMsg } = await makeMessages();
    const { res } = adaptHttp1(reqMsg, resMsg);
    res.lingerClose!();
    res.respond(413, { "content-length": 17 });
    res.end("Payload Too Large");
    // Complete on the wire (length-delimited), but the socket stays open
    // so the client can finish its upload.
    expect(resMsg.write).toHaveBeenCalledWith("Payload Too Large");
    expect(resMsg.end).not.toHaveBeenCalled();
    body.write(Buffer.alloc(1024));
    body.end();
    await new Promise((r) => body.once("end", r));
    expect(resMsg.end).toHaveBeenCalledTimes(1);
  });

  it("ends normally when the body already finished before end()", async () => {
    const { body, reqMsg, resMsg } = await makeMessages();
    body.resume();
    body.end();
    await new Promise((r) => body.once("end", r));
    const { res } = adaptHttp1(reqMsg, resMsg);
    res.lingerClose!();
    res.end("done");
    expect(resMsg.end).toHaveBeenCalledWith("done");
  });

  it("does not end a response the client already destroyed by aborting", async () => {
    const { body, reqMsg, resMsg } = await makeMessages();
    const { res } = adaptHttp1(reqMsg, resMsg);
    res.lingerClose!();
    res.end("Payload Too Large");
    resMsg.destroyed = true;
    body.destroy();
    await new Promise((r) => body.once("close", r));
    expect(resMsg.end).not.toHaveBeenCalled();
  });

  it("a lingerClose after the headers went out defers close() until the drain settles", async () => {
    // A streamed response (an echo) tripped the limit after commit: the
    // truncating close must not RST a client that is still uploading.
    const { body, reqMsg, resMsg } = await makeMessages();
    const { res } = adaptHttp1(reqMsg, resMsg);
    res.respond(200, {});
    resMsg.headersSent = true;
    res.lingerClose!();
    res.close();
    expect(resMsg.destroy).not.toHaveBeenCalled();
    body.end(Buffer.alloc(10));
    await new Promise((r) => body.once("end", r));
    expect(resMsg.destroy).toHaveBeenCalledTimes(1);
  });

  it("a lingerClose after keep-alive headers went out still closes the socket after the response", async () => {
    // The headers promised keep-alive, but the connection may hold the
    // unread rest of a body, so it can never carry another request.
    const { body, reqMsg, resMsg } = await makeMessages();
    reqMsg.socket.end = vi.fn();
    resMsg.end = vi.fn((cb?: unknown) => {
      if (typeof cb === "function") cb();
    });
    const { res } = adaptHttp1(reqMsg, resMsg);
    res.respond(200, {});
    resMsg.headersSent = true;
    res.lingerClose!();
    res.end();
    expect(resMsg.end).not.toHaveBeenCalled();
    body.end();
    await new Promise((r) => body.once("end", r));
    expect(resMsg.end).toHaveBeenCalledTimes(1);
    expect(reqMsg.socket.end).toHaveBeenCalledTimes(1);
  });

  it("startHttpServer never serves a request pipelined behind a rejected body", async () => {
    let requestCb: ((reqMsg: any, resMsg: any) => unknown) | undefined;
    mockServer.on.mockImplementation((event: string, cb: any) => {
      if (event === "request") requestCb = cb;
      return mockServer;
    });
    const { createRequestHandler } = await import("./server.ts");
    const handle = vi.fn(async () => {});
    (createRequestHandler as any).mockReturnValue(handle);
    await startHttpServer();

    const { reqMsg, resMsg } = await makeMessages();
    adaptHttp1(reqMsg, resMsg).res.lingerClose!();

    const pipelined: any = {
      method: "GET",
      url: "/api/healthy",
      headers: {},
      socket: reqMsg.socket,
      resume: vi.fn(),
      once: vi.fn(),
    };
    requestCb!(pipelined, { ...resMsg, on: vi.fn() });
    expect(handle).not.toHaveBeenCalled();
    expect(pipelined.resume).toHaveBeenCalled();

    const fresh: any = { ...pipelined, socket: { remoteAddress: "x" } };
    await requestCb!(fresh, { ...resMsg, on: vi.fn() });
    expect(handle).toHaveBeenCalledTimes(1);
  });
});

describe("handleCheckContinue (Expect: 100-continue)", () => {
  const LIMIT = 1048576; // the default, since this mock config sets none
  const expectRequest = (headers: Record<string, string>, extra = {}) => ({
    method: "POST",
    url: "/api/upload",
    httpVersion: "1.1",
    headers: { expect: "100-continue", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    ...extra,
  });

  it("withholds 100 Continue for a declared length over the limit", () => {
    const server = { emit: vi.fn(() => true) };
    const reqMsg: any = expectRequest({ "content-length": String(LIMIT + 1) });
    const resMsg: any = { writeContinue: vi.fn() };
    handleCheckContinue(server)(reqMsg, resMsg);
    expect(resMsg.writeContinue).not.toHaveBeenCalled();
    expect(server.emit).toHaveBeenCalledWith("request", reqMsg, resMsg);
  });

  it.each([
    ["within the limit", { "content-length": String(LIMIT) }],
    ["with no length (chunked)", { "transfer-encoding": "chunked" }],
    ["with a malformed length", { "content-length": "1e9" }],
  ])("answers 100 Continue at once %s", (_name, headers) => {
    const server = { emit: vi.fn(() => true) };
    const resMsg: any = { writeContinue: vi.fn() };
    handleCheckContinue(server)(expectRequest(headers) as any, resMsg);
    expect(resMsg.writeContinue).toHaveBeenCalledTimes(1);
    expect(server.emit).toHaveBeenCalledTimes(1);
  });

  it("keeps Node's default for HTTP/2 compat requests", () => {
    const server = { emit: vi.fn(() => true) };
    const resMsg: any = { writeContinue: vi.fn() };
    handleCheckContinue(server)(
      expectRequest(
        { "content-length": String(LIMIT * 2) },
        { httpVersion: "2.0" },
      ) as any,
      resMsg,
    );
    expect(resMsg.writeContinue).toHaveBeenCalledTimes(1);
  });

  const withheld = async () => {
    const { PassThrough } = await import("node:stream");
    const body = new PassThrough();
    const reqMsg: any = Object.assign(
      body,
      expectRequest({ "content-length": String(LIMIT * 2) }),
    );
    const resMsg: any = {
      headersSent: false,
      destroyed: false,
      writeContinue: vi.fn(),
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };
    handleCheckContinue({ emit: () => true })(reqMsg, resMsg);
    return { body, reqMsg, resMsg };
  };

  it("sends the withheld 100 once something starts reading the body", async () => {
    const { body, reqMsg, resMsg } = await withheld();
    adaptHttp1(reqMsg, resMsg);
    expect(resMsg.writeContinue).not.toHaveBeenCalled();
    body.resume();
    await new Promise((r) => setImmediate(r));
    expect(resMsg.writeContinue).toHaveBeenCalledTimes(1);
  });

  it("never sends the withheld 100 for the lingering drain of a rejected body", async () => {
    const { reqMsg, resMsg } = await withheld();
    const { res } = adaptHttp1(reqMsg, resMsg);
    res.lingerClose!();
    res.respond(413, { "content-length": 17 });
    await new Promise((r) => setImmediate(r));
    expect(resMsg.writeContinue).not.toHaveBeenCalled();
  });
});
