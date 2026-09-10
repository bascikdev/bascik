/**
 * Prompt 134: the emitted Cloudflare bundle executes in local workerd with the
 * original source tree unavailable, static requests bypass compute, dynamic
 * routes cannot bypass execution, and bindings/cookies/cache/errors have
 * tested contracts.
 *
 * The first test is the fault-injection control: the invocation routes are
 * replaced with an empty list so a dynamic page falls through to assets. That
 * MUST 404 (the template is private), proving the "raw static fallback looks
 * like success" failure mode is impossible by construction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildServerlessFixture,
  cleanupServerlessFixture,
  createServerlessFixture,
} from "./serverless-fixture.test-helper.ts";
import { createGate, startHarness, type Harness, type DeployTarget } from "./cloudflare-harness.test-helper.ts";

const TARGETS: DeployTarget[] = ["cloudflare-pages", "cloudflare-workers"];

describe.each(TARGETS)("cloudflare adapter in local workerd (%s)", (target) => {
  let root: string;
  let harness: Harness;
  const gate = createGate();

  beforeAll(async () => {
    root = await createServerlessFixture(`adapter-${target}`);
    await buildServerlessFixture(root, target);
    // The source tree is gone before the worker ever starts: only the
    // deployment folder and dist/ remain.
    await rm(join(root, "src"), { recursive: true, force: true });
    await rename(join(root, "node_modules"), join(root, "node_modules.hidden"));
    harness = await startHarness({ projectRoot: root, target, bindings: { GREETING: "kv-hello" }, gate });
  }, 180_000);

  afterAll(async () => {
    await harness?.dispose();
    if (root) await cleanupServerlessFixture(root);
  });

  it("control: a dynamic page that bypasses the worker is a 404, never an inert placeholder document", async () => {
    const bypass = await startHarness({ projectRoot: root, target, invocationRoutes: ["/never-matches"] });
    try {
      const res = await bypass.fetch("/account");
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain("text/bascik-server");
      expect(text).not.toContain("account-greeting");
    } finally {
      await bypass.dispose();
    }
  });

  it("static requests are served by the asset layer with the built bytes", async () => {
    const res = await harness.fetch("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-testid="static-heading"');
    const css = await harness.fetch("/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const asset = await harness.fetch("/assets/logo.txt");
    expect(await asset.text()).toBe("logo bytes\n");
  });

  it("an unknown path is the authored 404 page from assets", async () => {
    const res = await harness.fetch("/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('data-testid="not-found"');
  });

  it("a buffered server page composes per request, reads the binding, and derives remoteIp from the platform header only", async () => {
    const res = await harness.fetch("/account", {
      headers: { "x-display-name": "Jane", "x-forwarded-for": "9.9.9.9" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain("Hello Jane via cloudflare (kv-hello)");
    expect(html).not.toContain("9.9.9.9");
    expect(html).not.toContain("text/bascik-server");
    // Every alias reaches the same composition.
    for (const alias of ["/account/", "/account.html"]) {
      const aliased = await harness.fetch(alias, { headers: { "x-display-name": "Alias" } });
      expect(aliased.status, alias).toBe(200);
      expect(await aliased.text()).toContain("Hello Alias");
    }
  });

  it("per-request isolation: concurrent requests never see each other's headers", async () => {
    const names = ["A", "B", "C", "D", "E", "F"];
    const bodies = await Promise.all(
      names.map((n) => harness.fetch("/account", { headers: { "x-display-name": n } }).then((r) => r.text())),
    );
    bodies.forEach((body, i) => expect(body).toContain(`Hello ${names[i]} via`));
  });

  it("HEAD on a dynamic page returns headers with content-length and no body", async () => {
    const res = await harness.fetch("/account", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  it("a non GET/HEAD method on a page is 405 with Allow", async () => {
    const res = await harness.fetch("/account", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("a mixed server + stream page streams the shell before the gated job resolves, then the rest in order", async () => {
    const streamed = await harness.streamed("/dashboard");
    expect(streamed.status).toBe(200);
    expect(streamed.headers["content-length"]).toBeUndefined();
    expect(streamed.headers["cache-control"]).toBe("private, no-store");
    const first = await streamed.first();
    expect(first.text).toContain('data-testid="shell"');
    expect(first.text).toContain("Shell 日本 🚀");
    // Everything before the gated job flows while it is still pending: the
    // src= server job (relative import + @/ alias + transitive helper) and the
    // fast stream fragment. Wait for the fast fragment on a bounded watchdog.
    const prefix = await streamed.until("fast-fragment");
    expect(prefix).toContain('data-testid="header-job"');
    expect(prefix).toContain("<label>hdr</label>");
    expect(prefix).toContain("<em>/dashboard</em>");
    expect(prefix).toContain('data-testid="alias-job"');
    expect(prefix).toContain("<label>alias</label>");
    expect(prefix).not.toContain("slow-fragment");
    gate.release();
    const chunks = await streamed.all();
    const body = chunks.map((c) => c.text).join("");
    expect(body.indexOf("fast-fragment")).toBeLessThan(body.indexOf("slow-fragment"));
    expect(body.indexOf("slow-fragment")).toBeLessThan(body.indexOf('data-testid="tail"'));
    expect(body).toContain("slow ünï");
    expect(body).not.toContain("text/bascik-server");
  });

  it("a stream job that fails after commit yields an empty slot and the document completes", async () => {
    const res = await harness.fetch("/broken-stream");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="before"');
    expect(html).toContain('data-testid="after"');
    expect(html).not.toContain("failed on purpose");
  });

  it("a server job that fails before commit is the authored 500 page with no detail leaked", async () => {
    const res = await harness.fetch("/broken-server");
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('data-testid="server-error"');
    expect(html).not.toContain("SECRET_DETAIL");
  });

  describe("API routes", () => {
    it("static and dynamic routes dispatch with params and the platform context", async () => {
      const health = await harness.fetch("/api/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const user = await harness.fetch("/api/users/42");
      expect(await user.json()).toMatchObject({ id: "42", platform: "cloudflare" });
    });

    it("method policy: 405 + Allow, auto OPTIONS 204 without CORS, derived HEAD", async () => {
      const put = await harness.fetch("/api/users/1", { method: "PUT" });
      expect(put.status).toBe(405);
      expect(put.headers.get("allow")).toBe("DELETE, GET, HEAD, OPTIONS");
      const options = await harness.fetch("/api/users/1", { method: "OPTIONS" });
      expect(options.status).toBe(204);
      expect(options.headers.get("allow")).toBe("DELETE, GET, HEAD, OPTIONS");
      expect(options.headers.get("access-control-allow-origin")).toBeNull();
      const head = await harness.fetch("/api/users/1", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const del = await harness.fetch("/api/users/1", { method: "DELETE" });
      expect(del.status).toBe(204);
    });

    it("POST bodies round-trip and multiple Set-Cookie headers survive", async () => {
      const res = await harness.fetch("/api/echo", { method: "POST", body: "payload ünï" });
      expect(res.status).toBe(201);
      expect(await res.text()).toBe("payload ünï");
      expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("a streamed API body arrives as chunks", async () => {
      const streamed = await harness.streamed("/api/stream");
      const chunks = await streamed.all();
      expect(chunks.map((c) => c.text).join("")).toBe("chunk1\nchunk2\nchunk3\n");
    });

    it("a thrown handler is a generic 500 with nothing leaked", async () => {
      const res = await harness.fetch("/api/boom");
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("Internal Server Error");
      expect(text).not.toContain("SECRET_DETAIL");
    });

    it("an unknown API path is a 404 and never falls through to a static file", async () => {
      const res = await harness.fetch("/api/missing");
      expect(res.status).toBe(404);
    });
  });

  it("private artifacts are unreachable: metadata, sidecar, and worker code never come back", async () => {
    for (const path of ["/.bascik/server-scripts.json", "/.bascik/manifest.json", "/_worker.js", "/_routes.json", "/worker.js", "/wrangler.jsonc"]) {
      const res = await harness.fetch(path);
      expect(res.status, path).not.toBe(200);
      const text = await res.text();
      expect(text, path).not.toContain("createCloudflareWorker");
      expect(text, path).not.toContain('"scripts"');
    }
    // A dynamic page alias is the worker's, never a public file.
    const alias = await harness.fetch("/dashboard.html", { headers: { "x-display-name": "x" } });
    expect(alias.status).toBe(200);
    expect(await alias.text()).not.toContain("text/bascik-server");
  });

  it("traversal and hidden paths never reach private files", async () => {
    // The WHATWG URL parser inside the Worker normalizes `%2e%2e` before the
    // handler runs (a browser does the same), so an encoded traversal is just
    // the normalized path: it can resolve a page, never a private artifact.
    const normalized = await harness.streamed("/api/%2e%2e/.bascik/server-scripts.json");
    expect(normalized.status).not.toBe(200);
    const raw = await harness.streamed("/..%2f.bascik/manifest.json");
    expect(raw.status).not.toBe(200);
    expect((await harness.fetch("/.env")).status).toBe(404);
    expect((await harness.fetch("/.bascik/")).status).toBe(404);
  });
});

describe("cloudflare adapter: missing binding diagnostics", () => {
  it("a page that reads an absent binding still renders with the documented fallback", async () => {
    const root = await createServerlessFixture("no-binding");
    let harness: Harness | undefined;
    try {
      await buildServerlessFixture(root, "cloudflare-pages");
      harness = await startHarness({ projectRoot: root, target: "cloudflare-pages" });
      const res = await harness.fetch("/account");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("(none)");
    } finally {
      await harness?.dispose();
      await cleanupServerlessFixture(root);
    }
  }, 120_000);
});
