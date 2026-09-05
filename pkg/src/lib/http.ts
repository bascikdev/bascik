import http from "node:http";
import { BascikConfig } from "./config.ts";
import { getClientIp } from "./rate-limit.ts";
import {
  createRequestHandler,
  isNetworkResetError,
  startServerInstance,
  type BascikRequest,
  type BascikResponse
} from "./server.ts";

export const adaptHttp1 = (reqMsg: http.IncomingMessage, resMsg: http.ServerResponse): { req: BascikRequest; res: BascikResponse } => {
  resMsg.on("error", (err) => {
    if (isNetworkResetError(err)) return;
    console.error("[bascik] HTTP/1.1 response error:", err);
  });

  const rawIp = reqMsg.socket.remoteAddress ?? "unknown";
  const remoteIp = getClientIp(rawIp, reqMsg.headers, BascikConfig.http.trustProxy === true);

  const req: BascikRequest = {
    method: reqMsg.method ?? "GET",
    path: reqMsg.url,
    headers: reqMsg.headers,
    remoteIp,
    rawStream: reqMsg,
  };

  const res: BascikResponse = {
    get headersSent() { return resMsg.headersSent; },
    get destroyed() { return resMsg.destroyed; },
    writable: resMsg,
    respond(status, headers) {
      resMsg.writeHead(status, headers);
    },
    write(chunk) { return resMsg.write(chunk); },
    end(chunk) {
      if (arguments.length === 0 || chunk === undefined) {
        resMsg.end();
      } else {
        resMsg.end(chunk);
      }
    },
    close() { resMsg.destroy(); },
    on(event, cb) { resMsg.on(event, cb); },
    off(event, cb) { resMsg.off(event, cb); },
  };

  return { req, res };
};

export const startHttpServer = async (): Promise<string> => {
  const server = http.createServer();
  const handleRequest = createRequestHandler();

  const openSockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  server.on("request", (reqMsg, resMsg) => {
    const { req, res } = adaptHttp1(reqMsg, resMsg);
    // Returning the promise here is a no-op for Node's EventEmitter, which
    // ignores listener return values, but lets tests and other callers
    // deterministically await request handling instead of racing it.
    return handleRequest(req, res).catch((err) => {
      console.error("[bascik] Unhandled error during request processing:", err);
      if (!res.headersSent) {
        try {
          res.respond(500, { "content-type": "text/plain" });
          res.end("Internal Server Error");
        } catch { }
      }
    });
  });

  return startServerInstance(
    server,
    "http",
    () => {
      if (typeof server.closeIdleConnections === "function") {
        try {
          server.closeIdleConnections();
        } catch { }
      }
    },
    () => {
      for (const socket of openSockets) {
        try {
          socket.destroy();
        } catch { }
      }
      openSockets.clear();
    }
  );
};
