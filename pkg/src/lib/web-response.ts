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

/**
 * Sent on every response by every adapter unless `security.headers` changes
 * them. HSTS is added by hosts that know the scheme.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze(
  {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "cross-origin-resource-policy": "cross-origin",
  },
);

/**
 * The default Strict-Transport-Security value: one year, this host only.
 * `includeSubDomains` is opt-in (`security.hsts: { includeSubDomains: true }`)
 * because it forces every subdomain onto HTTPS for the whole max-age.
 */
export const HSTS_HEADER = "max-age=31536000";

/** One year, in seconds: the default `security.hsts.maxAge`. */
export const HSTS_DEFAULT_MAX_AGE = 31536000;

/**
 * `security.headers`, `security.hsts` and `security.privateDynamicPages`,
 * resolved once from the config into what the response builders send.
 */
export interface ResponseSecurity {
  /** The security headers to send, lowercase name to value. */
  headers: Record<string, string>;
  /** The Strict-Transport-Security value over HTTPS, or null for none. */
  hsts: string | null;
  /** Send `cache-control: private, no-store` on pages composed per request. */
  privateDynamicPages: boolean;
}

/** The config shape `resolveResponseSecurity` reads (validated at startup). */
export interface ResponseSecurityConfig {
  headers?: boolean | Record<string, string | false | undefined>;
  hsts?:
    | boolean
    | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  privateDynamicPages?: boolean;
}

/** Resolve the response half of `security` (absent: every default). */
export const resolveResponseSecurity = (
  security?: ResponseSecurityConfig | null,
): ResponseSecurity => {
  const headers: Record<string, string> = {};
  const configured = security?.headers;
  if (configured !== false) {
    Object.assign(headers, SECURITY_HEADERS);
    if (configured && typeof configured === "object") {
      for (const [name, value] of Object.entries(configured)) {
        const lower = name.toLowerCase();
        if (value === false) delete headers[lower];
        else if (typeof value === "string") headers[lower] = value;
      }
    }
  }
  const hstsConfig = security?.hsts;
  let hsts: string | null;
  if (hstsConfig === false) hsts = null;
  else if (hstsConfig && typeof hstsConfig === "object") {
    hsts = `max-age=${hstsConfig.maxAge ?? HSTS_DEFAULT_MAX_AGE}`;
    if (hstsConfig.includeSubDomains) hsts += "; includeSubDomains";
    if (hstsConfig.preload) hsts += "; preload";
  } else hsts = HSTS_HEADER;
  return {
    headers,
    hsts,
    privateDynamicPages: security?.privateDynamicPages !== false,
  };
};

/** Every default: the five headers, one-year HSTS, private dynamic pages. */
export const DEFAULT_RESPONSE_SECURITY: Readonly<ResponseSecurity> =
  Object.freeze(resolveResponseSecurity());

/** The security headers, plus HSTS when the connection is HTTPS. */
const securityHeaders = (
  security: ResponseSecurity,
  https: boolean | undefined,
): Headers => {
  const headers = new Headers(security.headers);
  if (https && security.hsts !== null)
    headers.set("strict-transport-security", security.hsts);
  return headers;
};

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
export const REPRESENTATION_HEADERS = [
  "content-length",
  "etag",
  "content-encoding",
  "last-modified",
  "accept-ranges",
] as const;

export interface DynamicPageHeaderOptions {
  status?: number;
  /** Set when the host knows the connection is HTTPS. */
  https?: boolean;
  /** Known body length for a buffered response; omitted for streams. */
  contentLength?: number;
  /** The resolved `security` config; absent means every default. */
  security?: ResponseSecurity;
}

/** The options every other builder takes. */
export interface SecurityResponseOptions {
  /** Set when the host knows the connection is HTTPS. */
  https?: boolean;
  /** The resolved `security` config; absent means every default. */
  security?: ResponseSecurity;
}

/** Response headers for a page whose body was composed at request time. */
export const dynamicPageHeaders = (
  options: DynamicPageHeaderOptions = {},
): Headers => {
  const security = options.security ?? DEFAULT_RESPONSE_SECURITY;
  const headers = securityHeaders(security, options.https);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("vary", "Accept-Encoding");
  if (security.privateDynamicPages)
    headers.set("cache-control", DYNAMIC_CACHE_CONTROL);
  if (options.contentLength !== undefined)
    headers.set("content-length", String(options.contentLength));
  return headers;
};

/**
 * Merge an API handler's headers over the security set. Handler headers win.
 * `Set-Cookie` is copied entry by entry so multiple cookies survive.
 */
export const mergeHandlerHeaders = (
  handlerHeaders: Headers,
  options: SecurityResponseOptions = {},
): Headers => {
  const headers = securityHeaders(
    options.security ?? DEFAULT_RESPONSE_SECURITY,
    options.https,
  );
  handlerHeaders.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers.set(key, value);
  });
  for (const cookie of handlerHeaders.getSetCookie())
    headers.append("set-cookie", cookie);
  return headers;
};

/** Remove representation headers that cannot describe a freshly composed body. */
export const stripRepresentationHeaders = (headers: Headers): Headers => {
  for (const name of REPRESENTATION_HEADERS) headers.delete(name);
  return headers;
};

/**
 * Plain-text error response with the security header set. Always
 * `private, no-store`: an error is never cached, whatever
 * `security.privateDynamicPages` says about pages.
 */
export const errorResponse = (
  status: number,
  body: string,
  options: SecurityResponseOptions = {},
): Response => {
  const headers = securityHeaders(
    options.security ?? DEFAULT_RESPONSE_SECURITY,
    options.https,
  );
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", DYNAMIC_CACHE_CONTROL);
  return new Response(body, { status, headers });
};

/** The only bytes a client ever sees for a server-side failure. */
export const GENERIC_500_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>';

/**
 * A 500 for a page whose composition failed before commit. Accepts an
 * optional authored 500 page body (the `src/pages/500.html` convention).
 */
export const internalErrorPage = (
  custom500?: Uint8Array | string,
  options: SecurityResponseOptions = {},
): Response => {
  const body = custom500 ?? GENERIC_500_HTML;
  const headers = dynamicPageHeaders(options);
  // A failure page is never cached, whatever privateDynamicPages says.
  headers.set("cache-control", DYNAMIC_CACHE_CONTROL);
  return new Response(body, { status: 500, headers });
};
