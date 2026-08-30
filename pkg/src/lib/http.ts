import http from "node:http";
import {
  createRequestHandler,
  startServerInstance,
  type BascikRequest,
  type BascikResponse
} from "./server.ts";

export const adaptHttp1 = (reqMsg: http.IncomingMessage, resMsg: http.ServerResponse): { req: BascikRequest; res: BascikResponse } => {
  const req: BascikRequest = {
    method: reqMsg.method ?? "GET",
    path: reqMsg.url,
    headers: reqMsg.headers,
    remoteIp: reqMsg.socket.remoteAddress ?? "unknown",
  };

  const res: BascikResponse = {
    get headersSent() { return resMsg.headersSent; },
    get destroyed() { return resMsg.destroyed; },
    writable: resMsg,
    respond(status, headers) {
      const respHeaders: Record<string, any> = { ...headers };
      if (":status" in respHeaders) {
        delete respHeaders[":status"];
      }
      resMsg.writeHead(status, respHeaders);
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

  server.on("request", async (reqMsg, resMsg) => {
    const { req, res } = adaptHttp1(reqMsg, resMsg);
    await handleRequest(req, res);
  });

  return startServerInstance(server, "http", () => {
    for (const socket of openSockets) {
      try {
        socket.destroy();
      } catch { }
    }
    openSockets.clear();
  });
};
