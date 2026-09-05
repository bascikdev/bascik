import { readFile } from "node:fs/promises";
import http2 from "node:http2";
import type { ServerHttp2Stream, IncomingHttpHeaders } from "node:http2";
import { BascikConfig } from "./config.ts";
import { ensureCertificates } from "./pki.ts";
import { getClientIp } from "./rate-limit.ts";
import {
  createRequestHandler,
  isNetworkResetError,
  startServerInstance,
  type BascikRequest,
  type BascikResponse
} from "./server.ts";
import { adaptHttp1 } from "./http.ts";

export const adaptHttp2 = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders): { req: BascikRequest; res: BascikResponse } => {
  let rawIp = "unknown";
  try {
    rawIp = (stream as any).session?.socket?.remoteAddress ?? "unknown";
  } catch { }

  const remoteIp = getClientIp(rawIp, headers as Record<string, string | string[] | undefined>, BascikConfig.http.trustProxy === true);

  stream.on("error", (err) => {
    if (isNetworkResetError(err)) return;
    console.error("[bascik] HTTP/2 stream error:", err);
  });

  const req: BascikRequest = {
    method: headers[":method"] as string ?? "GET",
    path: headers[":path"] as string,
    headers: headers as Record<string, string | string[] | undefined>,
    remoteIp,
    rawStream: stream,
  };

  const res: BascikResponse = {
    get headersSent() { return stream.headersSent; },
    get destroyed() { return stream.destroyed; },
    writable: stream,
    respond(status, headers) {
      stream.respond({ ":status": status, ...headers });
    },
    write(chunk) { return stream.write(chunk); },
    end(chunk) {
      if (arguments.length === 0 || chunk === undefined) {
        stream.end();
      } else {
        stream.end(chunk);
      }
    },
    close(code) { stream.close(code); },
    // Http2Stream emits 'aborted' before 'close' on peer RST_STREAM; 'close'
    // always follows, so it is the one lifecycle event the sink needs.
    on(event, cb) { stream.on(event, cb); },
    off(event, cb) { stream.off(event, cb); },
  };

  return { req, res };
};

export const startHttp2Server = async (): Promise<string> => {
  const { keyPath, certPath } = await ensureCertificates({
    keyFile: BascikConfig.http.tls?.keyFile,
    certFile: BascikConfig.http.tls?.certFile,
  });

  const key = await readFile(keyPath);
  const cert = await readFile(certPath);

  const server = http2.createSecureServer({
    key,
    cert,
    allowHTTP1: true,
    settings: { maxConcurrentStreams: 250 },
  });

  const openSessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session: http2.ServerHttp2Session) => {
    openSessions.add(session);
    session.once("close", () => openSessions.delete(session));
    session.on("error", (err) => {
      if (isNetworkResetError(err)) return;
      console.error("[bascik] HTTP/2 session error:", err);
    });
  });

  const openSockets = new Set<any>();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  const handleRequest = createRequestHandler();

  server.on(
    "stream",
    // Returning the promise here is a no-op for Node's EventEmitter, which
    // ignores listener return values, but lets tests and other callers
    // deterministically await request handling instead of racing it.
    (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      const { req, res } = adaptHttp2(stream, headers);
      return handleRequest(req, res).catch((err) => {
        console.error("[bascik] Unhandled error during HTTP/2 stream processing:", err);
        if (!res.headersSent) {
          try {
            res.respond(500, { "content-type": "text/plain" });
            res.end("Internal Server Error");
          } catch { }
        }
      });
    },
  );

  // When allowHTTP1: true is configured, Node's HTTP/2 server can fall back to
  // HTTP/1.1 over TLS for clients that do not support HTTP/2 or ALPN.
  // We handle these requests using standard HTTP/1.1 adapters, but ignore
  // HTTP/2 requests here since they are already processed via the "stream" event.
  server.on("request", (reqMsg, resMsg) => {
    if (reqMsg.httpVersion === "2.0") return;
    const { req, res } = adaptHttp1(reqMsg as any, resMsg as any);
    return handleRequest(req, res).catch((err) => {
      console.error("[bascik] Unhandled error during HTTP/1.1 over TLS request processing:", err);
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
    "https",
    () => {
      if (typeof (server as any).closeIdleConnections === "function") {
        try {
          (server as any).closeIdleConnections();
        } catch { }
      }
      for (const session of openSessions) {
        try {
          if (!session.closed && !session.destroyed) {
            session.close();
          }
        } catch { }
      }
    },
    () => {
      for (const session of openSessions) {
        try {
          session.destroy();
        } catch { }
      }
      openSessions.clear();
      for (const socket of openSockets) {
        try {
          socket.destroy();
        } catch { }
      }
      openSockets.clear();
    }
  );
};
