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
  type BascikResponse,
} from "./server.ts";
import { adaptHttp1, handleCheckContinue } from "./http.ts";
import { drainRequestBody, isLingeringSocket } from "./request-body-linger.ts";
import { nodeServerTimeouts } from "./server-lifecycle.ts";

/**
 * HTTP/1 connection-specific headers (RFC 9113 8.2.2). `stream.respond`
 * throws ERR_HTTP2_INVALID_CONNECTION_HEADERS on any of them, so a response
 * shared with the HTTP/1 path (the runtime's 413 says `Connection: close`) or
 * a handler that sets one would otherwise never reach an HTTP/2 client.
 */
const CONNECTION_SPECIFIC_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);

const stripConnectionHeaders = (
  headers: Record<string, string | number | string[]>,
): Record<string, string | number | string[]> => {
  let out: Record<string, string | number | string[]> | undefined;
  for (const key of Object.keys(headers)) {
    if (CONNECTION_SPECIFIC_HEADERS.has(key.toLowerCase())) {
      out ??= { ...headers };
      delete out[key];
    }
  }
  return out ?? headers;
};

export const adaptHttp2 = (
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
): { req: BascikRequest; res: BascikResponse } => {
  let rawIp = "unknown";
  try {
    rawIp = (stream as any).session?.socket?.remoteAddress ?? "unknown";
  } catch {}

  const remoteIp = getClientIp(
    rawIp,
    headers as Record<string, string | string[] | undefined>,
    BascikConfig.http.trustProxy === true,
  );

  stream.on("error", (err) => {
    if (isNetworkResetError(err)) return;
    console.error("[bascik] HTTP/2 stream error:", err);
  });

  const req: BascikRequest = {
    method: (headers[":method"] as string) ?? "GET",
    path: headers[":path"] as string,
    headers: headers as Record<string, string | string[] | undefined>,
    remoteIp,
    rawStream: stream,
  };

  // Set when the lingering drain hit a cap before the response ended: the
  // stream is reset (NO_ERROR) only after the response is complete.
  let resetAfterEnd = false;
  let ended = false;
  let lingering = false;
  const resetStream = (): void => {
    if (!stream.closed && !stream.destroyed) {
      // RFC 9113 8.1: after a complete response, RST_STREAM(NO_ERROR) asks
      // the client to stop sending without failing the request. Node
      // submits it only after the response's END_STREAM is flushed.
      stream.close(http2.constants.NGHTTP2_NO_ERROR);
    }
  };

  const res: BascikResponse = {
    get headersSent() {
      return stream.headersSent;
    },
    get destroyed() {
      return stream.destroyed;
    },
    writable: stream,
    respond(status, headers) {
      stream.respond({ ":status": status, ...stripConnectionHeaders(headers) });
    },
    write(chunk) {
      return stream.write(chunk);
    },
    end(chunk) {
      ended = true;
      if (arguments.length === 0 || chunk === undefined) {
        stream.end();
      } else {
        stream.end(chunk);
      }
      if (resetAfterEnd) resetStream();
    },
    // HTTP/2 multiplexes the session, so a rejected body costs only this
    // stream: drain it (flow control keeps the peer sending only what was
    // granted) and, at a cap, reset the stream; the session stays usable.
    lingerClose() {
      if (lingering) return;
      lingering = true;
      drainRequestBody(stream, (outcome) => {
        if (outcome !== "cap") return;
        if (ended) resetStream();
        else resetAfterEnd = true;
      });
    },
    close(code) {
      stream.close(code);
    },
    // Http2Stream emits 'aborted' before 'close' on peer RST_STREAM; 'close'
    // always follows, so it is the one lifecycle event the sink needs.
    on(event, cb) {
      stream.on(event, cb);
    },
    off(event, cb) {
      stream.off(event, cb);
    },
  };

  return { req, res };
};

/**
 * Closes `session` (GOAWAY, so the client opens a new one for its next
 * request) once it has had no open stream for `idleMs`: the HTTP/2 form of a
 * keep-alive timeout. Node's own session timeout counts frames, not streams,
 * so it would end a quiet SSE response; this one never fires while a
 * stream is open, however silent.
 */
const closeWhenIdle = (
  session: http2.ServerHttp2Session,
  idleMs: number,
): void => {
  let openStreams = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const start = () => {
    stop();
    timer = setTimeout(() => {
      timer = undefined;
      if (openStreams === 0) session.close();
    }, idleMs);
    timer.unref?.();
  };
  session.on("stream", (stream: ServerHttp2Stream) => {
    openStreams++;
    stop();
    stream.once("close", () => {
      openStreams--;
      if (openStreams === 0) start();
    });
  });
  session.once("close", stop);
  start();
};

export const startHttp2Server = async (): Promise<string> => {
  const { keyPath, certPath } = await ensureCertificates({
    keyFile: BascikConfig.http.tls?.keyFile,
    certFile: BascikConfig.http.tls?.certFile,
  });

  const key = await readFile(keyPath);
  const cert = await readFile(certPath);

  // request and headers bound the HTTP/1.1 fallback; HTTP/2 has no
  // per-request equivalent, so for its sessions keepAlive is the one that
  // applies, as an idle-session close below.
  const timeouts = nodeServerTimeouts(BascikConfig.http.timeouts);
  const server = http2.createSecureServer({
    key,
    cert,
    allowHTTP1: true,
    settings: { maxConcurrentStreams: 250 },
  });
  // Assigned, not passed as options: Node 22's constructor overwrites them
  // with its own defaults (300 s, 60 s, 30 s) when allowHTTP1 is set. The
  // fallback reads them when it starts listening and on each request.
  Object.assign(server, timeouts);
  const { keepAliveTimeout } = timeouts;

  const openSessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session: http2.ServerHttp2Session) => {
    openSessions.add(session);
    closeWhenIdle(session, keepAliveTimeout);
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
        console.error(
          "[bascik] Unhandled error during HTTP/2 stream processing:",
          err,
        );
        if (!res.headersSent) {
          try {
            res.respond(500, { "content-type": "text/plain" });
            res.end("Internal Server Error");
          } catch {}
        }
      });
    },
  );

  // When allowHTTP1: true is configured, Node's HTTP/2 server can fall back to
  // HTTP/1.1 over TLS for clients that do not support HTTP/2 or ALPN.
  // We handle these requests using standard HTTP/1.1 adapters, but ignore
  // HTTP/2 requests here since they are already processed via the "stream" event.
  server.on("checkContinue", handleCheckContinue(server));
  server.on("request", (reqMsg, resMsg) => {
    if (reqMsg.httpVersion === "2.0") return;
    // Pipelined behind a rejected body on a connection that is closing.
    if (isLingeringSocket(reqMsg.socket)) {
      reqMsg.resume();
      return;
    }
    const { req, res } = adaptHttp1(reqMsg as any, resMsg as any);
    return handleRequest(req, res).catch((err) => {
      console.error(
        "[bascik] Unhandled error during HTTP/1.1 over TLS request processing:",
        err,
      );
      if (!res.headersSent) {
        try {
          res.respond(500, { "content-type": "text/plain" });
          res.end("Internal Server Error");
        } catch {}
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
        } catch {}
      }
      for (const session of openSessions) {
        try {
          if (!session.closed && !session.destroyed) {
            session.close();
          }
        } catch {}
      }
    },
    () => {
      for (const session of openSessions) {
        try {
          session.destroy();
        } catch {}
      }
      openSessions.clear();
      for (const socket of openSockets) {
        try {
          socket.destroy();
        } catch {}
      }
      openSockets.clear();
    },
  );
};
