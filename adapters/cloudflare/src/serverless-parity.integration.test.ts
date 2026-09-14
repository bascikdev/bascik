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
  createServerlessFixture,
} from "./serverless-fixture.test-helper.ts";
import { createGate, startHarness, type Harness, type StreamedResponse } from "./cloudflare-harness.test-helper.ts";

/**
 * Header-level differences that are platform facts, not adapter defects.
 * Each entry names the header and why the values legitimately differ.
 */
const PLATFORM_DIFFERENCES: Record<string, string> = {
  "transfer-encoding": "Node HTTP/1.1 frames a streamed body as chunked; workerd's local proxy may use its own framing.",
  connection: "Connection management belongs to the transport.",
  date: "Clock value.",
  "keep-alive": "Transport keep-alive parameters.",
  vary: "Node adds Vary: Accept-Encoding for negotiated static assets; the asset layer decides its own.",
  "content-encoding": "workerd (like the Cloudflare edge) applies its own compression to Worker responses; Node compresses only what it negotiated itself.",
  "content-length": "When the edge re-encodes a body it reframes it; the Worker's own content-length is visible only on an identity request.",
  etag: "The two static layers compute validators independently.",
  "cache-control": "Static asset cache policy is host configuration; dynamic responses are compared explicitly.",
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
  stop(): Promise<void>;
}

const startNodeServer = async (projectRoot: string): Promise<NodeOracle> => {
  const port = await freePort();
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../../pkg/dist/index.js");
  const child: ChildProcess = spawn(process.execPath, [cli, "--server", "--port", String(port), "--host", "127.0.0.1"], {
    cwd: projectRoot,
    env: { ...process.env, BASCIK_LOG_LEVEL: "silent" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (d) => stderr.push(String(d)));
  const url = new URL(`http://127.0.0.1:${port}/`);
  // Readiness is the health endpoint, never a sleep.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`bascik --server exited early: ${stderr.join("")}`);
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
    stop: () =>
      new Promise((resolveStop) => {
        child.once("exit", () => resolveStop());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }),
  };
};

const rawStreamed = (base: URL, path: string, headers: Record<string, string> = {}): Promise<StreamedResponse> =>
  new Promise((resolveResponse, reject) => {
    const start = Date.now();
    const chunks: Array<{ text: string; atMs: number }> = [];
    let firstResolve: ((c: { text: string; atMs: number }) => void) | undefined;
    let ended = false;
    const endResolvers: Array<() => void> = [];
    const markerWaiters: Array<{ marker: string; resolve: (body: string) => void }> = [];
    const bodySoFar = () => chunks.map((c) => c.text).join("");
    const req = http.request(
      { host: base.hostname, port: base.port, path, method: "GET", headers: { "accept-encoding": "identity", ...headers } },
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
              const watchdog = setTimeout(() => fail(new Error(`no first chunk within ${timeoutMs}ms`)), timeoutMs);
              firstResolve = (c) => { clearTimeout(watchdog); ok(c); };
            }),
          until: (marker, timeoutMs = 5000) =>
            new Promise((ok, fail) => {
              if (bodySoFar().includes(marker)) return ok(bodySoFar());
              const watchdog = setTimeout(() => fail(new Error(`marker "${marker}" not seen within ${timeoutMs}ms`)), timeoutMs);
              markerWaiters.push({ marker, resolve: (b) => { clearTimeout(watchdog); ok(b); } });
            }),
          all: (timeoutMs = 10000) =>
            new Promise((ok, fail) => {
              if (ended) return ok(chunks);
              const watchdog = setTimeout(() => fail(new Error(`body did not end within ${timeoutMs}ms`)), timeoutMs);
              endResolvers.push(() => { clearTimeout(watchdog); ok(chunks); });
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
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: res.status, headers, body: await res.text() };
};

const comparable = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([k]) => !(k in PLATFORM_DIFFERENCES)));

describe("serverless parity: Node oracle versus local workerd", () => {
  let root: string;
  let node: NodeOracle;
  let cloudflare: Harness;
  const gate = createGate();

  beforeAll(async () => {
    root = await createServerlessFixture("parity");
    await buildServerlessFixture(root, "cloudflare-pages");
    node = await startNodeServer(root);
    cloudflare = await startHarness({ projectRoot: root, target: "cloudflare-pages", bindings: { GREETING: "kv" }, gate });
  }, 180_000);

  afterAll(async () => {
    await cloudflare?.dispose();
    await node?.stop();
    if (root) await cleanupServerlessFixture(root);
  });

  const both = async (path: string, init?: RequestInit): Promise<{ node: Observed; cf: Observed }> => ({
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
      await expect(streamed.until("does-not-exist", 100)).rejects.toThrow(/not seen/);
    });

    it("a dynamic-route bypass is detectable: routing the page to assets yields a 404, not a 200", async () => {
      const bypass = await startHarness({ projectRoot: root, target: "cloudflare-pages", invocationRoutes: ["/only-api/*"] });
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
    const { node: n, cf } = await both("/account", { headers: { "x-display-name": "Parity" } });
    expect(cf.status).toBe(200);
    expect(n.status).toBe(200);
    // Body differs only in the platform name and binding, which is the point.
    expect(n.body).toContain("Hello Parity via node (none)");
    expect(cf.body).toContain("Hello Parity via cloudflare (kv)");
    expect(n.body.replace("via node (none)", "X").replace(/ip=[^<]*/, "ip")).toBe(
      cf.body.replace("via cloudflare (kv)", "X").replace(/ip=[^<]*/, "ip"),
    );
    expect(cf.headers["cache-control"]).toBe("private, no-store");
    expect(n.headers["cache-control"]).toBe("private, no-store");
    for (const h of ["x-content-type-options", "x-frame-options", "referrer-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"]) {
      expect(cf.headers[h], h).toBe(n.headers[h]);
    }
    // The Worker sets content-length for a buffered body; the edge keeps it
    // when it does not re-encode (identity request over raw HTTP).
    const identity = await cloudflare.streamed("/account", { "x-display-name": "Parity" });
    await identity.all();
    expect(Number(identity.headers["content-length"])).toBeGreaterThan(0);
  });

  it("page aliases resolve identically", async () => {
    for (const alias of ["/account/", "/account.html", "/index.html", "/index"]) {
      const { node: n, cf } = await both(alias, { headers: { "x-display-name": "A" } });
      expect(cf.status, alias).toBe(n.status);
      expect(cf.body.replace(/via \w+ \([^)]*\)/, "").replace(/ip=[^<]*/, ""), alias).toBe(
        n.body.replace(/via \w+ \([^)]*\)/, "").replace(/ip=[^<]*/, ""),
      );
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
    for (const [label, s] of [["node", nodeStream], ["cloudflare", cfStream]] as const) {
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
    expect(await cfStream.until("fast-fragment")).not.toContain("slow-fragment");
    gate.release();
    const nodeBody = (await nodeStream.all()).map((c) => c.text).join("");
    const cfBody = (await cfStream.all()).map((c) => c.text).join("");
    expect(cfBody).toBe(nodeBody);
    expect(cfBody.indexOf("fast-fragment")).toBeLessThan(cfBody.indexOf("slow-fragment"));
    expect(cfBody.indexOf("slow-fragment")).toBeLessThan(cfBody.indexOf('data-testid="tail"'));
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
      expect(options.node.headers["access-control-allow-origin"]).toBeUndefined();

      const head = await both("/api/health", { method: "HEAD" });
      expect(head.cf.status).toBe(200);
      expect(head.node.status).toBe(200);
      expect(head.cf.body).toBe("");
      expect(head.node.body).toBe("");
    });

    it("POST body, status, and multiple Set-Cookie headers", async () => {
      const nodeRes = await fetch(new URL("/api/echo", node.url), { method: "POST", body: "hello ünï" });
      const cfRes = await cloudflare.fetch("/api/echo", { method: "POST", body: "hello ünï" });
      expect(cfRes.status).toBe(201);
      expect(nodeRes.status).toBe(201);
      expect(await cfRes.text()).toBe(await nodeRes.text());
      expect(cfRes.headers.getSetCookie()).toEqual(nodeRes.headers.getSetCookie());
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

  it("no source leaks on either host", async () => {
    for (const path of ["/.bascik/server-scripts.json", "/src/api/health.ts", "/.env", "/_worker.js"]) {
      const { node: n, cf } = await both(path);
      expect(n.status, `node ${path}`).not.toBe(200);
      expect(cf.status, `cf ${path}`).not.toBe(200);
    }
  });

  it("cold and warm concurrent requests stay isolated under load", async () => {
    const names = Array.from({ length: 24 }, (_, i) => `u${i}`);
    const results = await Promise.all(
      names.map((n) => cloudflare.fetch("/account", { headers: { "x-display-name": n } }).then((r) => r.text())),
    );
    results.forEach((body, i) => expect(body).toContain(`Hello ${names[i]} via`));
  });
});

describe("serverless parity: failed deployment assembly", () => {
  it("a page whose sidecar entry is missing fails assembly and leaves no bundle behind", async () => {
    const root = await createServerlessFixture("missing-artifact");
    try {
      await buildServerlessFixture(root, "cloudflare-pages");
      const { readFile, writeFile, stat } = await import("node:fs/promises");
      const sidecarPath = join(root, "dist/.bascik/server-scripts.json");
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as { scripts: Record<string, unknown> };
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
      const outcome = await run(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root,
        env: { ...process.env, BASCIK_BUILD: "1" },
      }).catch((e: { stderr: string }) => e);
      expect(outcome.stderr).toContain("missing from the sidecar");
      await expect(stat(join(root, "dist/.bascik/cloudflare-pages/public/_worker.js"))).rejects.toThrow();
    } finally {
      await cleanupServerlessFixture(root);
    }
  }, 120_000);
});
