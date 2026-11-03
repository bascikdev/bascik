// Tests for the Netlify Functions runtime that serves server and stream
// scripts. Build-time adapter tests live in build.test.ts.

import { describe, expect, it, vi } from "vitest";
import {
  createNetlifyHandler,
  findPage,
  type DiagnosticLogEntry,
  type SiteGraph,
  type GraphPage,
} from "./runtime.js";

const job = (
  id: string,
  mode: "server" | "stream",
  fn: (req: Request) => unknown,
) => ({
  id,
  mode,
  load: async () => ({ default: (req: Request) => fn(req) }),
});

function page(overrides: Partial<GraphPage> = {}): GraphPage {
  return {
    path: "/dashboard",
    is404: false,
    segments: [
      { kind: "static", text: "<p>" },
      { kind: "script", id: "s1" },
      { kind: "static", text: "</p>" },
    ],
    jobs: {
      s1: job(
        "s1",
        "server",
        (req) => `hi ${new URL(req.url).searchParams.get("n") ?? ""}`,
      ),
    },
    ...overrides,
  };
}

function graph(
  p: GraphPage = page(),
  extra: Partial<SiteGraph> = {},
): SiteGraph {
  return {
    scriptTimeoutMs: 1000,
    onServerScriptError: "warn",
    pages: { [p.path]: p },
    ...extra,
  };
}

const get = (path: string, init: RequestInit = {}) =>
  new Request(`https://example.com${path}`, init);

describe("createNetlifyHandler", () => {
  it("logs entry before loading scripts and correlates lazy import stacks without logging credentials", async () => {
    const events: DiagnosticLogEntry[] = [];
    const errors: string[] = [];
    const failure = new Error("module import failed");
    const p = page({
      jobs: {
        s1: {
          id: "s1",
          mode: "server",
          load: async () => {
            expect(events.map((entry) => entry.event)).toEqual([
              "request.start",
              "script.start",
            ]);
            throw failure;
          },
        },
      },
    });
    const handler = createNetlifyHandler(
      graph(p, { onServerScriptError: "error" }),
      {
        logEvent: (entry) => events.push(entry),
        log: (message) => errors.push(message),
      },
    );
    const response = await handler(
      get("/dashboard?session_id=private-query", {
        headers: {
          "x-nf-request-id": "req-failure",
          cookie: "nf_jwt=private-token",
        },
      }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("x-bascik-handler")).toBe("bascik-pages");
    expect(
      errors.some(
        (line) =>
          line.includes("req-failure") &&
          line.includes("s1") &&
          line.includes("module import failed"),
      ),
    ).toBe(true);
    expect(errors.join("\n")).toContain("Error: module import failed");
    expect(errors.join("\n")).toContain("runtime.test.ts");
    expect(JSON.stringify({ events, errors })).not.toContain("private-token");
    expect(JSON.stringify({ events, errors })).not.toContain("private-query");
    expect(await response.text()).not.toContain("module import failed");
  });

  it("catches and logs failures in response setup outside script execution", async () => {
    const events: DiagnosticLogEntry[] = [];
    const errors: string[] = [];
    const broken = {
      ...graph(),
      pages: new Proxy(
        {},
        {
          get() {
            throw new TypeError("graph broken");
          },
        },
      ),
    } as SiteGraph;
    const response = await createNetlifyHandler(broken, {
      logEvent: (entry) => events.push(entry),
      log: (line) => errors.push(line),
    })(get("/dashboard", { headers: { "x-nf-request-id": "req-setup" } }));
    expect(response.status).toBe(500);
    expect(events[0]?.event).toBe("request.start");
    const entry = JSON.parse(errors[0]!);
    expect(entry.event).toBe("request.error");
    expect(entry.requestId).toBe("req-setup");
    expect(entry.stack).toContain("TypeError: graph broken");
    expect(response.headers.get("x-bascik-handler")).toBe("bascik-pages");
  });

  it("reports a segment whose job is missing from the graph", async () => {
    const errors: string[] = [];
    const response = await createNetlifyHandler(
      graph(page({ jobs: {} }), { onServerScriptError: "error" }),
      { log: (line) => errors.push(line), logEvent: () => {} },
    )(get("/dashboard"));
    expect(response.status).toBe(500);
    expect(errors.join("\n")).toContain("missing from the deployment graph");
  });

  it("logs stream exceptions with a stack and request ID after the shell is ready", async () => {
    const errors: string[] = [];
    const p = page({
      segments: [
        { kind: "static", text: "<h1>Account</h1>" },
        { kind: "script", id: "billing" },
      ],
      jobs: {
        billing: job("billing", "stream", () => {
          throw new Error("invoice stream failed");
        }),
      },
    });
    let finished: Promise<unknown> = Promise.resolve();
    const response = await createNetlifyHandler(
      graph(p, { onServerScriptError: "error" }),
      {
        log: (line) => errors.push(line),
      },
    )(get("/dashboard", { headers: { "x-nf-request-id": "req-stream" } }), {
      waitUntil: (promise) => {
        finished = promise;
      },
    });
    expect(await response.text()).toContain("<h1>Account</h1>");
    await finished;
    expect(
      errors.some((line) => {
        const entry = JSON.parse(line);
        return (
          entry.event === "script.error" &&
          entry.scriptId === "billing" &&
          entry.requestId === "req-stream" &&
          entry.stack.includes("invoice stream failed")
        );
      }),
    ).toBe(true);
    expect(response.headers.get("x-bascik-handler")).toBe("bascik-pages");
  });

  it("finds pages by clean, .html and trailing-slash URLs", () => {
    const g = graph();
    expect(findPage(g, "/dashboard")).toBeDefined();
    expect(findPage(g, "/dashboard.html")).toBeDefined();
    expect(findPage(g, "/dashboard/")).toBeDefined();
    expect(findPage(g, "/other")).toBeUndefined();
  });

  it("renders server-script output with private, no-store headers", async () => {
    const res = await createNetlifyHandler(graph())(get("/dashboard?n=ann"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>hi ann</p>");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("streams pages with stream scripts", async () => {
    const p = page({
      segments: [
        { kind: "static", text: "a" },
        { kind: "script", id: "s1" },
        { kind: "static", text: "b" },
        { kind: "script", id: "s2" },
      ],
      jobs: {
        s1: job("s1", "server", () => "1"),
        s2: job("s2", "stream", async () => "2"),
      },
    });
    const waitUntil = vi.fn((_p: Promise<unknown>) => {});
    const res = await createNetlifyHandler(graph(p))(get("/dashboard"), {
      waitUntil,
    });
    expect(await res.text()).toBe("a1b2");
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("answers HEAD without a body and rejects other methods", async () => {
    const handler = createNetlifyHandler(graph());
    const head = await handler(get("/dashboard", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const postRes = await handler(get("/dashboard", { method: "POST" }));
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns 404 for unknown paths and 400 for malformed ones", async () => {
    const entries: { status: number }[] = [];
    const handler = createNetlifyHandler(graph(), {
      logRequest: (entry) => entries.push(entry),
    });
    expect((await handler(get("/nope"))).status).toBe(404);
    expect((await handler(get("/%E0%A4%A"))).status).toBe(400);
    expect((await handler(get("/dashboard", { method: "POST" }))).status).toBe(
      405,
    );
    expect(entries.map(({ status }) => status)).toEqual([404, 400, 405]);
  });

  it('logs and blanks a failing script when onServerScriptError is "warn"', async () => {
    const log = vi.fn((_m: string) => {});
    const p = page({
      jobs: {
        s1: job("s1", "server", () => {
          throw new Error("kaboom");
        }),
      },
    });
    const res = await createNetlifyHandler(graph(p), { log })(
      get("/dashboard"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p></p>");
    expect(log.mock.calls[0]![0]).toContain("kaboom");
  });

  it('returns a 500 page when onServerScriptError is "error"', async () => {
    const log = vi.fn((_m: string) => {});
    const p = page({
      jobs: {
        s1: job("s1", "server", () => {
          throw new Error("kaboom");
        }),
      },
    });
    const res = await createNetlifyHandler(
      graph(p, { onServerScriptError: "error" }),
      { log },
    )(get("/dashboard"));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("kaboom");
  });

  it("logs one line per request with cookie sizes but never cookie values", async () => {
    const entries: unknown[] = [];
    const handler = createNetlifyHandler(graph(), {
      logRequest: (e) => entries.push(e),
    });
    await handler(
      get("/dashboard", {
        headers: {
          cookie: "nf_jwt=secret-token; theme=dark",
          "x-nf-request-id": "req-1",
        },
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      fn: "bascik-pages",
      requestId: "req-1",
      method: "GET",
      path: "/dashboard",
      status: 200,
      mode: "buffered",
      cookies: { nf_jwt: 12, theme: 4 },
    });
    expect(JSON.stringify(entries[0])).not.toContain("secret-token");
  });

  it("logs streamed requests when the stream finishes, and failures with their message", async () => {
    const entries: { status: number; mode: string; error?: string }[] = [];
    const logRequest = (e: (typeof entries)[number]) => entries.push(e);
    const p = page({
      segments: [
        { kind: "script", id: "s1" },
        { kind: "script", id: "s2" },
      ],
      jobs: {
        s1: job("s1", "server", () => "1"),
        s2: job("s2", "stream", async () => "2"),
      },
    });
    let finished: Promise<unknown> = Promise.resolve();
    const res = await createNetlifyHandler(graph(p), { logRequest })(
      get("/dashboard"),
      {
        waitUntil: (pr) => {
          finished = pr;
        },
      },
    );
    await res.text();
    await finished;
    expect(entries).toMatchObject([{ status: 200, mode: "stream" }]);

    const failing = page({
      jobs: {
        s1: job("s1", "server", () => {
          throw new Error("kaboom");
        }),
      },
    });
    await createNetlifyHandler(
      graph(failing, { onServerScriptError: "error" }),
      { log: () => {}, logRequest },
    )(get("/dashboard"));
    expect(entries[1]).toMatchObject({ status: 500, mode: "buffered" });
    expect(entries[1]!.error).toContain("kaboom");
  });
});
