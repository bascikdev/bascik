/**
 * @module web-response
 *
 * Web `Response` construction shared by every host adapter (prompt 132).
 * Portable: no Node imports. `serverless-contract.test.ts` bundles it for
 * `platform: "browser"`.
 *
 * The Node server keeps its own header tables for HTTP/1.1 and HTTP/2
 * transports (`server.ts`); this module carries only the policy that must be
 * identical on every host: the security header set, the cache policy for
 * personalized pages, and the rule for which inherited headers are invalid
 * after a body has been composed.
 */

/** Sent on every response by every adapter. HSTS is added by hosts that know the scheme. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "cross-origin-resource-policy": "cross-origin",
});

export const HSTS_HEADER = "max-age=31536000; includeSubDomains";

/**
 * Personalized output must never enter a shared cache. Identical to the value
 * `server.ts` sets for pages with server scripts.
 */
export const DYNAMIC_CACHE_CONTROL = "private, no-store";

/**
 * Headers that describe a specific representation's bytes. Once a body has
 * been composed from a template, any copy of these inherited from the static
 * asset is a lie about the new body and must be removed.
 */
export const REPRESENTATION_HEADERS = ["content-length", "etag", "content-encoding", "last-modified", "accept-ranges"] as const;

export interface DynamicPageHeaderOptions {
  status?: number;
  /** Set when the host knows the connection is HTTPS. */
  https?: boolean;
  /** Known body length for a buffered response; omitted for streams. */
  contentLength?: number;
}

/** Response headers for a page whose body was composed at request time. */
export const dynamicPageHeaders = (options: DynamicPageHeaderOptions = {}): Headers => {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("vary", "Accept-Encoding");
  headers.set("cache-control", DYNAMIC_CACHE_CONTROL);
  if (options.https) headers.set("strict-transport-security", HSTS_HEADER);
  if (options.contentLength !== undefined) headers.set("content-length", String(options.contentLength));
  return headers;
};

/**
 * Merge an API handler's headers over the security set. Handler headers win.
 * `Set-Cookie` is copied entry by entry so multiple cookies survive.
 */
export const mergeHandlerHeaders = (handlerHeaders: Headers, options: { https?: boolean } = {}): Headers => {
  const headers = new Headers(SECURITY_HEADERS);
  if (options.https) headers.set("strict-transport-security", HSTS_HEADER);
  handlerHeaders.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers.set(key, value);
  });
  for (const cookie of handlerHeaders.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
};

/** Remove representation headers that cannot describe a freshly composed body. */
export const stripRepresentationHeaders = (headers: Headers): Headers => {
  for (const name of REPRESENTATION_HEADERS) headers.delete(name);
  return headers;
};

/** Plain-text error response with the security header set. */
export const errorResponse = (status: number, body: string, options: { https?: boolean } = {}): Response => {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", DYNAMIC_CACHE_CONTROL);
  if (options.https) headers.set("strict-transport-security", HSTS_HEADER);
  return new Response(body, { status, headers });
};

/** The only bytes a client ever sees for a server-side failure. */
export const GENERIC_500_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>';

/**
 * A 500 for a page whose composition failed before commit. Accepts an
 * optional authored 500 page body (the `src/pages/500.html` convention).
 */
export const internalErrorPage = (custom500?: Uint8Array | string, options: { https?: boolean } = {}): Response => {
  const body = custom500 ?? GENERIC_500_HTML;
  const headers = dynamicPageHeaders({ https: options.https });
  return new Response(body, { status: 500, headers });
};
