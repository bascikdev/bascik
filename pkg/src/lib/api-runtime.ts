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

import { Readable } from "node:stream";
import { scriptRegistry } from "./script-registry.ts";
import { cleanStackTrace } from "./stack-trace.ts";
import type { BascikRequest } from "./server.ts";

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
}

/**
 * Construct a WHATWG Request from a BascikRequest.
 * Excludes HTTP/2 pseudo-headers (headers starting with ':').
 */
export const createWebRequest = (
  rawReq: BascikRequest,
  origin = "http://localhost"
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
    // If rawReq carries a stream (e.g. from Node http.IncomingMessage or http2 stream)
    const stream = (rawReq as any).stream ?? (rawReq as any).rawStream;
    if (stream && typeof Readable.toWeb === "function") {
      try {
        body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
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
  const { filePath, request, params, remoteIp, signal } = options;
  const method = request.method.toUpperCase() as HttpMethod;

  let loadedModule: any;
  try {
    const loaded = await scriptRegistry.load(filePath);
    loadedModule = loaded.module;
  } catch (err) {
    console.error(`[bascik] Failed to load API route module "${filePath}":`, (err as Error).stack ?? String(err));
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

  try {
    const result = await targetHandler(request, context, { signal });

    if (!(result instanceof Response)) {
      console.error(
        `[bascik] API route handler "${filePath}" (${method}) did not return a WHATWG Response object. Returned: ${typeof result}`
      );
      return new Response("Internal Server Error", { status: 500 });
    }

    if (isDerivedHead) {
      // Return status and headers from GET response, but empty body
      return new Response(null, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
    }

    return result;
  } catch (err) {
    console.error(
      `[bascik] API route handler error in "${filePath}" (${method}):`,
      (err as Error).stack ?? String(err)
    );
    return new Response("Internal Server Error", { status: 500 });
  }
};
