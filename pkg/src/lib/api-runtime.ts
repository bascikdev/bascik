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
import { nativeClock, type FrameworkClock, type TimeoutHandle } from "./clock.ts";

export const ALLOWED_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const;

export type HttpMethod = (typeof ALLOWED_METHODS)[number];

export interface ApiRouteContext {
  params: Record<string, string>;
  remoteIp: string;
}

export interface ExecuteApiRouteOptions {
  filePath: string;
  request: Request;
  params: Record<string, string>;
  remoteIp: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  clock?: FrameworkClock;
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
  onExceeded?: () => void
): TransformStream<Uint8Array, Uint8Array> => {
  let bytesReceived = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesReceived += chunk.byteLength;
      if (bytesReceived > maxBytes) {
        if (onExceeded) onExceeded();
        controller.error(new PayloadTooLargeError(`Request body exceeded ${maxBytes} bytes.`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
};

/**
 * Derive the truthful origin (scheme + authority) for a request.
 */
export const requestOrigin = (rawReq: BascikRequest, config = BascikConfig): string => {
  const scheme = config.http.tls?.enabled ? "https" : "http";
  const authority = rawReq.headers[":authority"] ?? rawReq.headers.host ?? "localhost";
  const authorityStr = Array.isArray(authority) ? authority[0] : authority;
  return `${scheme}://${authorityStr}`;
};

/**
 * Construct a WHATWG Request from a BascikRequest.
 * Excludes HTTP/2 pseudo-headers (headers starting with ':').
 * Enforces streaming byte count up to maxBodySize without buffering.
 */
export const createWebRequest = (
  rawReq: BascikRequest,
  origin = "http://localhost",
  maxBodySize?: number
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
        const rawWebStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
        const limit = maxBodySize ?? BascikConfig.http?.maxBodySize ?? 1048576;
        if (limit > 0) {
          const limitTransform = createByteLimitTransform(limit, () => {
            if (typeof stream.resume === "function") {
              stream.resume();
            }
          });
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
  options: ExecuteApiRouteOptions
): Promise<Response> => {
  const { filePath, request, params, remoteIp, signal: userSignal, timeoutMs, clock = nativeClock } = options;
  const method = request.method.toUpperCase() as HttpMethod;

  let loadedModule: any;
  try {
    const loaded = await scriptRegistry.load(filePath);
    loadedModule = loaded.module;
  } catch (err) {
    console.error("[bascik] Failed to load API route module %s:", filePath, (err as Error).stack ?? String(err));
    return new Response("Internal Server Error", { status: 500 });
  }

  // Determine exported methods
  const exportedMethods: string[] = [];
  for (const m of ALLOWED_METHODS) {
    if (typeof loadedModule[m] === "function") {
      exportedMethods.push(m);
    }
  }

  // Calculate Allow header
  const allowMethodsSet = new Set(exportedMethods);
  // If GET is exported, HEAD is automatically supported
  if (allowMethodsSet.has("GET")) {
    allowMethodsSet.add("HEAD");
  }
  // OPTIONS is always supported automatically if not exported
  allowMethodsSet.add("OPTIONS");

  const sortedAllow = Array.from(allowMethodsSet).sort();
  const allowHeader = sortedAllow.join(", ");

  // Handle unexported method
  const isMethodAllowed =
    typeof loadedModule[method] === "function" ||
    (method === "HEAD" && typeof loadedModule.GET === "function") ||
    method === "OPTIONS";

  if (!isMethodAllowed) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: allowHeader,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  // Handle auto-OPTIONS
  if (method === "OPTIONS" && typeof loadedModule.OPTIONS !== "function") {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: allowHeader,
      },
    });
  }

  // Determine handler to call
  let targetHandler = loadedModule[method];
  let isDerivedHead = false;
  if (method === "HEAD" && typeof loadedModule.HEAD !== "function") {
    targetHandler = loadedModule.GET;
    isDerivedHead = true;
  }

  const context: ApiRouteContext = {
    params,
    remoteIp,
  };

  const effectiveTimeout = timeoutMs ?? BascikConfig.http?.apiTimeout ?? 10000;
  const abortController = new AbortController();

  let upstreamSignalUnsubscribe: (() => void) | undefined;
  if (userSignal) {
    if (userSignal.aborted) {
      abortController.abort(userSignal.reason);
    } else {
      const onAbort = () => abortController.abort(userSignal.reason);
      userSignal.addEventListener("abort", onAbort, { once: true });
      upstreamSignalUnsubscribe = () => userSignal.removeEventListener("abort", onAbort);
    }
  }

  let timer: TimeoutHandle | undefined;
  let didTimeout = false;

  if (effectiveTimeout && effectiveTimeout > 0) {
    timer = clock.setTimeout(() => {
      didTimeout = true;
      abortController.abort(new Error(`API route handler timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);
  }

  try {
    const handlerPromise = Promise.resolve(
      targetHandler(request, context, { signal: abortController.signal })
    );

    let result: unknown;
    if (effectiveTimeout && effectiveTimeout > 0) {
      result = await Promise.race([
        handlerPromise,
        new Promise<never>((_, reject) => {
          abortController.signal.addEventListener("abort", () => {
            if (didTimeout) {
              reject(new Error(`API route handler timed out after ${effectiveTimeout}ms`));
            } else {
              reject(abortController.signal.reason);
            }
          }, { once: true });
        }),
      ]);
    } else {
      result = await handlerPromise;
    }

    if (!(result instanceof Response)) {
      console.error(
        `[bascik] API route handler "${filePath}" (${method}) did not return a WHATWG Response object. Returned: ${typeof result}`
      );
      return new Response("Internal Server Error", { status: 500 });
    }

    if (isDerivedHead) {
      return new Response(null, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
    }

    return result;
  } catch (err) {
    if (err instanceof PayloadTooLargeError || (err as any)?.name === "PayloadTooLargeError") {
      return new Response("Payload Too Large", {
        status: 413,
        headers: {
          "Connection": "close",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    if (isNetworkResetError(err)) {
      return new Response("Client Closed Request", { status: 499 });
    }

    if (didTimeout || (err as Error)?.message?.includes("timed out after")) {
      console.error("[bascik] API route handler timed out in %s (%s) after %dms", filePath, method, effectiveTimeout);
      return new Response("Gateway Timeout", { status: 504 });
    }

    console.error(
      "[bascik] API route handler error in %s (%s):",
      filePath,
      method,
      (err as Error).stack ?? String(err)
    );
    return new Response("Internal Server Error", { status: 500 });
  } finally {
    if (timer) clock.clearTimeout(timer);
    if (upstreamSignalUnsubscribe) upstreamSignalUnsubscribe();
  }
};
