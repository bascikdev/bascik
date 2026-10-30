import http from "node:http";
import { BascikConfig } from "./config.ts";
import { getClientIp } from "./rate-limit.ts";
import {
  createRequestHandler,
  isNetworkResetError,
  startServerInstance,
  type BascikRequest,
  type BascikResponse,
} from "./server.ts";
import {
  drainRequestBody,
  isLingeringSocket,
  markLingeringSocket,
} from "./request-body-linger.ts";
import { declaresBodyOverLimit } from "./api-runtime.ts";
import { nodeServerTimeouts } from "./server-lifecycle.ts";

/**
 * Requests whose `Expect: 100-continue` was not answered up front because
 * the declared length is already over the limit (see `handleCheckContinue`).
 */
const continueWithheld = new WeakSet<http.IncomingMessage>();

/**
 * `checkContinue` listener for an HTTP/1 server (and the HTTP/1 fallback of
 * the HTTP/2 server). Without one, Node answers `100 Continue` before the
 * request handler runs, so a polite client (curl sends `Expect` for bodies
 * over 1 MiB) uploads a body the early 413 then rejects and drains. A
 * declared length over the limit gets no 100 here; the 100 goes out only if
 * something starts reading the body anyway (`adaptHttp1`), so a route that
 * does read it, outside the API limit, still gets its upload.
 */
export const handleCheckContinue =
  (server: { emit(event: "request", ...args: unknown[]): boolean }) =>
  (reqMsg: http.IncomingMessage, resMsg: http.ServerResponse): void => {
    // HTTP/2 streams are served from the `stream` event; keep Node's default.
    if (
      reqMsg.httpVersion !== "2.0" &&
      declaresBodyOverLimit(reqMsg.method, reqMsg.headers)
    ) {
      continueWithheld.add(reqMsg);
    } else {
      resMsg.writeContinue();
    }
    server.emit("request", reqMsg, resMsg);
  };

/** Returns `headers` with every case variant of `name` replaced by `value`. */
const withHeader = (
  headers: Record<string, string | number>,
  name: string,
  value: string,
): Record<string, string | number> => {
  const out: Record<string, string | number> = {};
  for (const [key, v] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) out[key] = v;
  }
  out[name] = value;
  return out;
};

export const adaptHttp1 = (
  reqMsg: http.IncomingMessage,
  resMsg: http.ServerResponse,
): { req: BascikRequest; res: BascikResponse } => {
  // Lingering-close state (see `lingerClose`). While the drain runs, `end`
  // writes its final chunk but holds back `resMsg.end()`: Node destroys a
  // `Connection: close` socket as soon as the response finishes, and closing
  // a socket with unread request bytes makes the kernel send RST, which the
  // still-uploading client sees as EPIPE/ECONNRESET instead of the response.
  let lingering = false;
  let drained = false;
  let deferredEnd: (() => void) | undefined;
  // Headers committed before the body was rejected (a streamed response
  // tripped the limit), so they may have promised keep-alive; the socket is
  // ended after the response instead, since it may hold unread body bytes.
  let committedBeforeLinger = false;
  const finishResponse = (): void => {
    if (resMsg.destroyed) return;
    if (committedBeforeLinger) resMsg.end(() => reqMsg.socket.end());
    else resMsg.end();
  };
  if (continueWithheld.has(reqMsg)) {
    // Something started reading a body whose 100 was held back (a route the
    // API limit does not apply to): the client is waiting for it.
    reqMsg.once("resume", () => {
      if (!lingering && !resMsg.headersSent) resMsg.writeContinue();
    });
  }
  resMsg.on("error", (err) => {
    if (isNetworkResetError(err)) return;
    console.error("[bascik] HTTP/1.1 response error:", err);
  });
  // A body something started reading (the runtime pipes it into the web
  // Request of every API route and server-script page) is no longer dumped
  // by Node when the response finishes. If the handler never read it, the
  // pipe stops on backpressure and the keep-alive connection wedges: the
  // rest of the upload is never read, a pipelined request is never
  // answered, and Node resets the socket. Drain it within the lingering
  // caps instead; a client still sending past them is closed.
  let bodyTouched = false;
  reqMsg.once("resume", () => {
    bodyTouched = true;
  });
  resMsg.on("finish", () => {
    if (lingering || !bodyTouched || reqMsg.readableEnded) return;
    drainRequestBody(reqMsg, (outcome) => {
      if (outcome === "cap") reqMsg.socket.destroy();
    });
  });

  const rawIp = reqMsg.socket.remoteAddress ?? "unknown";
  const remoteIp = getClientIp(
    rawIp,
    reqMsg.headers,
    BascikConfig.http.trustProxy === true,
  );

  const req: BascikRequest = {
    method: reqMsg.method ?? "GET",
    path: reqMsg.url,
    headers: reqMsg.headers,
    remoteIp,
    rawStream: reqMsg,
  };

  const res: BascikResponse = {
    get headersSent() {
      return resMsg.headersSent;
    },
    get destroyed() {
      return resMsg.destroyed;
    },
    writable: resMsg,
    respond(status, headers) {
      // The rest of a rejected body is still on the wire, so this
      // connection can never carry another request.
      resMsg.writeHead(
        status,
        lingering ? withHeader(headers, "connection", "close") : headers,
      );
    },
    write(chunk) {
      return resMsg.write(chunk);
    },
    end(chunk) {
      if (lingering && (!drained || committedBeforeLinger)) {
        if (chunk !== undefined) resMsg.write(chunk);
        if (drained) finishResponse();
        else deferredEnd = finishResponse;
        return;
      }
      if (arguments.length === 0 || chunk === undefined) {
        resMsg.end();
      } else {
        resMsg.end(chunk);
      }
    },
    close() {
      // A truncating close during the drain waits for it too: destroying a
      // socket with unread body bytes is the RST this drain exists to avoid.
      if (lingering && !drained) {
        deferredEnd = () => resMsg.destroy();
        return;
      }
      resMsg.destroy();
    },
    on(event, cb) {
      resMsg.on(event, cb);
    },
    off(event, cb) {
      resMsg.off(event, cb);
    },
    lingerClose() {
      if (lingering) return;
      lingering = true;
      committedBeforeLinger = resMsg.headersSent;
      markLingeringSocket(reqMsg.socket);
      drainRequestBody(reqMsg, () => {
        drained = true;
        // At a cap the body is unfinished: ending now still sends the whole
        // response, then Node closes the socket and the client is cut off.
        deferredEnd?.();
        deferredEnd = undefined;
      });
    },
  };

  return { req, res };
};

export const startHttpServer = async (): Promise<string> => {
  const server = http.createServer(
    nodeServerTimeouts(BascikConfig.http.timeouts),
  );
  const handleRequest = createRequestHandler();

  const openSockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });

  server.on("checkContinue", handleCheckContinue(server));
  server.on("request", (reqMsg, resMsg) => {
    if (isLingeringSocket(reqMsg.socket)) {
      reqMsg.resume();
      return;
    }
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
        } catch {}
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
        } catch {}
      }
    },
    () => {
      for (const socket of openSockets) {
        try {
          socket.destroy();
        } catch {}
      }
      openSockets.clear();
    },
  );
};
