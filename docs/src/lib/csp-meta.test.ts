import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { collectPageScripts, injectCspMeta, pagePolicy } from "./csp-meta.ts";

const hashOf = (body: string) =>
  `'sha256-${createHash("sha256").update(body).digest("base64")}'`;

describe("csp-meta", () => {
  it("hashes each distinct inline script once and ignores data blocks", () => {
    const html = [
      "<script>a()</script>",
      "<script>a()</script>",
      '<script type="module">b()</script>',
      '<script type="application/ld+json">{"x":1}</script>',
      '<script type="text/bascik-server">secret()</script>',
    ].join("");
    const { hashes, origins } = collectPageScripts(html);
    expect(hashes).toEqual([hashOf("a()"), hashOf("b()")].sort());
    expect(origins).toEqual([]);
  });

  it("does not hash external scripts and records only third-party origins", () => {
    const { hashes, origins } = collectPageScripts(
      '<script type="module" src="/assets/vendor/x.js"></script><script src="https://unpkg.com/alpinejs" defer></script>',
    );
    expect(hashes).toEqual([]);
    expect(origins).toEqual(["https://unpkg.com"]);
  });

  it("keeps > inside a quoted attribute from ending the open tag", () => {
    const { hashes } = collectPageScripts(
      '<script data-x="a>b">run()</script>',
    );
    expect(hashes).toEqual([hashOf("run()")]);
  });

  it("never allows unsafe-inline, data:, or a broad source", () => {
    const policy = pagePolicy(
      collectPageScripts("<script>a()</script><script>b()</script>"),
    );
    expect(policy).toMatch(/^script-src 'self' 'sha256-/);
    expect(policy).not.toMatch(/unsafe-inline|data:|https?:(?!\/\/)|\*/);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
  });

  it("allows the Cloudflare-injected beacon without enabling eval", () => {
    const result = injectCspMeta(
      '<head><meta charset="UTF-8" /></head><body><script>run()</script></body>',
    );
    expect(result).toContain(
      `content="script-src 'self' ${hashOf("run()")} https://static.cloudflareinsights.com; object-src 'none'; base-uri 'self'"`,
    );
    expect(result).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it("adds unsafe-eval only for pages that load third-party scripts", () => {
    const policy = pagePolicy(
      collectPageScripts(
        '<script src="https://unpkg.com/petite-vue" defer init></script>',
      ),
    );
    expect(policy).toContain(
      "script-src 'self' https://unpkg.com https://static.cloudflareinsights.com 'unsafe-eval'",
    );
  });

  it("places the policy right after <meta charset> so the charset stays early", () => {
    const html =
      '<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>t</title><script>a()</script></head></html>';
    const result = injectCspMeta(html);
    expect(result).toContain(
      '<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="script-src',
    );
    expect(result.indexOf("Content-Security-Policy")).toBeLessThan(
      result.indexOf("<script>"),
    );
  });

  it("falls back to <head>, skips pages without one, and is idempotent", () => {
    expect(
      injectCspMeta("<html><head><title>t</title></head></html>"),
    ).toContain("<head><meta http-equiv=");
    expect(injectCspMeta("<p>fragment</p>")).toBe("<p>fragment</p>");
    const once = injectCspMeta('<head><meta charset="UTF-8" /></head>');
    expect(injectCspMeta(once)).toBe(once);
  });
});
