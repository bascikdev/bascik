/**
 * @module api-runtime
 *
 * In-Process Execution Runtime for API Route Handlers
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Executes standard WHATWG Request/Response handlers loaded via the ScriptRegistry.
 *
 * Standard methods: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD.
 * - HEAD derives from GET if not explicitly exported.
 * - OPTIONS auto-responds 204 with Allow header and NO CORS headers.
 * - Unexported method returns 405 with Allow header.
 * - Returned WHATWG Response is piped through to the client stream.
 * - Multiple Set-Cookie headers are preserved via Headers.getSetCookie().
 */

import { Readable, PassThrough } from "node:stream";
import { scriptRegistry } from "./script-registry.ts";
import { BascikConfig } from "./config.ts";
import { isNetworkResetError, type BascikRequest } from "./server.ts";
import {
  nativeClock,
  type FrameworkClock,
  type TimeoutHandle,
} from "./clock.ts";
import {
  ALLOWED_METHODS,
  NODE_PLATFORM,
  createAbortGate,
  dispatchApiHandler,
  type ApiHandlerContext,
  type HttpMethod,
} from "./request-execution.ts";

export { ALLOWED_METHODS, NODE_PLATFORM };
export type { HttpMethod };

export type ApiRouteContext = ApiHandlerContext;

export interface ExecuteApiRouteOptions {
  filePath: string;
  request: Request;
  params: Record<string, string | string[]>;
  remoteIp: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  clock?: FrameworkClock;
  /**
   * Set when the request declares a `Content-Length` over the limit
   * (`declaresBodyOverLimit`). The route answers 413 in place of the
   * handler, but only after the method policy, so a method the route does
   * not export still gets 405 + Allow and an auto OPTIONS still gets 204.
   * Called just before that 413 is returned, so the transport can drain.
   */
  onDeclaredBodyTooLarge?: () => void;
}

export class PayloadTooLargeError extends Error {
  constructor(message = "Payload Too Large") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Creates a TransformStream that limits the number of bytes passing through.
 * If total bytes exceed maxBytes, it destroys/errors the stream immediately.
 */
export const createByteLimitTransform = (
  maxBytes: number,
  onExceeded?: () => void,
): TransformStream<Uint8Array, Uint8Array> => {
  let bytesReceived = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesReceived += chunk.byteLength;
      if (bytesReceived > maxBytes) {
        if (onExceeded) onExceeded();
        controller.error(
          new PayloadTooLargeError(`Request body exceeded ${maxBytes} bytes.`),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
};

/**
 * Extract the rightmost (immediate proxy) entry from a header that may be
 * comma-delimited or an array of strings.
 */
export const getRightmostHeaderValue = (
  value: string | string[] | undefined,
): string | undefined => {
  if (typeof value === "string") {
    const parts = value
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : undefined;
  }
  if (Array.isArray(value) && value.length > 0) {
    const lastItem = value[value.length - 1];
    if (typeof lastItem === "string") {
      const parts = lastItem
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : undefined;
    }
  }
  return undefined;
};

/**
 * Validate that an authority (host[:port]) is syntactically well-formed:
 * - May be a domain name or IPv4 address, optionally followed by :port (1-65535)
 * - May be an IPv6 address enclosed in brackets [::1], optionally followed by :port
 * - Must not contain URI delimiters like /, ?, #, @, spaces, or control characters.
 */
const isValidAuthority = (authority: string): boolean => {
  if (!authority || authority.length > 255) return false;
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/.exec(
    authority,
  );
  if (!match) return false;
  const [, host, port] = match;
  if (host.startsWith(".")) return false;
  if (port !== undefined) {
    const portNum = Number(port);
    if (portNum < 1 || portNum > 65535) return false;
  }
  try {
    return new URL(`http://${authority}`).hostname !== "";
  } catch {
    return false;
  }
};

/**
 * Derive the truthful origin (scheme + authority) for a request.
 *
 * When http.trustProxy is enabled (true), safely reconstructs the external
 * scheme and authority from supported proxy headers (X-Forwarded-Proto and
 * X-Forwarded-Host), taking the rightmost (immediate proxy) entry.
 *
 * When http.trustProxy is disabled (false), proxy headers are strictly ignored
 * to prevent spoofing, and the origin is derived from local TLS configuration
 * and HTTP/2 :authority or HTTP/1.1 Host headers.
 */
export const requestOrigin = (
  rawReq: BascikRequest,
  config = BascikConfig,
): string => {
  const localScheme = config.http.tls?.enabled ? "https" : "http";
  const rawAuthority = rawReq.headers[":authority"] ?? rawReq.headers.host;
  const rawAuthorityStr = Array.isArray(rawAuthority)
    ? rawAuthority[0]
    : rawAuthority;
  const fallbackAuthority =
    typeof rawAuthorityStr === "string" &&
    isValidAuthority(rawAuthorityStr.trim())
      ? rawAuthorityStr.trim()
      : "localhost";

  if (config.http.trustProxy === true) {
    const protoHeader = getRightmostHeaderValue(
      rawReq.headers["x-forwarded-proto"],
    );
    const hostHeader = getRightmostHeaderValue(
      rawReq.headers["x-forwarded-host"],
    );

    let scheme = localScheme;
    if (protoHeader) {
      const lowerProto = protoHeader.toLowerCase();
      if (lowerProto === "https" || lowerProto === "http") {
        scheme = lowerProto;
      }
    }

    let authority = fallbackAuthority;
    if (hostHeader && isValidAuthority(hostHeader)) {
      authority = hostHeader;
    }

    return `${scheme}://${authority}`;
  }

  return `${localScheme}://${fallbackAuthority}`;
};

/**
 * The effective `http.maxBodySize`; 0 means unlimited. Config validation
 * rejects anything but a whole number of bytes; a value that reaches here
 * anyway keeps the 1 MB default, since a string or NaN compares false both
 * ways and would turn the limit off.
 */
export const resolveMaxBodySize = (): number => {
  const configured: unknown = BascikConfig.http?.maxBodySize;
  return typeof configured === "number" && !Number.isNaN(configured)
    ? configured
    : 1048576;
};

const PAYLOAD_TOO_LARGE_BODY = "Payload Too Large";

/**
 * True when a request that may carry a body declares a `Content-Length` over
 * `http.maxBodySize`: the length alone proves it too large, before a byte is
 * read. Only a plain decimal counts; anything malformed is left to the
 * streaming count, which never trusts the header.
 */
export const declaresBodyOverLimit = (
  method: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean => {
  const limit = resolveMaxBodySize();
  const upper = method?.toUpperCase();
  if (limit <= 0 || upper === "GET" || upper === "HEAD") return false;
  const declared = headers["content-length"];
  if (typeof declared !== "string" || !/^\d+$/.test(declared.trim()))
    return false;
  return Number(declared.trim()) > limit;
};

/**
 * The 413 for a body over `http.maxBodySize`. `Content-Length` is explicit
 * because the HTTP/1 transport holds back the end of this response while it
 * drains the rejected body; a length-delimited body is complete on the wire
 * immediately, where a chunked one would wait for its terminating chunk.
 */
export const payloadTooLargeResponse = (): Response =>
  new Response(PAYLOAD_TOO_LARGE_BODY, {
    status: 413,
    headers: {
      Connection: "close",
      "Content-Length": String(Buffer.byteLength(PAYLOAD_TOO_LARGE_BODY)),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });

/**
 * Construct a WHATWG Request from a BascikRequest.
 * Excludes HTTP/2 pseudo-headers (headers starting with ':').
 * Enforces streaming byte count up to maxBodySize without buffering;
 * `onBodyLimitExceeded` runs once the limit trips, so the transport can
 * drain the unread rest of the body (see `BascikResponse.lingerClose`).
 */
export const createWebRequest = (
  rawReq: BascikRequest,
  origin = "http://localhost",
  maxBodySize?: number,
  onBodyLimitExceeded?: () => void,
): Request => {
  const method = rawReq.method ? rawReq.method.toUpperCase() : "GET";
  const url = new URL(rawReq.path ?? "/", origin).href;

  const headers = new Headers();
  if (rawReq.headers) {
    for (const [key, value] of Object.entries(rawReq.headers)) {
      if (key.startsWith(":") || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(key, item);
        }
      } else {
        headers.set(key, value);
      }
    }
  }

  let body: ReadableStream<Uint8Array> | null = null;
  const isBodyAllowed = method !== "GET" && method !== "HEAD";

  if (isBodyAllowed) {
    const stream = (rawReq as any).stream ?? (rawReq as any).rawStream;
    if (stream && typeof Readable.toWeb === "function") {
      try {
        let nodeStream = stream;
        if (typeof stream.pipe === "function") {
          const pass = new PassThrough();
          stream.pipe(pass);
          nodeStream = pass;
        }
        const rawWebStream = Readable.toWeb(
          nodeStream,
        ) as ReadableStream<Uint8Array>;
        const limit = maxBodySize ?? resolveMaxBodySize();
        if (limit > 0) {
          // Draining the unread rest is the transport's job: resuming the
          // raw stream here would not drain it, since the pipe above pauses
          // it again on backpressure from a reader that has stopped.
          const limitTransform = createByteLimitTransform(
            limit,
            onBodyLimitExceeded,
          );
          body = rawWebStream.pipeThrough(limitTransform);
        } else {
          body = rawWebStream;
        }
      } catch {
        body = null;
      }
    }
  }

  const init: RequestInit = {
    method,
    headers,
    body,
    // In Node 24 duplex is required for streaming request bodies
    ...(body ? { duplex: "half" as const } : {}),
  };

  return new Request(url, init);
};

/**
 * Execute an API route handler module.
 */
export const executeApiRoute = async (
  options: ExecuteApiRouteOptions,
): Promise<Response> => {
  const {
    filePath,
    request,
    params,
    remoteIp,
    signal: userSignal,
    timeoutMs,
    clock = nativeClock,
    onDeclaredBodyTooLarge,
  } = options;
  const method = request.method.toUpperCase() as HttpMethod;

  const effectiveTimeout = timeoutMs ?? BascikConfig.http?.apiTimeout ?? 10000;
  const abortController = new AbortController();
  // The module load settles by the shared rule; the handler itself runs
  // through `dispatchApiHandler`, whose `invokeWithDeadline` applies it again.
  const loadGate = createAbortGate(abortController.signal);

  let upstreamSignalUnsubscribe: (() => void) | undefined;
  if (userSignal) {
    if (userSignal.aborted) {
      abortController.abort(userSignal.reason);
    } else {
      const onAbort = () => abortController.abort(userSignal.reason);
      userSignal.addEventListener("abort", onAbort, { once: true });
      upstreamSignalUnsubscribe = () =>
        userSignal.removeEventListener("abort", onAbort);
    }
  }

  let timer: TimeoutHandle | undefined;
  let didTimeout = false;

  if (effectiveTimeout && effectiveTimeout > 0) {
    timer = clock.setTimeout(() => {
      // A client that already went away stays a 499, not a late 504.
      if (abortController.signal.aborted) return;
      didTimeout = true;
      abortController.abort(
        new Error(`API route handler timed out after ${effectiveTimeout}ms`),
      );
    }, effectiveTimeout);
  }

  try {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason;
    }

    let loadedModule: any;
    try {
      const loadPromise = Promise.resolve(scriptRegistry.load(filePath));
      loadPromise.catch(() => {});

      const loaded = (await loadGate.race(loadPromise)) as any;
      loadedModule = loaded.module;
    } catch (err) {
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }
      console.error(
        "[bascik] Failed to load API route module %s:",
        filePath,
        (err as Error).stack ?? String(err),
      );
      return new Response("Internal Server Error", { status: 500 });
    }

    if (abortController.signal.aborted) {
      throw abortController.signal.reason;
    }

    // The method policy (405, auto OPTIONS) stays with the core below; only
    // a handler that would run is replaced by the 413, and it never runs.
    if (
      onDeclaredBodyTooLarge &&
      (ALLOWED_METHODS as readonly string[]).includes(method) &&
      typeof loadedModule?.[method] === "function"
    ) {
      onDeclaredBodyTooLarge();
      return payloadTooLargeResponse();
    }

    const context: ApiRouteContext = {
      params,
      remoteIp,
      platform: NODE_PLATFORM,
    };

    // Method dispatch, Allow/HEAD/OPTIONS policy, and the generic error
    // mapping are the shared core (prompt 132). The deadline timer above
    // already owns the timeout, so the core is handed only the combined
    // signal; a timeout arrives here as an abort and is classified below.
    const response = await dispatchApiHandler(loadedModule, request, context, {
      signal: abortController.signal,
      // Node transport failures the core cannot know about.
      classifyError: (err) => {
        if (
          err instanceof PayloadTooLargeError ||
          (err as { name?: string })?.name === "PayloadTooLargeError"
        ) {
          return payloadTooLargeResponse();
        }
        if (isNetworkResetError(err))
          return new Response("Client Closed Request", { status: 499 });
        return undefined;
      },
      onError: (message, error) => {
        // Format string first, values as arguments: a `%` in a path or a
        // handler message must never be interpreted by util.format.
        console.error(
          "[bascik] %s in %s%s",
          message,
          filePath,
          error !== undefined
            ? `:\n${(error as Error).stack ?? String(error)}`
            : "",
        );
      },
    });
    // The core reports an upstream abort as 499. When our own deadline caused
    // that abort the truthful status is 504, matching the pre-132 behavior.
    if (response.status === 499 && didTimeout) {
      console.error(
        "[bascik] API route handler timed out in %s (%s) after %dms",
        filePath,
        method,
        effectiveTimeout,
      );
      return new Response("Gateway Timeout", { status: 504 });
    }
    return response;
  } catch (err) {
    if (
      err instanceof PayloadTooLargeError ||
      (err as any)?.name === "PayloadTooLargeError"
    ) {
      return payloadTooLargeResponse();
    }

    if (isNetworkResetError(err)) {
      return new Response("Client Closed Request", { status: 499 });
    }

    // Upstream (transport) cancellation is not a handler defect: the client
    // went away, so the result is a quiet 499 that dispatch never delivers.
    // Only a deadline is reported as a timeout below.
    if (
      !didTimeout &&
      (userSignal?.aborted || abortController.signal.aborted)
    ) {
      return new Response("Client Closed Request", { status: 499 });
    }

    if (didTimeout || (err as Error)?.message?.includes("timed out after")) {
      console.error(
        "[bascik] API route handler timed out in %s (%s) after %dms",
        filePath,
        method,
        effectiveTimeout,
      );
      return new Response("Gateway Timeout", { status: 504 });
    }

    console.error(
      "[bascik] API route handler error in %s (%s):",
      filePath,
      method,
      (err as Error).stack ?? String(err),
    );
    return new Response("Internal Server Error", { status: 500 });
  } finally {
    if (timer) {
      clock.clearTimeout(timer);
      timer = undefined;
    }
    loadGate.dispose();
    if (upstreamSignalUnsubscribe) {
      upstreamSignalUnsubscribe();
      upstreamSignalUnsubscribe = undefined;
    }
  }
};
