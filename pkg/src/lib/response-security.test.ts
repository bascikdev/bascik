/**
 * `security.headers`, `security.hsts` and `security.privateDynamicPages` in
 * the portable response builders every host shares (web-response.ts).
 * `resolveResponseSecurity(config.security)` turns the config into the
 * header set, the HSTS string (or null) and the cache flag; the builders
 * take it as an optional `security` option and behave as today without it,
 * except HSTS, whose default drops includeSubDomains.
 */
import { describe, expect, it } from "vitest";
import * as webResponse from "./web-response.ts";

interface ResponseSecurity {
  headers: Record<string, string>;
  hsts: string | null;
  privateDynamicPages: boolean;
}
type Resolve = (security?: unknown) => ResponseSecurity;
const mod = webResponse as unknown as {
  resolveResponseSecurity?: Resolve;
  DEFAULT_RESPONSE_SECURITY?: ResponseSecurity;
  HSTS_HEADER: string;
  dynamicPageHeaders: (o?: Record<string, unknown>) => Headers;
  mergeHandlerHeaders: (h: Headers, o?: Record<string, unknown>) => Headers;
  errorResponse: (
    s: number,
    b: string,
    o?: Record<string, unknown>,
  ) => Response;
  internalErrorPage: (c?: string, o?: Record<string, unknown>) => Response;
};
const resolve: Resolve = (security) => {
  expect(typeof mod.resolveResponseSecurity).toBe("function");
  return mod.resolveResponseSecurity!(security);
};

const DEFAULT_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "cross-origin-resource-policy": "cross-origin",
};
const ONE_YEAR = "max-age=31536000";
const plain = (headers: Headers) => Object.fromEntries(headers.entries());

describe("HSTS default", () => {
  it("is one year without includeSubDomains", () => {
    expect(mod.HSTS_HEADER).toBe(ONE_YEAR);
  });

  it("dynamicPageHeaders over https sends it", () => {
    expect(
      mod.dynamicPageHeaders({ https: true }).get("strict-transport-security"),
    ).toBe(ONE_YEAR);
  });
});

describe("resolveResponseSecurity", () => {
  it("no config and an empty object are the defaults", () => {
    const expected = {
      headers: DEFAULT_HEADERS,
      hsts: ONE_YEAR,
      privateDynamicPages: true,
    };
    expect(resolve(undefined)).toEqual(expected);
    expect(resolve({})).toEqual(expected);
    expect(mod.DEFAULT_RESPONSE_SECURITY).toEqual(expected);
  });

  it("headers: true and headers: {} send the five headers", () => {
    expect(resolve({ headers: true }).headers).toEqual(DEFAULT_HEADERS);
    expect(resolve({ headers: {} }).headers).toEqual(DEFAULT_HEADERS);
  });

  it("headers: false sends none of them (HSTS is separate)", () => {
    const r = resolve({ headers: false });
    expect(r.headers).toEqual({});
    expect(r.hsts).toBe(ONE_YEAR);
  });

  it("an override replaces one value and keeps the rest", () => {
    expect(resolve({ headers: { "x-frame-options": "DENY" } }).headers).toEqual(
      {
        ...DEFAULT_HEADERS,
        "x-frame-options": "DENY",
      },
    );
  });

  it("false removes one header and keeps the rest", () => {
    const { "x-content-type-options": _removed, ...rest } = DEFAULT_HEADERS;
    expect(
      resolve({ headers: { "x-content-type-options": false } }).headers,
    ).toEqual(rest);
  });

  it("names are case-insensitive and normalized to lowercase", () => {
    const r = resolve({
      headers: { "X-Frame-Options": "DENY", "Referrer-Policy": false },
    });
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers).not.toHaveProperty("X-Frame-Options");
    expect(r.headers).not.toHaveProperty("referrer-policy");
  });

  it.each([
    [true, ONE_YEAR],
    [false, null],
    [{}, ONE_YEAR],
    [{ includeSubDomains: true }, `${ONE_YEAR}; includeSubDomains`],
    [{ maxAge: 600 }, "max-age=600"],
    [{ maxAge: 0 }, "max-age=0"],
    [
      { maxAge: 63072000, includeSubDomains: true, preload: true },
      "max-age=63072000; includeSubDomains; preload",
    ],
    [{ preload: true }, `${ONE_YEAR}; preload`],
  ])("hsts %j is %j", (hsts, expected) => {
    expect(resolve({ hsts }).hsts).toBe(expected);
  });

  it("privateDynamicPages: false is carried", () => {
    expect(resolve({ privateDynamicPages: false }).privateDynamicPages).toBe(
      false,
    );
  });
});

describe("the builders take a resolved security option", () => {
  it("dynamicPageHeaders sends the configured headers", () => {
    const security = resolve({
      headers: {
        "x-frame-options": "DENY",
        "cross-origin-resource-policy": false,
      },
    });
    const h = plain(mod.dynamicPageHeaders({ security }));
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h).not.toHaveProperty("cross-origin-resource-policy");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  it("dynamicPageHeaders leaves out cache-control when privateDynamicPages is off", () => {
    const security = resolve({ privateDynamicPages: false });
    expect(mod.dynamicPageHeaders({ security }).has("cache-control")).toBe(
      false,
    );
    expect(mod.dynamicPageHeaders({}).get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("hsts: false sends no HSTS even over https", () => {
    const security = resolve({ hsts: false });
    expect(
      mod
        .dynamicPageHeaders({ https: true, security })
        .has("strict-transport-security"),
    ).toBe(false);
    expect(
      mod
        .errorResponse(404, "Not Found", { https: true, security })
        .headers.has("strict-transport-security"),
    ).toBe(false);
  });

  it("an hsts object is sent over https only", () => {
    const security = resolve({ hsts: { includeSubDomains: true } });
    expect(
      mod
        .dynamicPageHeaders({ https: true, security })
        .get("strict-transport-security"),
    ).toBe(`${ONE_YEAR}; includeSubDomains`);
    expect(
      mod
        .dynamicPageHeaders({ https: false, security })
        .has("strict-transport-security"),
    ).toBe(false);
  });

  it("error responses keep private, no-store whatever privateDynamicPages says", () => {
    const security = resolve({ privateDynamicPages: false, headers: false });
    const err = mod.errorResponse(500, "x", { security });
    expect(err.headers.get("cache-control")).toBe("private, no-store");
    expect(err.headers.has("x-frame-options")).toBe(false);
    const page = mod.internalErrorPage(undefined, { security });
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.has("x-frame-options")).toBe(false);
  });

  it("an API handler's headers still win over the configured ones", () => {
    const security = resolve({ headers: { "x-frame-options": "DENY" } });
    const merged = mod.mergeHandlerHeaders(
      new Headers({ "x-frame-options": "ALLOWALL", "x-custom": "1" }),
      { https: true, security },
    );
    expect(merged.get("x-frame-options")).toBe("ALLOWALL");
    expect(merged.get("x-custom")).toBe("1");
    expect(merged.get("strict-transport-security")).toBe(ONE_YEAR);
  });

  it("an API handler response under headers: false carries only its own headers", () => {
    const security = resolve({ headers: false, hsts: false });
    const merged = mod.mergeHandlerHeaders(new Headers({ "x-custom": "1" }), {
      https: true,
      security,
    });
    expect(plain(merged)).toEqual({ "x-custom": "1" });
  });
});
