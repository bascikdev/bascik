/**
 * The Worker's fetch handler in-process, against hand-made site graphs and a
 * fake ASSETS binding. The workerd suites (cloudflare.test.ts and the parity
 * suite) prove the bundled Worker behaves like the Node server; these pin
 * each routing decision of runtime.ts directly, including the misuse cases a
 * real deployment rarely reaches: a malformed URL, a control file, a missing
 * binding, a route module that fails to load, a wrong method, a script that
 * fails before a stream commits, and the static 404 page under its own URLs.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createCloudflareWorker,
  stripBase,
  type CloudflareEnv,
  type GraphApiRoute,
  type GraphPage,
  type GraphScriptJob,
  type SiteGraph,
} from "./runtime.ts";

const job = (
  id: string,
  handler: unknown,
  mode: GraphScriptJob["mode"] = "server",
): GraphScriptJob => ({
  id,
  mode,
  load: async () => ({ default: handler }),
});

/** A page `<main>` + one server job + `</main>`. */
const page = (
  path: string,
  handler: unknown,
  extra: Partial<GraphPage> = {},
): GraphPage => ({
  path,
  is404: false,
  segments: [
    { kind: "static", text: "<main>" },
    { kind: "script", id: "server_script_a" },
    { kind: "static", text: "</main>" },
  ],
  jobs: { server_script_a: job("server_script_a", handler) },
  ...extra,
});

const graphOf = (overrides: Partial<SiteGraph> = {}): SiteGraph => ({
  base: "/",
  scriptTimeoutMs: 1000,
  apiTimeoutMs: 1000,
  onServerScriptError: "error",
  pages: {},
  apiRoutes: [],
  release: "test",
  ...overrides,
});

/** A fake ASSETS binding that records what it was asked for. */
const assets = (
  respond: (request: Request) => Response = () =>
    new Response("asset bytes", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
) => {
  const requests: Request[] = [];
  const env: CloudflareEnv = {
    ASSETS: {
      fetch: async (request) => {
        requests.push(request);
        return respond(request);
      },
    },
  };
  return { env, requests };
};

const ctx = () => {
  const waited: Promise<unknown>[] = [];
  return { waited, waitUntil: (p: Promise<unknown>) => void waited.push(p) };
};

const worker = (graph: SiteGraph, logged: string[] = []) =>
  createCloudflareWorker(graph, { log: (m) => logged.push(m) });

const get = (path: string, init?: RequestInit) =>
  new Request(`https://example.test${path}`, init);

describe("stripBase", () => {
  it("returns the path unchanged at the root base", () => {
    expect(stripBase("/a/b", "/")).toBe("/a/b");
  });

  it("maps the bare prefix to the site root and strips it from paths below", () => {
    expect(stripBase("/shop", "/shop/")).toBe("/");
    expect(stripBase("/shop/", "/shop/")).toBe("/");
    expect(stripBase("/shop/cart", "/shop/")).toBe("/cart");
  });

  it("misuse: a path that only shares the prefix's spelling is outside the base", () => {
    expect(stripBase("/shopping", "/shop/")).toBeNull();
    expect(stripBase("/", "/shop/")).toBeNull();
  });
});

describe("createCloudflareWorker: request guards", () => {
  it("misuse: malformed percent-encoding is a 400 that never reaches the asset layer", async () => {
    const { env, requests } = assets();
    const res = await worker(graphOf()).fetch(get("/%E0%A4%A"), env, ctx());
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Bad Request");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(requests).toEqual([]);
  });

  it("misuse: an encoded null byte, control character or traversal is a 400", async () => {
    const { env, requests } = assets();
    // (A bare %2E%2E segment is resolved by the URL parser before the Worker
    // sees it; an encoded slash beside it is not.)
    for (const path of ["/a%00b", "/a/..%2Fsecret", "/x%0Ay", "/x%09y"]) {
      const res = await worker(graphOf()).fetch(get(path), env, ctx());
      expect(res.status, path).toBe(400);
    }
    expect(requests).toEqual([]);
  });

  it("dotfiles are 404 without reaching assets; a leading /.well-known/ is served; hideDotfiles off serves dotfiles but never .bascik", async () => {
    const hidden = assets();
    const w = worker(graphOf());
    for (const path of ["/.env", "/blog/.git/config", "/.well-known/.x"]) {
      const res = await w.fetch(get(path), hidden.env, ctx());
      expect(res.status, path).toBe(404);
    }
    expect(hidden.requests).toEqual([]);
    const known = await w.fetch(
      get("/.well-known/security.txt"),
      hidden.env,
      ctx(),
    );
    expect(known.status).toBe(200);
    expect(hidden.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/.well-known/security.txt",
    ]);

    const open = assets();
    const shown = worker(graphOf({ hideDotfiles: false }));
    expect((await shown.fetch(get("/.env"), open.env, ctx())).status).toBe(200);
    for (const path of ["/.bascik/components.json", "/.BASCIK./x"]) {
      const res = await shown.fetch(get(path), open.env, ctx());
      expect(res.status, path).toBe(404);
    }
    expect(open.requests).toHaveLength(1);
  });

  it("the generated control files are 404 at the root and under a base, whatever the asset layer holds", async () => {
    const { env, requests } = assets();
    for (const [base, prefix] of [
      ["/", ""],
      ["/shop/", "/shop"],
    ] as const) {
      const w = worker(graphOf({ base }));
      for (const file of ["/_worker.js", "/_routes.json"]) {
        const res = await w.fetch(get(prefix + file), env, ctx());
        expect(res.status, prefix + file).toBe(404);
      }
    }
    expect(requests).toEqual([]);
  });

  it("under a base, a path outside it is a 404 and the bare prefix reaches the root page", async () => {
    const { env, requests } = assets();
    const w = worker(
      graphOf({
        base: "/shop/",
        pages: { "/": page("/", () => "home") },
      }),
    );
    for (const path of ["/", "/other", "/shopping"]) {
      const res = await w.fetch(get(path), env, ctx());
      expect(res.status, path).toBe(404);
    }
    expect(requests).toEqual([]);
    for (const path of ["/shop", "/shop/"]) {
      const res = await w.fetch(get(path), env, ctx());
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe("<main>home</main>");
    }
  });

  it("misuse: a missing ASSETS binding is a logged 500, never a crash or a leak of the reason to the client", async () => {
    const logged: string[] = [];
    const res = await worker(graphOf(), logged).fetch(
      get("/style.css"),
      {},
      ctx(),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    expect(logged).toEqual([
      "[bascik] ASSETS binding is missing: static requests cannot be served.",
    ]);
  });

  it("without run_worker_first, an asset response is returned as the asset layer sent it", async () => {
    const original = new Response("bytes", {
      headers: { "content-type": "text/css" },
    });
    const { env } = assets(() => original);
    const res = await worker(graphOf()).fetch(get("/style.css"), env, ctx());
    expect(res).toBe(original);
    expect(res.headers.get("x-content-type-options")).toBeNull();
  });
});

describe("createCloudflareWorker: API routes", () => {
  const route = (
    path: string,
    load: GraphApiRoute["load"],
    extra: Partial<GraphApiRoute> = {},
  ): GraphApiRoute => ({
    path,
    filePath: `src/api${path.slice(4)}.ts`,
    paramNames: [],
    isDynamic: false,
    load,
    ...extra,
  });

  it("returns a WebSocket upgrade (status 101 or a webSocket) as the handler made it", async () => {
    // Node's Response refuses 101; the Workers one takes it with a socket.
    const upgrade = new Response(null);
    Object.defineProperty(upgrade, "status", { value: 101 });
    const socketed = Object.assign(new Response(null), { webSocket: {} });
    const w = worker(
      graphOf({
        apiRoutes: [
          route("/api/live", async () => ({ GET: () => upgrade })),
          route("/api/socket", async () => ({ GET: () => socketed })),
        ],
      }),
    );
    expect(await w.fetch(get("/api/live"), {}, ctx())).toBe(upgrade);
    expect(await w.fetch(get("/api/socket"), {}, ctx())).toBe(socketed);
  });

  it("passes params, the platform (env, waitUntil) and the trusted client IP to the handler; never X-Forwarded-For", async () => {
    const seen: unknown[] = [];
    const waits = ctx();
    const env = { GREETING: "hi" };
    const w = worker(
      graphOf({
        apiRoutes: [
          route(
            "/api/users/[id]",
            async () => ({
              GET: (
                _req: Request,
                context: {
                  params: Record<string, string>;
                  remoteIp: string;
                  platform: {
                    name: string;
                    env: CloudflareEnv;
                    waitUntil: (p: Promise<unknown>) => void;
                  };
                },
              ) => {
                seen.push(context.params, context.remoteIp);
                seen.push(context.platform.name, context.platform.env);
                context.platform.waitUntil(Promise.resolve("bg"));
                return Response.json({ ok: true });
              },
            }),
            { paramNames: ["id"], isDynamic: true },
          ),
        ],
      }),
    );
    const res = await w.fetch(
      get("/api/users/42", {
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "9.9.9.9",
        },
      }),
      env,
      waits,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=/);
    expect(seen).toEqual([{ id: "42" }, "203.0.113.7", "cloudflare", env]);
    expect(waits.waited).toHaveLength(1);
  });

  it("HEAD releases the handler's streamed body, derived from GET or exported, instead of leaving it open (F088)", async () => {
    const cancels: string[] = [];
    const streamed = (label: string) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(label));
          },
          cancel: () => {
            cancels.push(label);
          },
        }),
        { headers: { "x-k": label } },
      );
    const w = worker(
      graphOf({
        apiRoutes: [
          route("/api/derived", async () => ({
            GET: () => streamed("derived"),
          })),
          route("/api/explicit", async () => ({
            GET: () => streamed("get"),
            HEAD: () => streamed("explicit"),
          })),
        ],
      }),
    );
    for (const path of ["/api/derived", "/api/explicit"]) {
      const head = await w.fetch(get(path, { method: "HEAD" }), {}, ctx());
      expect(head.status, path).toBe(200);
      expect(await head.text(), path).toBe("");
    }
    await vi.waitFor(() =>
      expect(cancels.sort()).toEqual(["derived", "explicit"]),
    );
  });

  it("HEAD derives from GET with no body; a method the module lacks is a 405 naming the allowed ones", async () => {
    const w = worker(
      graphOf({
        apiRoutes: [
          route("/api/ping", async () => ({
            GET: () => new Response("pong", { headers: { "x-k": "v" } }),
          })),
        ],
      }),
    );
    const head = await w.fetch(get("/api/ping", { method: "HEAD" }), {}, ctx());
    expect(head.status).toBe(200);
    expect(head.headers.get("x-k")).toBe("v");
    expect(await head.text()).toBe("");
    const post = await w.fetch(get("/api/ping", { method: "POST" }), {}, ctx());
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toMatch(/GET/);
    expect(post.headers.get("allow")).not.toMatch(/POST/);
  });

  it("misuse: a route module that fails to load is a 500 whose log names the route file; the client sees no detail", async () => {
    const logged: string[] = [];
    const res = await worker(
      graphOf({
        apiRoutes: [
          route("/api/broken", async () => {
            throw new Error("Cannot find module SECRET_DETAIL");
          }),
        ],
      }),
      logged,
    ).fetch(get("/api/broken"), {}, ctx());
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe("Internal Server Error");
    expect(body).not.toContain("SECRET_DETAIL");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(
      /^\[bascik\] Failed to load API route module src\/api\/broken\.ts: Error: Cannot find module SECRET_DETAIL/,
    );
  });

  it("misuse: a handler that throws is a 500 whose log carries the method, path and stack", async () => {
    const logged: string[] = [];
    const res = await worker(
      graphOf({
        apiRoutes: [
          route("/api/throws", async () => ({
            GET: () => {
              throw new Error("handler SECRET_DETAIL");
            },
          })),
        ],
      }),
      logged,
    ).fetch(get("/api/throws"), {}, ctx());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("SECRET_DETAIL");
    expect(logged.join("\n")).toMatch(
      /\[bascik\] API route handler error \(GET \/api\/throws\)\nError: handler SECRET_DETAIL/,
    );
  });

  it("misuse: an encoded separator in a catch-all capture is a 400 and the handler never runs", async () => {
    let calls = 0;
    const w = worker(
      graphOf({
        apiRoutes: [
          route(
            "/api/files/[...path]",
            async () => ({
              GET: () => {
                calls++;
                return new Response("ok");
              },
            }),
            { paramNames: ["path"], isDynamic: true },
          ),
        ],
      }),
    );
    for (const path of ["/api/files/a%2Fb", "/api/files/x/%2F"]) {
      const res = await w.fetch(get(path), {}, ctx());
      expect(res.status, path).toBe(400);
    }
    expect(calls).toBe(0);
    expect((await w.fetch(get("/api/files/a/b"), {}, ctx())).status).toBe(200);
    expect(calls).toBe(1);
  });
});

describe("createCloudflareWorker: dynamic pages", () => {
  it("misuse: a POST to a dynamic page is a 405 with Allow, and its script never runs", async () => {
    let runs = 0;
    const res = await worker(
      graphOf({
        pages: {
          "/account": page("/account", () => {
            runs++;
            return "x";
          }),
        },
      }),
    ).fetch(get("/account", { method: "POST", body: "a=1" }), {}, ctx());
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(await res.text()).toBe("Method Not Allowed");
    expect(runs).toBe(0);
  });

  it("HEAD composes like GET: same content-length, no body", async () => {
    const w = worker(
      graphOf({ pages: { "/account": page("/account", () => "héllo") } }),
    );
    const got = await w.fetch(get("/account"), {}, ctx());
    const body = new Uint8Array(await got.arrayBuffer());
    const head = await w.fetch(get("/account", { method: "HEAD" }), {}, ctx());
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(body.byteLength));
    expect(await head.text()).toBe("");
  });

  it("the authored dynamic 404 page answers 404 with its composed body", async () => {
    const res = await worker(
      graphOf({
        pages: {
          "/404": page("/404", () => "nothing here", { is404: true }),
        },
      }),
    ).fetch(get("/404"), {}, ctx());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<main>nothing here</main>");
  });

  it("sends the opt-in CSP with the page's own build hashes, and none when the policy is off", async () => {
    const policy = { directives: { "script-src": ["'self'"] } };
    const w = worker(
      graphOf({
        pages: { "/account": page("/account", () => "x") },
        contentSecurityPolicy: {
          policy,
          hashes: {
            "/account": { scripts: ["sha256-AAAA"], styles: [] },
            "/other": { scripts: ["sha256-BBBB"], styles: [] },
          },
        },
      }),
    );
    const res = await w.fetch(get("/account"), {}, ctx());
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'sha256-AAAA'");
    expect(csp).not.toContain("sha256-BBBB");
    const off = await worker(
      graphOf({ pages: { "/account": page("/account", () => "x") } }),
    ).fetch(get("/account"), {}, ctx());
    expect(off.headers.get("content-security-policy")).toBeNull();
  });

  it("misuse: a script failing before commit is the authored 500 page, logged, with no detail sent", async () => {
    const logged: string[] = [];
    const res = await worker(
      graphOf({
        custom500: "<h1>Our fault</h1>",
        pages: {
          "/account": page("/account", () => {
            throw new Error("db SECRET_DETAIL");
          }),
        },
      }),
      logged,
    ).fetch(get("/account"), {}, ctx());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("<h1>Our fault</h1>");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(logged.join("\n")).toMatch(
      /server script error at "\/account"[\s\S]*db SECRET_DETAIL/,
    );
  });

  describe("return values (prompt 158 R3-04, F060), as on Node", () => {
    it("an array is joined with no separator, nested arrays flattened and null holes empty", async () => {
      const brand = Object.freeze({
        [Symbol.for("bascik.html")]: "<li>html</li>",
      });
      const res = await worker(
        graphOf({
          pages: {
            "/list": page("/list", () => [
              ["<li>Milk frother</li>", null],
              brand,
              undefined,
              ["<li>Kettle</li>"],
            ]),
          },
        }),
      ).fetch(get("/list"), {}, ctx());
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(
        "<main><li>Milk frother</li><li>html</li><li>Kettle</li></main>",
      );
    });

    for (const policy of ["error", "warn"] as const) {
      it(`misuse: under "${policy}" an object, a Response or an async .map is an empty slot, never a 500 or [object ...], logged once per script with its owner`, async () => {
        for (const [handler, received] of [
          [
            () => ({ name: "Milk frother" }),
            "returned an object ([object Object])",
          ],
          [() => new Response("<p>x</p>"), "returned a Response"],
          [
            () => ["a"].map(async (x) => x),
            "returned an array holding a Promise at [0]",
          ],
        ] as const) {
          const logged: string[] = [];
          const scripted = page("/account", handler);
          scripted.jobs.server_script_a!.owner =
            "server script in src/pages/account.html:4";
          const w = worker(
            graphOf({
              onServerScriptError: policy,
              pages: { "/account": scripted },
            }),
            logged,
          );
          for (let i = 0; i < 3; i++) {
            const res = await w.fetch(get(`/account?i=${i}`), {}, ctx());
            expect(res.status).toBe(200);
            const body = await res.text();
            expect(body).toBe("<main></main>");
          }
          expect(logged).toHaveLength(1);
          expect(logged[0]).toMatch(
            /^\[bascik\] server script error at "\/account":\n/,
          );
          expect(logged[0]).toContain(
            `The server script in src/pages/account.html:4 ${received}`,
          );
          expect(logged[0]).toContain("The slot is empty");
        }
      });
    }

    it('misuse: a returned object whose own toString throws fails like a throw from the script: logged and empty under "warn", the 500 page under "error"', async () => {
      const handler = () => ({
        toString() {
          throw new Error("toString SECRET_DETAIL");
        },
      });
      const logged: string[] = [];
      const warned = await worker(
        graphOf({
          onServerScriptError: "warn",
          pages: { "/account": page("/account", handler) },
        }),
        logged,
      ).fetch(get("/account"), {}, ctx());
      expect(warned.status).toBe(200);
      expect(await warned.text()).toBe("<main></main>");
      expect(logged.join("\n")).toMatch(
        /server script error at "\/account"[\s\S]*toString SECRET_DETAIL/,
      );
      const failed = await worker(
        graphOf({ pages: { "/account": page("/account", handler) } }),
      ).fetch(get("/account"), {}, ctx());
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain("SECRET_DETAIL");
    });

    it('misuse: under "ignore" a refused return is an empty slot and logs nothing', async () => {
      const logged: string[] = [];
      const res = await worker(
        graphOf({
          onServerScriptError: "ignore",
          pages: { "/account": page("/account", () => Symbol("x")) },
        }),
        logged,
      ).fetch(get("/account"), {}, ctx());
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<main></main>");
      expect(logged).toEqual([]);
    });
  });

  describe("streamed pages", () => {
    const streamed = (serverHandler: unknown): GraphPage => ({
      path: "/live",
      is404: false,
      segments: [
        { kind: "static", text: "<p>" },
        { kind: "script", id: "server_script_a" },
        { kind: "static", text: "|" },
        { kind: "script", id: "stream_script_b" },
        { kind: "static", text: "</p>" },
      ],
      jobs: {
        server_script_a: job("server_script_a", serverHandler),
        stream_script_b: job("stream_script_b", () => "late", "stream"),
      },
    });

    it("commits with identity encoding and no content-length, and keeps the isolate alive until the body is done", async () => {
      const waits = ctx();
      const res = await worker(
        graphOf({ pages: { "/live": streamed(() => "early") } }),
      ).fetch(get("/live"), {}, waits);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("identity");
      expect(res.headers.get("content-length")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(waits.waited).toHaveLength(1);
      expect(await res.text()).toBe("<p>early|late</p>");
      await waits.waited[0];
    });

    it("HEAD on a streamed page is buffered: content-length and no body", async () => {
      const res = await worker(
        graphOf({ pages: { "/live": streamed(() => "early") } }),
      ).fetch(get("/live", { method: "HEAD" }), {}, ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(
        String("<p>early|late</p>".length),
      );
      expect(await res.text()).toBe("");
    });

    it("misuse: a stream script that returns a function is an empty slot after commit, logged once", async () => {
      const logged: string[] = [];
      const live = streamed(() => "early");
      live.jobs.stream_script_b = job(
        "stream_script_b",
        () => () => "never called",
        "stream",
      );
      const w = worker(graphOf({ pages: { "/live": live } }), logged);
      for (let i = 0; i < 2; i++) {
        const waits = ctx();
        const res = await w.fetch(get("/live"), {}, waits);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("<p>early|</p>");
        await Promise.all(waits.waited);
      }
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("The stream script returned a function");
    });

    it("misuse: a server script failing before the stream commits is the generic 500 page and a log line", async () => {
      const logged: string[] = [];
      const waits = ctx();
      const res = await worker(
        graphOf({
          pages: {
            "/live": streamed(() => {
              throw new Error("before commit");
            }),
          },
        }),
        logged,
      ).fetch(get("/live"), {}, waits);
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("Internal Server Error");
      expect(logged.join("\n")).toMatch(/before commit/);
      expect(waits.waited).toEqual([]);
    });
  });
});

describe("createCloudflareWorker: a static 404.html under its own URLs", () => {
  const notFound = (status = 200) =>
    assets(
      () =>
        new Response("<h1>Not here</h1>", {
          status,
          headers: { "content-type": "text/html" },
        }),
    );

  it("answers 404 with the asset's body, fetching the canonical URL without the query", async () => {
    const { env, requests } = notFound();
    const w = worker(graphOf({ staticNotFoundPage: true }));
    for (const path of ["/404", "/404.html", "/404/"]) {
      const res = await w.fetch(get(`${path}?x=1`), env, ctx());
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toBe("text/html");
      expect(await res.text(), path).toBe("<h1>Not here</h1>");
    }
    expect(requests.map((r) => [r.method, r.url])).toEqual(
      Array(3).fill(["GET", "https://example.test/404"]),
    );
  });

  it("under a base, fetches the 404 page below the base", async () => {
    const { env, requests } = notFound();
    const res = await worker(
      graphOf({ base: "/shop/", staticNotFoundPage: true }),
    ).fetch(get("/shop/404.html"), env, ctx());
    expect(res.status).toBe(404);
    expect(requests.map((r) => r.url)).toEqual([
      "https://example.test/shop/404",
    ]);
  });

  it("HEAD is a 404 with no body and a HEAD to the asset layer", async () => {
    const { env, requests } = notFound();
    const res = await worker(graphOf({ staticNotFoundPage: true })).fetch(
      get("/404", { method: "HEAD" }),
      env,
      ctx(),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(requests.map((r) => r.method)).toEqual(["HEAD"]);
  });

  it("misuse: a POST is a 405 with Allow and never reaches the asset layer", async () => {
    const { env, requests } = notFound();
    const res = await worker(graphOf({ staticNotFoundPage: true })).fetch(
      get("/404", { method: "POST" }),
      env,
      ctx(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(requests).toEqual([]);
  });

  it("misuse: when the asset layer has no 404 page, its own answer is returned unchanged", async () => {
    const { env } = notFound(404);
    const res = await worker(graphOf({ staticNotFoundPage: true })).fetch(
      get("/404"),
      env,
      ctx(),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Not here</h1>");
  });

  it("when the canonical URL misses (html_handling none), the page is fetched by its file name", async () => {
    const { env, requests } = assets((request) =>
      new URL(request.url).pathname.endsWith(".html")
        ? new Response("<h1>Not here</h1>")
        : new Response("", { status: 404 }),
    );
    const res = await worker(
      graphOf({ base: "/shop/", staticNotFoundPage: true }),
    ).fetch(get("/shop/404/"), env, ctx());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>Not here</h1>");
    expect(requests.map((r) => r.url)).toEqual([
      "https://example.test/shop/404",
      "https://example.test/shop/404.html",
    ]);
  });

  it("without staticNotFoundPage, /404 is forwarded as any other asset", async () => {
    const { env, requests } = notFound();
    const res = await worker(graphOf()).fetch(get("/404?x=1"), env, ctx());
    expect(res.status).toBe(200);
    expect(requests.map((r) => r.url)).toEqual([
      "https://example.test/404?x=1",
    ]);
  });
});

describe("createCloudflareWorker: run_worker_first sends the static files' headers", () => {
  const policy = { directives: { "style-src": ["'self'"] } };
  const workerFirst = (overrides: Partial<SiteGraph> = {}) =>
    worker(
      graphOf({
        assetHeaders: { cspRoutes: ["/", "/docs"] },
        contentSecurityPolicy: {
          policy,
          hashes: { "/docs": { scripts: [], styles: ["sha256-DOCS"] } },
        },
        ...overrides,
      }),
    );

  it("adds the security headers and HSTS over HTTPS, keeping the status and body", async () => {
    const { env } = assets(
      () => new Response("css", { status: 200, statusText: "OK" }),
    );
    const res = await workerFirst().fetch(get("/style.css"), env, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=/);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(await res.text()).toBe("css");
    const http = await workerFirst().fetch(
      new Request("http://example.test/style.css"),
      env,
      ctx(),
    );
    expect(http.headers.get("strict-transport-security")).toBeNull();
  });

  it("keeps a header the author's own _headers already set, HSTS included", async () => {
    const { env } = assets(
      () =>
        new Response("x", {
          headers: {
            "x-frame-options": "SAMEORIGIN",
            "strict-transport-security": "max-age=60",
            "content-security-policy": "default-src 'none'",
          },
        }),
    );
    const res = await workerFirst().fetch(get("/docs"), env, ctx());
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=60");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
  });

  it("sends a listed static page's CSP with its hashes, matched without the base", async () => {
    const { env } = assets();
    const res = await workerFirst({ base: "/shop/" }).fetch(
      get("/shop/docs"),
      env,
      ctx(),
    );
    expect(res.headers.get("content-security-policy")).toContain(
      "style-src 'self' 'sha256-DOCS'",
    );
    const root = await workerFirst({ base: "/shop/" }).fetch(
      get("/shop/"),
      env,
      ctx(),
    );
    expect(root.headers.get("content-security-policy")).toBe(
      "style-src 'self'",
    );
  });

  it("honours the build's security settings: a removed header stays off and HSTS off sends none", async () => {
    const { env } = assets();
    const res = await workerFirst({
      responseSecurity: {
        headers: { "x-content-type-options": "nosniff" },
        hsts: null,
        privateDynamicPages: true,
      },
    }).fetch(get("/style.css"), env, ctx());
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("a miss the asset layer answers with a 404 page carries that page's policy, under the base too", async () => {
    const notFound = (overrides: Partial<SiteGraph> = {}) =>
      workerFirst({
        assetHeaders: { cspRoutes: ["/", "/404", "/docs/404"] },
        contentSecurityPolicy: {
          policy,
          hashes: {
            "/404": { scripts: [], styles: ["sha256-NF"] },
            "/docs/404": { scripts: [], styles: ["sha256-DOCSNF"] },
          },
        },
        ...overrides,
      });
    const { env } = assets(() => new Response("lost", { status: 404 }));
    const csp = async (path: string, graph = notFound()) =>
      (await graph.fetch(get(path), env, ctx())).headers.get(
        "content-security-policy",
      );
    expect(await csp("/nope")).toBe("style-src 'self' 'sha256-NF'");
    expect(await csp("/docs/a/b")).toBe("style-src 'self' 'sha256-DOCSNF'");
    expect(await csp("/shop/docs/x", notFound({ base: "/shop/" }))).toBe(
      "style-src 'self' 'sha256-DOCSNF'",
    );
  });

  it("misuse: a 404 with no static 404 page listed, or a 200 at an unlisted URL, gets no policy", async () => {
    const { env: missEnv } = assets(() => new Response("", { status: 404 }));
    const miss = await workerFirst().fetch(get("/nope"), missEnv, ctx());
    expect(miss.headers.get("content-security-policy")).toBeNull();
    const { env: okEnv } = assets(() => new Response("x", { status: 200 }));
    const ok = await workerFirst({
      assetHeaders: { cspRoutes: ["/404"] },
    }).fetch(get("/logo.txt"), okEnv, ctx());
    expect(ok.headers.get("content-security-policy")).toBeNull();
  });

  it("applies to the static 404 page it fetches too", async () => {
    const { env } = assets(() => new Response("<h1>nf</h1>"));
    const res = await workerFirst({ staticNotFoundPage: true }).fetch(
      get("/404"),
      env,
      ctx(),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
