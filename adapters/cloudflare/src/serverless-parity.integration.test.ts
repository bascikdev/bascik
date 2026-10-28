/**
 * Prompt 135: Node versus Cloudflare parity at real runtime boundaries.
 *
 * One fixture is built once with `--target cloudflare-pages`. The SAME dist/
 * is then served two ways:
 *   - the real `bascik --server` in a child process (the Node oracle),
 *   - the emitted bundle inside local workerd via Miniflare.
 *
 * Every assertion runs against both and compares. Deliberate platform
 * differences are listed in `PLATFORM_DIFFERENCES` and asserted as such rather
 * than silently excluded.
 *
 * Fault-injection oracles come first: a control that MUST fail proves the
 * harness can detect buffering and dynamic-route bypass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildServerlessFixture,
  cleanupServerlessFixture,
  componentScriptId,
  createServerlessFixture,
} from "./serverless-fixture.test-helper.ts";
import {
  createGate,
  startHarness,
  type Harness,
  type StreamedResponse,
} from "./cloudflare-harness.test-helper.ts";

/**
 * Header-level differences that are platform facts, not adapter defects.
 * Each entry names the header and why the values legitimately differ.
 */
const PLATFORM_DIFFERENCES: Record<string, string> = {
  "transfer-encoding":
    "Node HTTP/1.1 frames a streamed body as chunked; workerd's local proxy may use its own framing.",
  connection: "Connection management belongs to the transport.",
  date: "Clock value.",
  "keep-alive": "Transport keep-alive parameters.",
  vary: "Node adds Vary: Accept-Encoding for negotiated static assets; the asset layer decides its own.",
  "content-encoding":
    "workerd (like the Cloudflare edge) applies its own compression to Worker responses; Node compresses only what it negotiated itself.",
  "content-length":
    "When the edge re-encodes a body it reframes it; the Worker's own content-length is visible only on an identity request.",
  etag: "The two static layers compute validators independently.",
  "cache-control":
    "Static asset cache policy is host configuration; dynamic responses are compared explicitly.",
  "cf-ray": "Cloudflare request id.",
  server: "Server product token.",
};

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });

interface NodeOracle {
  url: URL;
  /** What the server has written to stdout and stderr so far. */
  output(): string;
  stop(): Promise<void>;
}

const startNodeServer = async (projectRoot: string): Promise<NodeOracle> => {
  const port = await freePort();
  const cli = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../pkg/dist/index.js",
  );
  const child: ChildProcess = spawn(
    process.execPath,
    [cli, "--server", "--port", String(port), "--host", "127.0.0.1"],
    {
      cwd: projectRoot,
      env: { ...process.env, BASCIK_LOG_LEVEL: "silent" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderr: string[] = [];
  const output: string[] = [];
  child.stderr?.on("data", (d) => {
    stderr.push(String(d));
    output.push(String(d));
  });
  child.stdout?.on("data", (d) => output.push(String(d)));
  const url = new URL(`http://127.0.0.1:${port}/`);
  // Readiness is the health endpoint, never a sleep.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`bascik --server exited early: ${stderr.join("")}`);
    try {
      const res = await fetch(new URL("/_health/ready", url));
      if (res.status === 200) break;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    output: () => output.join(""),
    stop: () =>
      new Promise((resolveStop) => {
        child.once("exit", () => resolveStop());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }),
  };
};

const rawStreamed = (
  base: URL,
  path: string,
  headers: Record<string, string> = {},
): Promise<StreamedResponse> =>
  new Promise((resolveResponse, reject) => {
    const start = Date.now();
    const chunks: Array<{ text: string; atMs: number }> = [];
    let firstResolve: ((c: { text: string; atMs: number }) => void) | undefined;
    let ended = false;
    const endResolvers: Array<() => void> = [];
    const markerWaiters: Array<{
      marker: string;
      resolve: (body: string) => void;
    }> = [];
    const bodySoFar = () => chunks.map((c) => c.text).join("");
    const req = http.request(
      {
        host: base.hostname,
        port: base.port,
        path,
        method: "GET",
        headers: { "accept-encoding": "identity", ...headers },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (text: string) => {
          const chunk = { text, atMs: Date.now() - start };
          chunks.push(chunk);
          firstResolve?.(chunk);
          firstResolve = undefined;
          const body = bodySoFar();
          for (let i = markerWaiters.length - 1; i >= 0; i--) {
            if (body.includes(markerWaiters[i].marker)) {
              markerWaiters[i].resolve(body);
              markerWaiters.splice(i, 1);
            }
          }
        });
        const finish = () => {
          ended = true;
          for (const r of endResolvers.splice(0)) r();
        };
        res.on("end", finish);
        res.on("error", finish);
        resolveResponse({
          status: res.statusCode ?? 0,
          headers: res.headers,
          first: (timeoutMs = 5000) =>
            new Promise((ok, fail) => {
              if (chunks.length) return ok(chunks[0]);
              const watchdog = setTimeout(
                () => fail(new Error(`no first chunk within ${timeoutMs}ms`)),
                timeoutMs,
              );
              firstResolve = (c) => {
                clearTimeout(watchdog);
                ok(c);
              };
            }),
          until: (marker, timeoutMs = 5000) =>
            new Promise((ok, fail) => {
              if (bodySoFar().includes(marker)) return ok(bodySoFar());
              const watchdog = setTimeout(
                () =>
                  fail(
                    new Error(
                      `marker "${marker}" not seen within ${timeoutMs}ms`,
                    ),
                  ),
                timeoutMs,
              );
              markerWaiters.push({
                marker,
                resolve: (b) => {
                  clearTimeout(watchdog);
                  ok(b);
                },
              });
            }),
          all: (timeoutMs = 10000) =>
            new Promise((ok, fail) => {
              if (ended) return ok(chunks);
              const watchdog = setTimeout(
                () => fail(new Error(`body did not end within ${timeoutMs}ms`)),
                timeoutMs,
              );
              endResolvers.push(() => {
                clearTimeout(watchdog);
                ok(chunks);
              });
            }),
          destroy: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

interface Observed {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const observe = async (res: Response): Promise<Observed> => {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

const comparable = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(([k]) => !(k in PLATFORM_DIFFERENCES)),
  );

describe("serverless parity: Node oracle versus local workerd", () => {
  let root: string;
  let node: NodeOracle;
  let cloudflare: Harness;
  const gate = createGate();

  beforeAll(async () => {
    root = await createServerlessFixture("parity");
    await buildServerlessFixture(root, "cloudflare-pages");
    node = await startNodeServer(root);
    cloudflare = await startHarness({
      projectRoot: root,
      target: "cloudflare-pages",
      bindings: { GREETING: "kv" },
      gate,
    });
  }, 180_000);

  afterAll(async () => {
    await cloudflare?.dispose();
    await node?.stop();
    if (root) await cleanupServerlessFixture(root);
  });

  const both = async (
    path: string,
    init?: RequestInit,
  ): Promise<{ node: Observed; cf: Observed }> => ({
    node: await observe(await fetch(new URL(path, node.url), init)),
    cf: await observe(await cloudflare.fetch(path, init)),
  });

  describe("fault-injection oracles (must fail the acceptance check)", () => {
    it("a buffered body is detectable: the streaming assertion fails against a whole-body response", async () => {
      // Oracle: /account is buffered by design. A "first chunk before the gate"
      // assertion against it must NOT be able to pass on a gated marker.
      const streamed = await cloudflare.streamed("/account");
      const chunks = await streamed.all();
      const body = chunks.map((c) => c.text).join("");
      expect(body).toContain("account-greeting");
      // Exactly the property a buffering adapter would exhibit for /dashboard:
      // the whole document present before any gate is released.
      await expect(streamed.until("does-not-exist", 100)).rejects.toThrow(
        /not seen/,
      );
    });

    it("a dynamic-route bypass is detectable: routing the page to assets yields a 404, not a 200", async () => {
      const bypass = await startHarness({
        projectRoot: root,
        target: "cloudflare-pages",
        invocationRoutes: ["/only-api/*"],
      });
      try {
        const res = await bypass.fetch("/account");
        expect(res.status).toBe(404);
      } finally {
        await bypass.dispose();
      }
    });
  });

  it("truly static pages: same status and body bytes", async () => {
    const { node: n, cf } = await both("/");
    expect(cf.status).toBe(n.status);
    expect(cf.body).toBe(n.body);
    expect(cf.headers["content-type"]).toContain("text/html");
  });

  it("buffered server page: same status, body, dynamic cache policy, and security headers", async () => {
    const { node: n, cf } = await both("/account", {
      headers: { "x-display-name": "Parity" },
    });
    expect(cf.status).toBe(200);
    expect(n.status).toBe(200);
    // Body differs only in the platform name and binding, which is the point.
    expect(n.body).toContain("Hello Parity via node (none)");
    expect(cf.body).toContain("Hello Parity via cloudflare (kv)");
    expect(
      n.body.replace("via node (none)", "X").replace(/ip=[^<]*/, "ip"),
    ).toBe(
      cf.body.replace("via cloudflare (kv)", "X").replace(/ip=[^<]*/, "ip"),
    );
    expect(cf.headers["cache-control"]).toBe("private, no-store");
    expect(n.headers["cache-control"]).toBe("private, no-store");
    for (const h of [
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
    ]) {
      expect(cf.headers[h], h).toBe(n.headers[h]);
    }
    // The Worker sets content-length for a buffered body; the edge keeps it
    // when it does not re-encode (identity request over raw HTTP).
    const identity = await cloudflare.streamed("/account", {
      "x-display-name": "Parity",
    });
    await identity.all();
    expect(Number(identity.headers["content-length"])).toBeGreaterThan(0);
  });

  it("page aliases resolve identically", async () => {
    for (const alias of [
      "/account/",
      "/account.html",
      "/index.html",
      "/index",
    ]) {
      const { node: n, cf } = await both(alias, {
        headers: { "x-display-name": "A" },
      });
      expect(cf.status, alias).toBe(n.status);
      expect(
        cf.body.replace(/via \w+ \([^)]*\)/, "").replace(/ip=[^<]*/, ""),
        alias,
      ).toBe(n.body.replace(/via \w+ \([^)]*\)/, "").replace(/ip=[^<]*/, ""));
    }
  });

  it("HEAD and 405 on pages match", async () => {
    const head = await both("/account", { method: "HEAD" });
    expect(head.cf.status).toBe(head.node.status);
    expect(head.cf.body).toBe("");
    expect(head.node.body).toBe("");
    const post = await both("/account", { method: "POST" });
    expect(post.cf.status).toBe(405);
    expect(post.node.status).toBe(405);
    expect(post.cf.headers.allow).toBe(post.node.headers.allow);
  });

  it("mixed server + stream page: both hosts deliver the shell before the gated job and the rest in order", async () => {
    const nodeStream = await rawStreamed(node.url, "/dashboard");
    const cfStream = await cloudflare.streamed("/dashboard");
    for (const [label, s] of [
      ["node", nodeStream],
      ["cloudflare", cfStream],
    ] as const) {
      expect(s.status, label).toBe(200);
      expect(s.headers["content-length"], label).toBeUndefined();
      expect(s.headers["cache-control"], label).toBe("private, no-store");
      const prefix = await s.until("fast-fragment");
      expect(prefix, label).toContain('data-testid="shell"');
      expect(prefix, label).toContain("<label>hdr</label>");
    }
    // Only the Cloudflare side has a GATE binding, so only there can the slow
    // fragment be proven absent before release (the Node oracle's early-flush
    // ordering is covered by the existing HTTP/1.1 and HTTP/2 E2E suites).
    expect(await cfStream.until("fast-fragment")).not.toContain(
      "slow-fragment",
    );
    gate.release();
    const nodeBody = (await nodeStream.all()).map((c) => c.text).join("");
    const cfBody = (await cfStream.all()).map((c) => c.text).join("");
    expect(cfBody).toBe(nodeBody);
    expect(cfBody.indexOf("fast-fragment")).toBeLessThan(
      cfBody.indexOf("slow-fragment"),
    );
    expect(cfBody.indexOf("slow-fragment")).toBeLessThan(
      cfBody.indexOf('data-testid="tail"'),
    );
  });

  it("stream failure after commit and server failure before commit map the same", async () => {
    const broken = await both("/broken-stream");
    expect(broken.cf.status).toBe(200);
    expect(broken.node.status).toBe(200);
    expect(broken.cf.body).toBe(broken.node.body);
    expect(broken.cf.body).not.toContain("failed on purpose");
    const fatal = await both("/broken-server");
    expect(fatal.cf.status).toBe(500);
    expect(fatal.node.status).toBe(500);
    expect(fatal.cf.body).toContain('data-testid="server-error"');
    expect(fatal.node.body).toContain('data-testid="server-error"');
    expect(fatal.cf.body).not.toContain("SECRET_DETAIL");
    expect(fatal.node.body).not.toContain("SECRET_DETAIL");
  });

  describe("API routes", () => {
    it("GET/params, methods, Allow, OPTIONS, derived HEAD", async () => {
      const user = await both("/api/users/9");
      expect(user.cf.status).toBe(200);
      expect(JSON.parse(user.cf.body).id).toBe("9");
      expect(JSON.parse(user.node.body).id).toBe("9");
      expect(JSON.parse(user.node.body).platform).toBe("node");
      expect(JSON.parse(user.cf.body).platform).toBe("cloudflare");

      const put = await both("/api/users/9", { method: "PUT" });
      expect(put.cf.status).toBe(405);
      expect(put.node.status).toBe(405);
      expect(put.cf.headers.allow).toBe(put.node.headers.allow);

      const options = await both("/api/users/9", { method: "OPTIONS" });
      expect(options.cf.status).toBe(204);
      expect(options.node.status).toBe(204);
      expect(options.cf.headers.allow).toBe(options.node.headers.allow);
      expect(options.cf.headers["access-control-allow-origin"]).toBeUndefined();
      expect(
        options.node.headers["access-control-allow-origin"],
      ).toBeUndefined();

      const head = await both("/api/health", { method: "HEAD" });
      expect(head.cf.status).toBe(200);
      expect(head.node.status).toBe(200);
      expect(head.cf.body).toBe("");
      expect(head.node.body).toBe("");
    });

    it("catch-all captures segments, keeps precedence, and rejects unsafe paths identically", async () => {
      const many = await both("/api/files/a/b%20c/caf%C3%A9");
      expect(many.cf.status).toBe(200);
      expect(JSON.parse(many.cf.body).path).toEqual(["a", "b c", "café"]);
      expect(JSON.parse(many.node.body).path).toEqual(["a", "b c", "café"]);

      // A static route still wins over the sibling catch-all prefix.
      const health = await both("/api/health");
      expect(JSON.parse(health.cf.body)).toEqual(JSON.parse(health.node.body));

      // Required catch-all: no remaining segment is not a handler match.
      const none = await both("/api/files");
      expect(none.cf.body).toBe(none.node.body);
      expect(none.cf.status).toBe(none.node.status);

      for (const unsafe of [
        "/api/files/a%2Fb",
        "/api/files/a%5Cb",
        "/api/files/%E0%A4%A",
        "/api/files/a//b",
      ]) {
        const res = await both(unsafe);
        expect(res.cf.status, `cf ${unsafe}`).toBe(400);
        expect(res.node.status, `node ${unsafe}`).toBe(400);
      }

      const put = await both("/api/files/a", { method: "PUT" });
      expect(put.cf.status).toBe(405);
      expect(put.node.status).toBe(405);
      expect(put.cf.headers.allow).toBe(put.node.headers.allow);
    });

    it("POST body, status, and multiple Set-Cookie headers", async () => {
      const nodeRes = await fetch(new URL("/api/echo", node.url), {
        method: "POST",
        body: "hello ünï",
      });
      const cfRes = await cloudflare.fetch("/api/echo", {
        method: "POST",
        body: "hello ünï",
      });
      expect(cfRes.status).toBe(201);
      expect(nodeRes.status).toBe(201);
      expect(await cfRes.text()).toBe(await nodeRes.text());
      expect(cfRes.headers.getSetCookie()).toEqual(
        nodeRes.headers.getSetCookie(),
      );
    });

    it("streamed API bodies, generic errors, and unknown routes", async () => {
      const stream = await both("/api/stream");
      expect(stream.cf.body).toBe(stream.node.body);
      const boom = await both("/api/boom");
      expect(boom.cf.status).toBe(500);
      expect(boom.node.status).toBe(500);
      expect(boom.cf.body).not.toContain("SECRET_DETAIL");
      expect(boom.node.body).not.toContain("SECRET_DETAIL");
      const missing = await both("/api/missing");
      expect(missing.cf.status).toBe(404);
      expect(missing.node.status).toBe(404);
    });

    it("comparable response headers match outside the declared platform differences", async () => {
      const { node: n, cf } = await both("/api/health");
      const nodeHeaders = comparable(n.headers);
      const cfHeaders = comparable(cf.headers);
      for (const key of Object.keys(nodeHeaders)) {
        if (key === "content-length") continue;
        expect(cfHeaders[key], key).toBe(nodeHeaders[key]);
      }
    });
  });

  // The asset layer serves a static 404.html at its own URL as a 200. The
  // Node server answers the custom 404 page with status 404 at every alias,
  // so a crawler that requests /404 never indexes it as content.
  it("the custom 404 page answers 404 at its own URL on both hosts", async () => {
    for (const path of ["/404", "/404/"]) {
      const { node: n, cf } = await both(path);
      expect(n.status, `node ${path}`).toBe(404);
      expect(cf.status, `cf ${path}`).toBe(404);
      expect(cf.body, path).toBe(n.body);
      for (const method of ["POST", "DELETE"]) {
        const denied = await both(path, { method });
        expect(denied.node.status, `node ${method} ${path}`).toBe(405);
        expect(denied.cf.status, `cf ${method} ${path}`).toBe(405);
        expect(denied.node.headers["allow"]).toBe("GET, HEAD");
        expect(denied.cf.headers["allow"]).toBe("GET, HEAD");
        expect(denied.cf.body).toBe(denied.node.body);
      }
    }
    const head = await both("/404", { method: "HEAD" });
    expect(head.cf.status).toBe(404);
    expect(head.cf.body).toBe("");
  });

  it("no source leaks on either host", async () => {
    for (const path of [
      "/.bascik/server-scripts.json",
      "/src/api/health.ts",
      "/.env",
      "/_worker.js",
    ]) {
      const { node: n, cf } = await both(path);
      expect(n.status, `node ${path}`).not.toBe(200);
      expect(cf.status, `cf ${path}`).not.toBe(200);
    }
  });

  it("cold and warm concurrent requests stay isolated under load", async () => {
    const names = Array.from({ length: 24 }, (_, i) => `u${i}`);
    const results = await Promise.all(
      names.map((n) =>
        cloudflare
          .fetch("/account", { headers: { "x-display-name": n } })
          .then((r) => r.text()),
      ),
    );
    results.forEach((body, i) =>
      expect(body).toContain(`Hello ${names[i]} via`),
    );
  });
});

describe("serverless parity: failed deployment assembly", () => {
  it("a page whose sidecar entry is missing fails assembly and leaves no bundle behind", async () => {
    const root = await createServerlessFixture("missing-artifact");
    try {
      await buildServerlessFixture(root, "cloudflare-pages");
      const { readFile, writeFile, stat } = await import("node:fs/promises");
      const sidecarPath = join(root, "dist/.bascik/server-scripts.json");
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as {
        scripts: Record<string, unknown>;
      };
      // Drop one entry so a placeholder in dist/account.html has no source.
      const [firstId] = Object.keys(sidecar.scripts);
      delete sidecar.scripts[firstId];
      await writeFile(sidecarPath, JSON.stringify(sidecar), "utf8");
      // Assemble from the tampered dist/ through a child process with the same
      // config, without rebuilding pages (the emitter is the unit under test).
      const script = `
        import { emitServerlessArtifacts } from ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), "../../../pkg/dist/lib/serverless-artifacts.js"))};
        await emitServerlessArtifacts("cloudflare-pages", { version: "test" });
      `;
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const outcome = await run(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          cwd: root,
          env: { ...process.env, BASCIK_BUILD: "1" },
        },
      ).catch((e: { stderr: string }) => e);
      expect(outcome.stderr).toContain("missing from the sidecar");
      await expect(
        stat(join(root, "dist/.bascik/cloudflare-pages/public/_worker.js")),
      ).rejects.toThrow();
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 120_000);
});

// A site built with a non-root base is requested with the prefix on every URL.
// Both variants must serve static pages, assets, and the custom 404 below it,
// exactly as `bascik --server` does, and nothing outside it.
for (const target of ["cloudflare-pages", "cloudflare-workers"] as const) {
  describe(`serverless parity: non-root base (${target})`, () => {
    let root: string;
    let node: NodeOracle;
    let cloudflare: Harness;

    beforeAll(async () => {
      root = await createServerlessFixture(`base-${target}`, {
        base: "/docs/",
      });
      await buildServerlessFixture(root, target);
      node = await startNodeServer(root);
      cloudflare = await startHarness({
        projectRoot: root,
        target,
        bindings: { GREETING: "kv" },
      });
    }, 180_000);

    afterAll(async () => {
      await cloudflare?.dispose();
      await node?.stop();
      if (root) await cleanupServerlessFixture(root);
    });

    it("serves static pages, assets, .well-known, dynamic pages, and API routes below the base", async () => {
      for (const path of [
        "/docs/",
        "/docs/assets/logo.txt",
        "/docs/style.css",
        "/docs/.well-known/security.txt",
        "/docs/api/health",
      ]) {
        const n = await observe(await fetch(new URL(path, node.url)));
        const cf = await observe(await cloudflare.fetch(path));
        expect(n.status, `node ${path}`).toBe(200);
        expect(cf.status, `cf ${path}`).toBe(200);
        expect(cf.body, path).toBe(n.body);
        expect(cf.headers["content-type"]?.split(";")[0], path).toBe(
          n.headers["content-type"]?.split(";")[0],
        );
      }
      const account = await cloudflare.fetch("/docs/account");
      expect(account.status).toBe(200);
      expect(await account.text()).toContain("via cloudflare");
    });

    it("answers a missing page below the base with the custom 404 and keeps paths outside the base unserved", async () => {
      const n = await observe(await fetch(new URL("/docs/nope", node.url)));
      const cf = await observe(await cloudflare.fetch("/docs/nope"));
      expect(n.status).toBe(404);
      expect(cf.status).toBe(404);
      expect(cf.body).toContain("Custom 404");
      expect(n.body).toContain("Custom 404");
      const own = await cloudflare.fetch("/docs/404");
      expect(own.status).toBe(404);
      expect(await own.text()).toContain("Custom 404");
      for (const outside of ["/", "/assets/logo.txt", "/index.html"]) {
        const res = await cloudflare.fetch(outside, { redirect: "manual" });
        expect(res.status, `cf ${outside}`).toBe(404);
        await res.arrayBuffer();
      }
    });
  });
}

// ─── Request-time components (prompt 157) ───────────────────────────────────
//
// The catalog demo (the e2e fixture's pages and components, copied verbatim)
// and the misuse pages, served from ONE dist by both hosts. The renderer is
// the same portable module on both; what differs is the host: the name hash
// (identity, or the build's attribute hash under minify.identifiers, which
// the Worker computes with node:crypto under nodejs_compat), the component
// job lookup, the deadline and the error policy. Byte equality of the whole
// body is the oracle; the absolute assertions name what a reader would see.

/**
 * Markup outside HTML comments. Without minify.html a component's own
 * comments (its `@bascik` usage sample among them) are emitted with every
 * instance, as at build time; they are author text, not an unrendered tag.
 * A comment ends where the HTML parser ends it ("-->", "--!>", an abrupt
 * "<!-->" or the end of input), in one pass: removing again could join text
 * around a comment into a new one and hide a tag the browser shows.
 */
const markup = (html: string): string =>
  html.replace(/<!--(?:-?>|[\s\S]*?(?:--!?>|$))/g, "");

/** Every `<style>` block of `html` that defines `className`. */
const styleBlocksDefining = (html: string, className: string): string[] =>
  [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .filter((m) => m[1].includes(`.${className}{`))
    .map((m) => m[0]);

/** The class and id of every element carrying `data-testid="<testid>"`. */
const instancesOf = (
  html: string,
  testid: string,
): Array<{ id: string; className: string; index: number }> =>
  [
    ...html.matchAll(
      new RegExp(
        `<article id="?([^"\\s>]+)"? class="?([^"\\s>]+)"? data-testid="?${testid}"?[\\s>]`,
        "g",
      ),
    ),
  ].map((m) => ({ id: m[1], className: m[2], index: m.index ?? -1 }));

const PRODUCT_NAMES = [
  "Pour-over kettle",
  "Ceramic dripper",
  "Milk frother",
  "Glass carafe",
  "Filters &amp; holder",
];

for (const config of [
  { base: "/", identifiers: false, minifyHtml: false },
  { base: "/sub/", identifiers: true, minifyHtml: true },
] as const) {
  describe(`serverless parity: components returned by scripts (base ${config.base}, identifiers ${config.identifiers ? "on" : "off"}, prompt 157)`, () => {
    let root: string;
    let node: NodeOracle;
    let cloudflare: Harness;
    const at = (path: string) =>
      config.base === "/" ? path : `${config.base.slice(0, -1)}${path}`;

    beforeAll(async () => {
      root = await createServerlessFixture(
        `components-${config.identifiers ? "ids" : "readable"}`,
        { components: true, ...config },
      );
      await buildServerlessFixture(root, "cloudflare-pages");
      node = await startNodeServer(root);
      cloudflare = await startHarness({
        projectRoot: root,
        target: "cloudflare-pages",
      });
    }, 180_000);

    afterAll(async () => {
      await cloudflare?.dispose();
      await node?.stop();
      if (root) await cleanupServerlessFixture(root);
    });

    const both = async (
      path: string,
      init?: RequestInit,
    ): Promise<{ node: Observed; cf: Observed }> => ({
      node: await observe(await fetch(new URL(at(path), node.url), init)),
      cf: await observe(await cloudflare.fetch(at(path), init)),
    });

    it("catalog.html: identical bytes on both hosts, every <product-card> rendered, with and without ?q=", async () => {
      for (const query of ["", "?q=frother", "?q=FILTERS", "?q=nothing"]) {
        const { node: n, cf } = await both(`/catalog${query}`);
        expect(n.status, `node ${query}`).toBe(200);
        expect(cf.status, `cf ${query}`).toBe(200);
        // The oracle renders; the Worker must not hand the tag to the client.
        expect(markup(n.body), `node ${query}`).not.toContain("<product-card");
        expect(markup(cf.body), `cf ${query}`).not.toContain("<product-card");
        expect(cf.body, query).toBe(n.body);
      }
      const all = (await both("/catalog")).cf.body;
      for (const name of PRODUCT_NAMES) expect(all).toContain(`>${name}<`);
      const one = (await both("/catalog?q=frother")).cf.body;
      expect(instancesOf(one, "product-card")).toHaveLength(1);
      expect(one).toContain(">Best seller<");
      expect((await both("/catalog?q=nothing")).cf.body).toContain(
        'data-testid="catalog-empty"',
      );
    });

    it("catalog.html: one <style> per component per response, defining the scoped class the instances carry, before the first one", async () => {
      const { node: n, cf } = await both("/catalog");
      for (const [label, body] of [
        ["node", n.body],
        ["cloudflare", cf.body],
      ] as const) {
        const cards = instancesOf(body, "product-card");
        expect(cards, label).toHaveLength(5);
        const className = cards[0].className;
        if (!config.identifiers)
          expect(className, label).toBe("bascik__product-card__tile");
        for (const card of cards) expect(card.className, label).toBe(className);
        const blocks = styleBlocksDefining(body, className);
        expect(blocks, label).toHaveLength(1);
        expect(body.indexOf(blocks[0]), label).toBeLessThan(cards[0].index);
        expect(body.indexOf(blocks[0]), label).toBeGreaterThan(
          body.indexOf("</head>"),
        );
      }
    });

    it("catalog.html: each instance gets a distinct request-time id, the same on both hosts", async () => {
      const { node: n, cf } = await both("/catalog");
      const ids = instancesOf(cf.body, "product-card").map((c) => c.id);
      expect(ids).toEqual(instancesOf(n.body, "product-card").map((c) => c.id));
      expect(new Set(ids).size).toBe(5);
      if (!config.identifiers)
        for (const id of ids)
          expect(id).toMatch(/^bascik__product-card__r[0-9a-f]{7}__tile$/);
    });

    it("catalog.html: the nested job of <product-card-live> ran with the request and its output carries the component's classes", async () => {
      const { node: n, cf } = await both("/catalog");
      const stock = `In stock · checked for ${at("/catalog")} at request time`;
      expect(n.body).toContain(stock);
      expect(cf.body).toContain(stock);
      expect(markup(cf.body)).not.toContain("<product-card-live");
      if (!config.identifiers)
        expect(cf.body).toContain(
          `<p class="bascik__product-card-live__stock" data-testid="product-card-stock">${stock}</p>`,
        );
      expect(cf.body).not.toContain("text/bascik-server");
    });

    it("catalog.html: the escaped sample in <pre><code> is page markup and stays text", async () => {
      const { cf } = await both("/catalog");
      expect(cf.body).toContain(
        "<code>&lt;product-card data-bascik-prop-name=",
      );
    });

    it("catalog.html: HEAD content-length equals the GET body length on both hosts", async () => {
      for (const host of ["node", "cf"] as const) {
        const head =
          host === "node"
            ? await fetch(new URL(at("/catalog"), node.url), { method: "HEAD" })
            : await cloudflare.fetch(at("/catalog"), { method: "HEAD" });
        expect(head.status, host).toBe(200);
        await head.arrayBuffer();
        const streamed =
          host === "node"
            ? await rawStreamed(node.url, at("/catalog"))
            : await cloudflare.streamed(at("/catalog"));
        const body = (await streamed.all()).map((c) => c.text).join("");
        expect(Number(head.headers.get("content-length")), host).toBe(
          Buffer.byteLength(body, "utf8"),
        );
      }
    });

    it("catalog-stream.html: identical ordered fragments on both hosts, one <style> ahead of the first tile", async () => {
      // Batch 1 is the slowest and batch 2 the fastest: completion order is
      // not document order, so the style decision must follow the document.
      const path = at("/catalog-stream?delay=60");
      const nodeStream = await rawStreamed(node.url, path);
      const cfStream = await cloudflare.streamed(path);
      const nodeBody = (await nodeStream.all()).map((c) => c.text).join("");
      const cfBody = (await cfStream.all()).map((c) => c.text).join("");
      expect(cfStream.status).toBe(200);
      expect(cfStream.headers["content-length"]).toBeUndefined();
      expect(markup(nodeBody)).not.toContain("<product-card");
      expect(markup(cfBody)).not.toContain("<product-card");
      expect(cfBody).toBe(nodeBody);
      const positions = PRODUCT_NAMES.map((name) =>
        cfBody.indexOf(`>${name}<`),
      );
      expect(positions.every((p) => p > 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      const cards = instancesOf(cfBody, "product-card");
      expect(cards).toHaveLength(5);
      const blocks = styleBlocksDefining(cfBody, cards[0].className);
      expect(blocks).toHaveLength(1);
      expect(cfBody.indexOf(blocks[0])).toBeLessThan(cards[0].index);
      // The shell was sent before any batch: the footer precedes every tile.
      expect(
        cfBody.indexOf('data-testid="catalog-stream-footer"'),
      ).toBeLessThan(cards[0].index);
    });

    it("misuse: typo'd, escaped, attribute-embedded and unsupported tags and a guessed placeholder pass through verbatim on both hosts; only the supported tag renders", async () => {
      const { node: n, cf } = await both("/components-misuse");
      expect(cf.status).toBe(200);
      expect(cf.body).toBe(n.body);
      expect(cf.body).toContain(
        '<product-crad data-testid="typo">typo stays</product-crad>',
      );
      expect(cf.body).toContain("&lt;product-card&gt; stays text");
      expect(cf.body).toContain('title="<product-card>"');
      // Unsupported (a prop bound to id): left as the author wrote it.
      expect(cf.body).toContain(
        '<bound-id-card data-bascik-prop-anchor="x"></bound-id-card>',
      );
      // A guessed staged placeholder is author text: nothing runs.
      expect(cf.body).toContain(
        `data-bascik-server-id="${componentScriptId("product-card-live")}"`,
      );
      expect(cf.body).not.toContain("product-card-stock");
      // The supported tag renders, and its bound href is below the base.
      expect(markup(cf.body)).not.toContain("<link-card");
      expect(cf.body).toMatch(
        new RegExp(
          `data-testid="?link-card"? href="?${at("/pricing")}"?[\\s>]`,
        ),
      );
    });

    it("budgets: 1000 instances and 64 nested jobs render; 1001 instances and 65 nested jobs are the 500 page on both hosts", async () => {
      for (const [query, status] of [
        ["?n=1000", 200],
        ["?n=1001", 500],
        ["?n=64&kind=live", 200],
        ["?n=65&kind=live", 500],
      ] as const) {
        const { node: n, cf } = await both(`/components-budget${query}`);
        expect(n.status, `node ${query}`).toBe(status);
        expect(cf.status, `cf ${query}`).toBe(status);
        expect(cf.body, query).toBe(n.body);
        expect(markup(cf.body), query).not.toContain("<product-card");
      }
    });

    it("budgets: a component whose script returns itself stops at depth 4 with the 500 page on both hosts", async () => {
      const { node: n, cf } = await both("/components-chain");
      expect(n.status).toBe(500);
      expect(cf.status).toBe(500);
      expect(cf.body).toBe(n.body);
      expect(markup(cf.body)).not.toContain("<chain-card");
    });

    it("policy error: a nested job that throws is the 500 page under a server parent and an empty slot under a stream parent", async () => {
      const server = await both("/components-boom");
      expect(server.node.status).toBe(500);
      expect(server.cf.status).toBe(500);
      expect(server.cf.body).toBe(server.node.body);
      expect(server.cf.body).not.toContain("SECRET_DETAIL");
      const stream = await both("/components-boom-stream");
      expect(stream.node.status).toBe(200);
      expect(stream.cf.status).toBe(200);
      expect(stream.cf.body).toBe(stream.node.body);
      expect(stream.cf.body).toContain('data-testid="tail"');
      expect(markup(stream.cf.body)).not.toContain("<boom-card");
      expect(stream.cf.body).not.toContain("SECRET_DETAIL");
    });

    it("misuse: a component script without a default export is the 500 page on both hosts", async () => {
      const { node: n, cf } = await both("/components-nodefault");
      expect(n.status).toBe(500);
      expect(cf.status).toBe(500);
      expect(cf.body).toBe(n.body);
    });

    it("ids: components returned by sibling nested jobs that finish in random order get the same ids on every request, on both hosts", async () => {
      const bodies = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const { node: n, cf } = await both("/components-nest");
        expect(n.status, `request ${i}`).toBe(200);
        expect(cf.status, `request ${i}`).toBe(200);
        expect(cf.body, `request ${i}`).toBe(n.body);
        bodies.add(n.body);
      }
      expect(bodies.size).toBe(1);
      const [body] = bodies;
      expect(markup(body)).not.toContain("<product-card");
      const inner = instancesOf(body, "product-card");
      expect(inner).toHaveLength(3);
      expect(new Set(inner.map((card) => card.id)).size).toBe(3);
    });

    it("misuse: ANSI escapes printed by a component script and by a page script are stripped the same way on both hosts", async () => {
      const { node: n, cf } = await both("/components-ansi");
      expect(n.status).toBe(200);
      expect(cf.status).toBe(200);
      expect(cf.body).toBe(n.body);
      expect(cf.body).not.toContain("\u001b");
      expect(cf.body).toMatch(/>red<\/i>/);
      expect(cf.body).toContain("page");
    });

    it("misuse: a percent-encoded spelling of the route gets the plain route's instance ids on both hosts", async () => {
      const ids = (html: string) =>
        [
          ...instancesOf(html, "product-card"),
          ...instancesOf(html, "product-card-live"),
        ].map((card) => card.id);
      const plain = await both("/catalog");
      expect(ids(plain.cf.body)).toHaveLength(6);
      for (const spelling of ["/c%61talog", "/%63%61talog"]) {
        const encoded = await both(spelling);
        expect(encoded.node.status, spelling).toBe(200);
        expect(encoded.cf.status, spelling).toBe(200);
        expect(ids(encoded.node.body), spelling).toEqual(ids(plain.node.body));
        expect(ids(encoded.cf.body), spelling).toEqual(ids(plain.cf.body));
        expect(ids(encoded.cf.body), spelling).toEqual(ids(encoded.node.body));
      }
    });
  });
}

// Nested-job failure under each policy, and a nested job that outlives the
// page's deadline, compared byte for byte (prompt 157). A short deadline
// keeps the timeout cases fast.
for (const policy of ["error", "warn", "ignore"] as const) {
  describe(`serverless parity: nested component jobs under onServerScriptError "${policy}" (prompt 157)`, () => {
    let root: string;
    let node: NodeOracle;
    let cloudflare: Harness;

    beforeAll(async () => {
      root = await createServerlessFixture(`components-policy-${policy}`, {
        components: true,
        onServerScriptError: policy,
        scriptTimeout: 1000,
      });
      await buildServerlessFixture(root, "cloudflare-pages");
      node = await startNodeServer(root);
      cloudflare = await startHarness({
        projectRoot: root,
        target: "cloudflare-pages",
        collectLogs: true,
      });
    }, 180_000);

    afterAll(async () => {
      await cloudflare?.dispose();
      await node?.stop();
      if (root) await cleanupServerlessFixture(root);
    });

    const both = async (
      path: string,
    ): Promise<{ node: Observed; cf: Observed }> => ({
      node: await observe(await fetch(new URL(path, node.url))),
      cf: await observe(await cloudflare.fetch(path)),
    });

    /**
     * `both(path)`, plus the `[bascik]` report each host logged for it. A
     * log is written as the response is settled, so each host's log is
     * awaited until it holds `expected`; with nothing expected, both are
     * read after a grace period in which a stray log would have arrived.
     */
    const bothWithLogs = async (path: string, expected: RegExp | null) => {
      const nodeFrom = node.output().length;
      const cfFrom = cloudflare.logs.length;
      const observed = await both(path);
      const nodeLog = () => node.output().slice(nodeFrom);
      const cfLog = () => cloudflare.logs.slice(cfFrom).join("\n");
      const deadline = Date.now() + 5000;
      if (expected) {
        while (
          Date.now() < deadline &&
          !(expected.test(nodeLog()) && expected.test(cfLog()))
        )
          await new Promise((r) => setTimeout(r, 25));
      } else {
        await new Promise((r) => setTimeout(r, 300));
      }
      return {
        ...observed,
        nodeLog: nodeLog().trim(),
        cfLog: cfLog().trim(),
      };
    };

    it("a nested job that throws: the 500 page under error, else the card with an empty slot, under a server parent; an empty slot under a stream parent", async () => {
      const server = await both("/components-boom");
      const status = policy === "error" ? 500 : 200;
      expect(server.node.status).toBe(status);
      expect(server.cf.status).toBe(status);
      expect(server.cf.body).toBe(server.node.body);
      expect(server.cf.body).not.toContain("SECRET_DETAIL");
      if (policy !== "error") {
        expect(server.cf.body).toContain('data-testid="boom-card"');
        expect(server.cf.body).toContain('data-testid="after-boom"');
      }
      const stream = await both("/components-boom-stream");
      expect(stream.node.status).toBe(200);
      expect(stream.cf.status).toBe(200);
      expect(stream.cf.body).toBe(stream.node.body);
      expect(stream.cf.body).toContain('data-testid="tail"');
      expect(stream.cf.body).not.toContain("SECRET_DETAIL");
    });

    // D4.6: every kind of request-time render failure (the instance,
    // nested-job, depth and size budgets, and a "failed during <stage>")
    // follows the policy like any other script failure, with the same bytes
    // and the same located log line on both hosts.
    const renderFailures: Array<{ path: string; message: RegExp }> = [
      {
        path: "/components-budget?n=1001",
        message:
          /expands to more than 1000 component instances \(<product-card>, components\/product-card\/product-card\.html\)/,
      },
      {
        path: "/components-budget?n=65&kind=live",
        message:
          /would run more than 64 nested component scripts in one response \(<product-card-live>, components\/product-card-live\/product-card-live\.html:\d+\)/,
      },
      {
        path: "/components-chain",
        message:
          /nests component scripts deeper than 4 levels \(<chain-card>, components\/chain-card\/chain-card\.html:\d+\)/,
      },
      {
        path: "/components-size?kind=rendered",
        message:
          /rendered to \d+ characters, over the 4 MiB \(4194304 characters\) limit per script output \(<twice-card>, components\/twice-card\/twice-card\.html\)/,
      },
      {
        path: "/components-size?kind=grew",
        message:
          /grew past \d+ characters while expanding components \(<four-card>, components\/four-card\/four-card\.html\)/,
      },
      {
        path: "/components-size?kind=refused",
        message:
          /is \d+ characters before rendering, over twice the 4 MiB \(4194304 characters\) limit per script output, and has component tags in it, so it is refused before they are expanded\./,
      },
      {
        path: "/components-size?kind=scan",
        message:
          /made the renderer rescan more than \d+ characters while expanding components \(<once-card>, components\/once-card\/once-card\.html\), over the limit of 16 times the output's \d+ characters plus 33554432\./,
      },
      {
        path: "/components-size?kind=stage",
        message:
          /Rendering <wide-card> \(components\/wide-card\/wide-card\.html\) from (?:server|stream)-script output at "\/components-size(?:-stream)?" failed during slot resolution: Invalid string length/,
      },
    ];
    const streamTwin = (path: string) =>
      path.replace(
        /^\/components-(budget|chain|size)/,
        (_, page: string) => `/components-${page}-stream`,
      );

    for (const failure of renderFailures) {
      it(`misuse: ${failure.path} (server and stream) is the 500 page under error and an empty slot under warn and ignore for a server script, an empty slot for a stream script; the same bytes and the same located log on both hosts`, async () => {
        for (const path of [failure.path, streamTwin(failure.path)]) {
          const stream = path.includes("-stream");
          const logged = policy !== "ignore";
          const r = await bothWithLogs(path, logged ? failure.message : null);
          const status = !stream && policy === "error" ? 500 : 200;
          expect(r.node.status, `node ${path}`).toBe(status);
          expect(r.cf.status, `cf ${path}`).toBe(status);
          expect(r.cf.body, path).toBe(r.node.body);
          for (const tag of [
            "<product-card",
            "<chain-card",
            "<once-card",
            "<twice-card",
            "<four-card",
            "<wide-card",
          ])
            expect(markup(r.cf.body), path).not.toContain(tag);
          if (status === 200) {
            expect(r.cf.body, path).toContain('data-testid="shell"');
            expect(r.cf.body, path).toContain('data-testid="tail"');
            // The slot is empty: nothing of the failed output is sent.
            expect(r.cf.body, path).not.toContain('data-testid="product-card"');
            expect(r.cf.body, path).not.toContain('data-testid="chain-card"');
            expect(r.cf.body, path).not.toContain("xxxxxxxx");
          }
          if (!logged) {
            expect(r.nodeLog, `node log ${path}`).toBe("");
            expect(r.cfLog, `cf log ${path}`).toBe("");
            continue;
          }
          // The located message every server-script error logs: the route
          // and the component file, never a stack of Bascik internals.
          const route = new URL(path, "http://x").pathname;
          expect(r.cfLog, `cf log ${path}`).toBe(r.nodeLog);
          expect(r.nodeLog, path).toMatch(failure.message);
          expect(r.nodeLog, path).toContain(
            `[bascik] server script error at "${route}":\n`,
          );
          expect(r.nodeLog, path).not.toContain("RequestRenderError");
          expect(r.nodeLog, path).not.toMatch(/^\s+at /m);
          expect(r.nodeLog, path).not.toMatch(
            /request-render|component-host|_worker\.js/,
          );
        }
      }, 60_000);
    }

    it("misuse: a page job, a stream job and a component job that resolve inside their abort listener at the deadline time out under the policy on both hosts, never delivering what they returned", async () => {
      for (const path of [
        "/deadline-yield",
        "/deadline-yield-stream",
        "/components-yield",
        "/components-yield-stream",
      ]) {
        const { node: n, cf } = await both(path);
        const stream = path.endsWith("-stream");
        // A server job's error-policy failure is the 500 page before commit;
        // a stream job's is an empty slot after it.
        const status = !stream && policy === "error" ? 500 : 200;
        expect(n.status, `node ${path}`).toBe(status);
        expect(cf.status, `cf ${path}`).toBe(status);
        expect(n.body, `node ${path}`).not.toContain("yielded-late");
        expect(cf.body, `cf ${path}`).not.toContain("yielded-late");
        expect(cf.body, path).toBe(n.body);
        if (status === 200)
          expect(cf.body, path).toContain('data-testid="tail"');
        if (
          status === 200 &&
          path.startsWith("/components") &&
          policy !== "error"
        )
          expect(cf.body, path).toContain('data-testid="yield-card"');
      }
    }, 20_000);

    it("misuse: an API route that returns a Response inside its abort listener at the deadline is a 504 on both hosts", async () => {
      const { node: n, cf } = await both("/api/deadline-yield");
      expect(n.status).toBe(504);
      expect(cf.status).toBe(504);
      expect(n.body).not.toContain("yielded-late");
      expect(cf.body).toBe(n.body);
    }, 20_000);

    it("misuse: a client that disconnects mid nested job: Node aborts its signal at once; workerd, which reports no disconnect while a streamed slot is idle, aborts it at the deadline; neither leaves it running", async () => {
      for (const host of ["node", "cf"] as const) {
        const key = `disconnect-${host}`;
        const fetchHost = (path: string) =>
          host === "node"
            ? fetch(new URL(path, node.url))
            : cloudflare.fetch(path);
        const state = async (): Promise<string> =>
          (
            (await (await fetchHost(`/api/abort-probe?key=${key}`)).json()) as {
              state: string;
            }
          ).state;
        const waitFor = async (expected: string, timeoutMs: number) => {
          const deadline = Date.now() + timeoutMs;
          let seen = await state();
          while (seen !== expected && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 20));
            seen = await state();
          }
          expect(seen, `${host}: nested job state`).toBe(expected);
        };
        const path = `/components-slow-stream?key=${key}`;
        const started = Date.now();
        const streamed =
          host === "node"
            ? await rawStreamed(node.url, path)
            : await cloudflare.streamed(path);
        expect(streamed.status, host).toBe(200);
        // The shell before the slot is sent; the rest waits for the job.
        await streamed.until('data-testid="shell"');
        await waitFor("started", 3000);
        streamed.destroy();
        await waitFor("aborted", 3000);
        const abortedAfter = Date.now() - started;
        // The deadline is 1 s: Node's abort comes from the disconnect.
        if (host === "node") expect(abortedAfter, host).toBeLessThan(900);
        else expect(abortedAfter, host).toBeLessThan(1900);
        // The host keeps serving after the abandoned response.
        const next = await fetchHost("/components-boom-stream");
        expect(next.status, host).toBe(200);
        await next.arrayBuffer();
      }
    }, 20_000);

    it("a nested job past the deadline times out at what is left of the page's budget, and its signal aborts, on both hosts", async () => {
      for (const parent of ["slow", "slow-stream"] as const) {
        const observed: Observed[] = [];
        for (const host of ["node", "cf"] as const) {
          const key = `timeout-${parent}-${host}`;
          const path = `/components-${parent}?key=${key}`;
          const started = Date.now();
          const res =
            host === "node"
              ? await fetch(new URL(path, node.url))
              : await cloudflare.fetch(path);
          observed.push(await observe(res));
          const elapsed = Date.now() - started;
          // One 1 s budget for the page and its nested job, not two.
          expect(elapsed, `${host} ${parent}`).toBeGreaterThanOrEqual(900);
          expect(elapsed, `${host} ${parent}`).toBeLessThan(1900);
          const probePath = `/api/abort-probe?key=${key}`;
          const probe =
            host === "node"
              ? await fetch(new URL(probePath, node.url))
              : await cloudflare.fetch(probePath);
          expect(
            ((await probe.json()) as { state: string }).state,
            `${host} ${parent}`,
          ).toBe("aborted");
        }
        const [n, cf] = observed;
        const status = parent === "slow" && policy === "error" ? 500 : 200;
        expect(n.status, parent).toBe(status);
        expect(cf.status, parent).toBe(status);
        expect(cf.body, parent).toBe(n.body);
        expect(cf.body, parent).not.toContain("slow-done");
        // Under error a stream parent's whole slot is empty after commit;
        // under warn and ignore only the nested output is.
        if (status === 200)
          expect(cf.body, parent).toContain('data-testid="tail"');
        if (policy !== "error")
          expect(cf.body, parent).toContain('data-testid="slow-card"');
      }
    });
  });
}

// ─── Request-time components: attacker lens (prompt 157 security audit) ────
//
// A visitor controls `?q=`, which the page script escapes (the docs' search
// escaper, or the docs' full escaper with `esc=full`) into props, slots and
// inherited attributes of returned component tags. Every case asserts the
// SAFE outcome and byte equality on both hosts; a failure here is a finding
// a correctly escaping author cannot stop, on that host.
describe("serverless parity: escaped visitor input in returned component tags (prompt 157 security)", () => {
  let root: string;
  let node: NodeOracle;
  let cloudflare: Harness;

  beforeAll(async () => {
    root = await createServerlessFixture("components-security", {
      components: true,
      security: true,
    });
    await buildServerlessFixture(root, "cloudflare-pages");
    node = await startNodeServer(root);
    cloudflare = await startHarness({
      projectRoot: root,
      target: "cloudflare-pages",
    });
  }, 180_000);

  afterAll(async () => {
    await cloudflare?.dispose();
    await node?.stop();
    if (root) await cleanupServerlessFixture(root);
  });

  const page = (q: string, extra = ""): string =>
    `/components-security?q=${encodeURIComponent(q)}${extra}`;
  const both = async (
    path: string,
  ): Promise<{ node: Observed; cf: Observed }> => ({
    node: await observe(await fetch(new URL(path, node.url))),
    cf: await observe(await cloudflare.fetch(path)),
  });
  /** The opening tag of the element carrying `data-testid="<id>"`. */
  const openTagOf = (html: string, id: string): string =>
    html.match(
      new RegExp(
        `<[a-z]+(?:[^>"']|"[^"]*"|'[^']*')*data-testid=["']?${id}["']?(?:[^>"']|"[^"]*"|'[^']*')*>`,
      ),
    )?.[0] ?? "";

  it("A. text and attribute payloads escaped into the catalog card's props, slot and inherited title never become markup, on both hosts", async () => {
    const payloads = [
      `<script>alert(1)</script>`,
      `"><img src=x onerror=alert(1)>`,
      `</textarea><img src=x onerror=alert(1)>`,
      `--><img src=x onerror=alert(1)>`,
      `&lt;img src=x onerror=alert(1)&gt;`,
      `<product-card-live></product-card-live>`,
      `<script type="text/bascik-server" data-bascik-job="${"0".repeat(32)}:0"></script>`,
    ];
    for (const q of payloads) {
      for (const esc of ["", "&esc=full"]) {
        const { node: n, cf } = await both(page(q, `${esc}&only=card`));
        expect(n.status, q).toBe(200);
        expect(cf.status, q).toBe(200);
        expect(cf.body, q).toBe(n.body);
        const body = markup(cf.body);
        // Visitor text is only ever text: no element it spelled, no job it named.
        expect(body, q).not.toMatch(
          /<img|<script>alert|<script type="text\/bascik-server"|<product-card-live|product-card-stock/,
        );
      }
    }
  });

  it("D. a nested job started by a returned card sees none of the usage's props or slot, and one instance runs one job, on both hosts", async () => {
    const q = "http://169.254.169.254/latest/meta-data/";
    const { node: n, cf } = await both(page(q, "&only=live"));
    expect(cf.status).toBe(200);
    expect(cf.body).toBe(n.body);
    const stock = [
      ...cf.body.matchAll(/In stock · checked for ([^<]*) at request time/g),
    ];
    expect(stock).toHaveLength(1);
    expect(stock[0][1]).toBe("/components-security");
  });

  it("F. CR/LF and header-shaped visitor text stay in the body: no Set-Cookie, the dynamic cache policy and Vary unchanged, on both hosts", async () => {
    const q = "x\r\nSet-Cookie: pwned=1\r\nVary: *\r\n\r\n<h1>split</h1>";
    const { node: n, cf } = await both(page(q, "&only=card"));
    for (const [host, r] of [
      ["node", n],
      ["cf", cf],
    ] as const) {
      expect(r.status, host).toBe(200);
      expect(r.headers["set-cookie"], host).toBeUndefined();
      expect(r.headers["cache-control"], host).toBe("private, no-store");
      expect(r.headers["vary"] ?? "", host).not.toContain("*");
      expect(markup(r.body), host).not.toContain("<h1>split");
    }
    expect(cf.body).toBe(n.body);
  });

  it("B. a prop bound to href never carries a script URL a visitor typed, on both hosts", async () => {
    const findings: string[] = [];
    for (const q of [
      "javascript:alert(document.domain)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      " \u0001javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      const { node: n, cf } = await both(page(q, "&only=link"));
      expect(cf.body, q).toBe(n.body);
      const href =
        /href="([^"]*)"/.exec(openTagOf(cf.body, "sec-link"))?.[1] ?? "";
      const scheme = href
        .replace(/&#9;|\t|\n/g, "")
        .replace(/^[\u0000- ]+/, "")
        .toLowerCase();
      if (/^(?:javascript|vbscript|data):/.test(scheme))
        findings.push(`${JSON.stringify(q)} -> href="${href}"`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("B. a prop bound to srcdoc never carries visitor markup into the frame, on both hosts", async () => {
    const q = "<script>alert(document.domain)</script>";
    const { node: n, cf } = await both(page(q, "&only=srcdoc"));
    expect(cf.body).toBe(n.body);
    const srcdoc =
      /srcdoc="([^"]*)"/.exec(openTagOf(cf.body, "sec-srcdoc"))?.[1] ?? "";
    // The browser decodes the attribute once and parses the result as a document.
    const decoded = srcdoc
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    expect(decoded).not.toContain("<script>");
  });

  it("A. a prop received by a component's client <script> never becomes script text, on both hosts", async () => {
    const q = "alert(document.domain)";
    const { node: n, cf } = await both(page(q, "&esc=full&only=script"));
    expect(cf.body).toBe(n.body);
    expect(cf.body).not.toMatch(
      /<script>\s*alert\(document\.domain\)\s*<\/script>/,
    );
  });

  it("A. an inherited class escaped with the docs' search escaper never adds an attribute to a single-quoted root, on both hosts", async () => {
    const q = "x' onmouseover='alert(document.domain)";
    const { node: n, cf } = await both(page(q, "&only=inherit"));
    expect(cf.body).toBe(n.body);
    // Attribute names as the tokenizer reads them: text inside a quoted
    // value (the visitor's `onmouseover=`, now `&#39;`-encoded) is not one.
    const names = [
      ...openTagOf(cf.body, "sec-inherit").matchAll(
        /\s([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
      ),
    ].map((match) => match[1].toLowerCase());
    expect(names).toEqual(["class", "data-testid", "title"]);
  });
});
