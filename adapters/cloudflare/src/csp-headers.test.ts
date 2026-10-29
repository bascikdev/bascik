/**
 * Opt-in contentSecurityPolicy on Cloudflare: pages the Worker renders get
 * the header from the runtime; STATIC pages are served from assets without
 * the Worker, so the build writes one exact-path rule per static page into
 * the generated public/_headers (after any rules the author wrote). The
 * value is the same pkg function both hosts use, from the build's hashes.
 */
import { describe, expect, it } from "vitest";
import { buildCspHeadersRules } from "./csp-headers.ts";

const policy = {
  directives: { "default-src": ["'self'"], "script-src": ["'self'"] },
};

describe("buildCspHeadersRules", () => {
  it("writes one exact-path rule per static page with that page's hashes", () => {
    const text = buildCspHeadersRules({
      policy,
      hashes: {
        "/": { scripts: ["'sha256-A='"], styles: [] },
        "/docs": { scripts: [], styles: ["'sha256-S='"] },
      },
      staticRoutes: ["/", "/docs"],
      base: "/",
    });
    expect(text).toBe(
      [
        "/",
        "  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-A='",
        "/docs",
        "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'sha256-S='",
        "",
      ].join("\n"),
    );
  });

  it("default-src 'none' alone: a static page's rule creates script-src and style-src from the hashes only, never 'self'", () => {
    const text = buildCspHeadersRules({
      policy: {
        directives: { "default-src": ["'none'"], "img-src": ["'self'"] },
      },
      hashes: { "/": { scripts: ["'sha256-A='"], styles: ["'sha256-S='"] } },
      staticRoutes: ["/"],
      base: "/",
    });
    expect(text).toBe(
      [
        "/",
        "  Content-Security-Policy: default-src 'none'; img-src 'self'; script-src 'sha256-A='; style-src 'sha256-S='",
        "",
      ].join("\n"),
    );
  });

  it("prefixes rules with a non-root base", () => {
    const text = buildCspHeadersRules({
      policy,
      hashes: {},
      staticRoutes: ["/"],
      base: "/shop/",
    });
    expect(text.split("\n")[0]).toBe("/shop/");
  });

  it("uses the Report-Only header name with reportOnly", () => {
    const text = buildCspHeadersRules({
      policy: { ...policy, reportOnly: true },
      hashes: {},
      staticRoutes: ["/"],
      base: "/",
    });
    expect(text).toContain("  Content-Security-Policy-Report-Only: ");
  });

  it("over Cloudflare's 100-rule _headers limit, fails with a message that names the count and run_worker_first", () => {
    const staticRoutes = Array.from({ length: 120 }, (_, i) => `/p${i}`);
    expect(() =>
      buildCspHeadersRules({
        policy,
        hashes: {},
        staticRoutes,
        base: "/",
        authoredRules: 0,
      }),
    ).toThrow(/contentSecurityPolicy.*_headers.*100.*run_worker_first/s);
  });

  it("counts the author's own _headers rules toward the limit", () => {
    expect(() =>
      buildCspHeadersRules({
        policy,
        hashes: {},
        staticRoutes: ["/a", "/b"],
        base: "/",
        authoredRules: 98,
      }),
    ).toThrow(/_headers/);
  });
});
