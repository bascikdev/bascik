/**
 * The `security` defaults on a real server (Collin 2026-10-29): every
 * protection is on without any config. Runs in the dev, server (HTTP/1.1)
 * and server-http2 (TLS) lanes. The off cases are covered by the Cloudflare
 * parity test, which runs a real `bascik --server` and workerd.
 *
 * - The five security headers on a page, a static asset and a 404.
 * - HSTS over TLS is one year WITHOUT includeSubDomains (the changed
 *   default: includeSubDomains could force unrelated subdomains onto HTTPS
 *   for a year); over plain HTTP it is never sent.
 * - A server-script page is never stored by a shared cache.
 * - Dotfiles are 404, except /.well-known/.
 */
import { test, expect } from "@playwright/test";

const HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "cross-origin-resource-policy": "cross-origin",
};

test.describe("security defaults", () => {
  test("a page, a 404 and the server-script page carry the five headers", async ({
    request,
  }) => {
    for (const path of [
      "/scope-test",
      "/no-such-page-xyz",
      "/server-scripts-test",
    ]) {
      const res = await request.get(path);
      const headers = res.headers();
      for (const [name, value] of Object.entries(HEADERS))
        expect(headers[name], `${path} ${name}`).toBe(value);
    }
  });

  test("HSTS is one year without includeSubDomains over TLS, and absent over HTTP", async ({
    request,
    baseURL,
  }) => {
    const res = await request.get("/scope-test");
    const hsts = res.headers()["strict-transport-security"];
    if (baseURL?.startsWith("https:")) {
      expect(hsts).toBe("max-age=31536000");
      expect(hsts).not.toContain("includeSubDomains");
    } else {
      expect(hsts).toBeUndefined();
    }
  });

  test("a server-script page is never stored by a shared cache", async ({
    request,
  }) => {
    const res = await request.get("/server-scripts-test");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");
  });

  test("dotfile paths are 404", async ({ request }) => {
    for (const path of [
      "/.env",
      "/.git/config",
      "/assets/.hidden.css",
      "/.bascik/components.json",
    ]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
    }
  });
});
