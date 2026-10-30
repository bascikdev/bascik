/**
 * The `security` toggles and `scripts.stripAnsi` in the Worker, in process
 * (no workerd): the graph carries what the build resolved
 * (`responseSecurity`, `hideDotfiles`, `stripAnsi`), and a graph without
 * them behaves exactly as today. HSTS needs an https request URL, which a
 * direct `fetch` call gives without a TLS listener. The same settings are
 * compared with `bascik --server` in serverless-parity.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  createCloudflareWorker,
  createGraphJobRunner,
  type GraphPage,
  type GraphScriptJob,
  type SiteGraph,
} from "./runtime.ts";

const ctx = { waitUntil: () => {} };
const DEFAULT_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "cross-origin-resource-policy": "cross-origin",
};

const job = (id: string, handler: unknown): GraphScriptJob => ({
  id,
  mode: "server",
  load: async () => ({ default: handler }),
});

const page = (handler: unknown = () => "<p>hi</p>"): GraphPage => ({
  path: "/dyn",
  is404: false,
  segments: [
    { kind: "static", text: "<main>" },
    { kind: "script", id: "page_job" },
    { kind: "static", text: "</main>" },
  ],
  jobs: { page_job: job("page_job", handler) },
});

const graph = (extra: Record<string, unknown> = {}): SiteGraph =>
  ({
    base: "/",
    scriptTimeoutMs: 1000,
    apiTimeoutMs: 1000,
    onServerScriptError: "error",
    pages: { "/dyn": page() },
    apiRoutes: [
      {
        path: "/api/hello",
        filePath: "src/api/hello.ts",
        paramNames: [],
        isDynamic: false,
        load: async () => ({
          GET: () => new Response("hi", { headers: { "x-own": "1" } }),
        }),
      },
    ],
    release: "test",
    ...extra,
  }) as SiteGraph;

const assets = {
  ASSETS: {
    fetch: async (request: Request) =>
      new Response(`asset ${new URL(request.url).pathname}`, { status: 200 }),
  },
};

const get = (g: SiteGraph, url: string) =>
  createCloudflareWorker(g, { log: () => {} }).fetch(
    new Request(url),
    assets,
    ctx,
  );

const responseSecurity = (
  headers: Record<string, string>,
  hsts: string | null,
  privateDynamicPages = true,
) => ({ headers, hsts, privateDynamicPages });

describe("a graph without the new fields is today's Worker, with the new HSTS default", () => {
  it("a dynamic page over https gets the five headers, private no-store and one-year HSTS without includeSubDomains", async () => {
    const res = await get(graph(), "https://example.test/dyn");
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(DEFAULT_HEADERS))
      expect(res.headers.get(name), name).toBe(value);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
  });

  it("over http no HSTS is sent", async () => {
    const res = await get(graph(), "http://example.test/dyn");
    expect(res.headers.has("strict-transport-security")).toBe(false);
  });

  it("a dotfile is a 404 and never reaches assets", async () => {
    const res = await get(graph(), "https://example.test/.nojekyll");
    expect(res.status).toBe(404);
  });
});

describe("graph.responseSecurity", () => {
  it("an override and a removal apply to dynamic pages, API responses and errors", async () => {
    const { "x-content-type-options": _gone, ...rest } = DEFAULT_HEADERS;
    const g = graph({
      responseSecurity: responseSecurity(
        { ...rest, "x-frame-options": "DENY" },
        "max-age=31536000",
      ),
    });
    for (const path of ["/dyn", "/api/hello", "/.env"]) {
      const res = await get(g, `https://example.test${path}`);
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.has("x-content-type-options"), path).toBe(false);
    }
  });

  it("an API handler's own header still wins", async () => {
    const res = await get(
      graph({
        responseSecurity: responseSecurity(DEFAULT_HEADERS, null),
        apiRoutes: [
          {
            path: "/api/frame",
            filePath: "src/api/frame.ts",
            paramNames: [],
            isDynamic: false,
            load: async () => ({
              GET: () =>
                new Response("x", {
                  headers: { "x-frame-options": "ALLOWALL" },
                }),
            }),
          },
        ],
      }),
      "https://example.test/api/frame",
    );
    expect(res.headers.get("x-frame-options")).toBe("ALLOWALL");
  });

  it("hsts null sends no HSTS over https; a custom string is sent as is", async () => {
    const off = await get(
      graph({ responseSecurity: responseSecurity(DEFAULT_HEADERS, null) }),
      "https://example.test/dyn",
    );
    expect(off.headers.has("strict-transport-security")).toBe(false);
    const on = await get(
      graph({
        responseSecurity: responseSecurity(
          DEFAULT_HEADERS,
          "max-age=63072000; includeSubDomains; preload",
        ),
      }),
      "https://example.test/dyn",
    );
    expect(on.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("privateDynamicPages false leaves cache-control off a dynamic page; errors keep no-store", async () => {
    const g = graph({
      responseSecurity: responseSecurity(DEFAULT_HEADERS, null, false),
    });
    const dyn = await get(g, "https://example.test/dyn");
    expect(dyn.headers.get("cache-control")).not.toBe("private, no-store");
    const notFound = await get(g, "https://example.test/.env");
    expect(notFound.headers.get("cache-control")).toBe("private, no-store");
  });

  it("the 500 page follows the configured headers", async () => {
    const res = await get(
      graph({
        responseSecurity: responseSecurity({}, null),
        pages: {
          "/dyn": page(() => {
            throw new Error("boom");
          }),
        },
      }),
      "https://example.test/dyn",
    );
    expect(res.status).toBe(500);
    expect(res.headers.has("x-frame-options")).toBe(false);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("graph.hideDotfiles", () => {
  it("false: /.nojekyll is forwarded to assets", async () => {
    const res = await get(
      graph({ hideDotfiles: false }),
      "https://example.test/.nojekyll",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset /.nojekyll");
  });

  it("false: /.bascik/ stays private", async () => {
    const res = await get(
      graph({ hideDotfiles: false }),
      "https://example.test/.bascik/components.json",
    );
    expect(res.status).toBe(404);
  });

  it.each(["/a/%2e%2e%2fb", "/a%00b", "/a%2f..%2f..%2fetc"])(
    "false: an unsafe path (%s) is still 400",
    async (path) => {
      const g = graph({ hideDotfiles: false });
      const before = await get(graph(), `https://example.test${path}`);
      const res = await get(g, `https://example.test${path}`);
      expect(res.status).toBe(before.status);
      expect(res.status).toBe(400);
    },
  );
});

describe("graph.stripAnsi", () => {
  const runner = (g: SiteGraph, p: GraphPage) =>
    createGraphJobRunner(
      p,
      g,
      new Request("https://example.test/dyn"),
      {
        remoteIp: "",
        platform: { name: "cloudflare", env: {}, waitUntil: () => {} },
      },
      () => {},
    );
  const ansiPage = page(() => "\u001b[31mred\u001b[0m");

  it("absent or true strips ANSI codes", async () => {
    const signal = new AbortController().signal;
    await expect(runner(graph(), ansiPage)("page_job", signal)).resolves.toBe(
      "red",
    );
    await expect(
      runner(graph({ stripAnsi: true }), ansiPage)("page_job", signal),
    ).resolves.toBe("red");
  });

  it("false keeps them", async () => {
    await expect(
      runner(graph({ stripAnsi: false }), ansiPage)(
        "page_job",
        new AbortController().signal,
      ),
    ).resolves.toBe("\u001b[31mred\u001b[0m");
  });
});
