import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockServer, mockCreateServer } = vi.hoisted(() => {
  const mockServer = {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    listen: vi.fn().mockImplementation(
      (_port: number, _hostname: string, cb?: () => void) => { cb?.(); },
    ),
    close: vi.fn().mockImplementation((cb?: (err?: Error) => void) => { cb?.(); }),
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
    prodServer: {
      hostname: "localhost",
      port: 8443,
    },
  },
}));

vi.mock("./server.js", () => ({
  createRequestHandler: vi.fn(() => vi.fn()),
  startServerInstance: vi.fn(async () => "http://localhost:8443"),
}));

import { startHttpServer, adaptHttp1 } from "./http.ts";

describe("startHttpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a standard http server", async () => {
    const res = await startHttpServer();
    expect(mockCreateServer).toHaveBeenCalled();
    expect(res).toBe("http://localhost:8443");
  });

  it("adapts standard http request and response messages", () => {
    const mockReqMsg: any = {
      method: "GET",
      url: "/home",
      headers: { accept: "text/html" },
      socket: { remoteAddress: "192.168.1.1" },
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
    expect(mockResMsg.writeHead).toHaveBeenCalledWith(200, { "content-type": "text/html" });

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

  it("handles missing method and remoteAddress, strips :status header, and handles close/on", () => {
    const mockReqMsg: any = {
      method: undefined,
      url: "/",
      headers: {},
      socket: {},
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

    res.respond(200, { ":status": 200, "content-type": "text/plain" });
    expect(mockResMsg.writeHead).toHaveBeenCalledWith(200, { "content-type": "text/plain" });

    res.close();
    expect(mockResMsg.destroy).toHaveBeenCalled();

    const cb = () => { };
    res.on("close", cb);
    expect(mockResMsg.on).toHaveBeenCalledWith("close", cb);
  });

  it("passes an onShutdown callback to startServerInstance that destroys open sockets even if socket.destroy throws", async () => {
    let connectionCb: ((socket: any) => void) | undefined;
    let shutdownCb: (() => void) | undefined;

    mockServer.on.mockImplementation((event: string, cb: any) => {
      if (event === "connection") connectionCb = cb;
      return mockServer;
    });

    const { startServerInstance } = await import("./server.ts");
    (startServerInstance as any).mockImplementation(
      async (_server: any, _protocol: string, onShutdown?: () => void) => {
        shutdownCb = onShutdown;
        return "http://localhost:8443";
      },
    );

    await startHttpServer();

    expect(connectionCb).toBeDefined();
    expect(shutdownCb).toBeDefined();

    const mockSocket = {
      destroy: vi.fn().mockImplementation(() => { throw new Error("Socket error"); }),
      once: vi.fn(),
    };

    connectionCb!(mockSocket);
    expect(() => shutdownCb!()).not.toThrow();
    expect(mockSocket.destroy).toHaveBeenCalled();
  });
});

