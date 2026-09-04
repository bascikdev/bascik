/**
 * Prompt 65 step 7: planner and streamer unit tests, independent of the HTTP
 * handler. ScriptRegistry.invoke is mocked so each job is a controllable
 * deferred keyed by a marker in its source.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, configState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  configState: {
    scripts: { timeout: 30000, onServerScriptError: "error" as "error" | "warn" | "ignore" },
    directory: { out: "dist" },
    minify: { html: false, css: false, js: false, identifiers: false },
    scoping: { scriptBlocks: true, attributes: { class: true, id: true, name: true }, deduplicateCss: true, preserve: ["code"] },
  },
}));

vi.mock("./config.js", () => ({ BascikConfig: configState }));
vi.mock("./script-registry.js", () => ({ scriptRegistry: { invoke: invokeMock, clear: vi.fn() } }));

import {
  planServerScripts,
  streamServerScripts,
  executeServerScripts,
  transformServerScriptSource,
  type ScriptSegment,
} from "./server-scripts.ts";
import { extractServerScriptsToSidecar, serverSidecarRegistry } from "./server-sidecar.ts";

const req = { path: "/x", method: "GET", headers: {}, searchParams: {} };

type D = { promise: Promise<{ ok: true; value: string }>; resolve: (v: string) => void };
const deferred = (): D => {
  let resolve!: (v: string) => void;
  const promise = new Promise<{ ok: true; value: string }>((r) => { resolve = (v) => r({ ok: true, value: v }); });
  return { promise, resolve };
};
const route = (routes: Record<string, D | { fail: Error }>) => {
  invokeMock.mockImplementation(async (spec: string) => {
    const src = decodeURIComponent(String(spec));
    for (const [marker, target] of Object.entries(routes)) {
      if (src.includes(marker)) return "fail" in target ? { ok: false, error: target.fail } : target.promise;
    }
    throw new Error("unrouted invoke");
  });
};
const makeSink = () => {
  const writes: Buffer[] = [];
  return { writes, sink: { write: vi.fn(async (b: Buffer) => { writes.push(b); }) } };
};
const tick = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  invokeMock.mockReset();
  serverSidecarRegistry.clear();
  configState.scripts.onServerScriptError = "error";
});

describe("planServerScripts", () => {
  it("yields alternating static and script segments in document order with the right modes", () => {
    const html =
      `<p>a</p><script data-bascik-server>1</script><p>b</p>` +
      `<script data-bascik-stream>2</script><p>c</p><script data-bascik-server>3</script><p>d</p>`;
    const plan = planServerScripts(html, "/p.html");
    expect(plan.segments.map((s) => (s.kind === "static" ? "static" : s.mode))).toEqual([
      "static", "server", "static", "stream", "static", "server", "static",
    ]);
    expect(plan.firstStreamIndex).toBe(3);
    const staticBytes = plan.segments.filter((s) => s.kind === "static").reduce((n, s: any) => n + s.bytes.length, 0);
    const scriptBytes = plan.segments.filter((s): s is ScriptSegment => s.kind === "script").reduce((n, s) => n + s.job.length, 0);
    expect(staticBytes + scriptBytes).toBe(Buffer.byteLength(html));
  });

  it("reports firstStreamIndex -1 for a server-only page", () => {
    expect(planServerScripts(`<script data-bascik-server>1</script>`).firstStreamIndex).toBe(-1);
  });

  it.each([
    ["server", "build"], ["server", "routes"], ["stream", "server"], ["stream", "build"], ["stream", "routes"],
  ])("throws in the planner (not the executor) for data-bascik-%s + data-bascik-%s", (a, b) => {
    expect(() => planServerScripts(`<script data-bascik-${a} data-bascik-${b}>x</script>`, "/p.html")).toThrow(
      new RegExp(`both data-bascik-${a} and data-bascik-${b}|both data-bascik-${b} and data-bascik-${a}`),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("throws for a missing sidecar id", () => {
    expect(() => planServerScripts(`<script type="text/bascik-server" data-bascik-server-id="nope"></script>`)).toThrow(/could not be resolved from sidecar/);
  });

  it("throws when a placeholder's stream marker disagrees with its sidecar entry", () => {
    serverSidecarRegistry.recordScript("p1", "return 'x';", undefined, undefined, undefined, "server");
    expect(() =>
      planServerScripts(`<script type="text/bascik-server" data-bascik-server-id="p1" data-bascik-stream></script>`),
    ).toThrow(/stale sidecar/);
  });

  it("takes the mode from the sidecar entry for a placeholder", () => {
    const html = extractServerScriptsToSidecar(
      `<script data-bascik-server>1</script><script data-bascik-stream>2</script>`, "pages/x.html",
    );
    expect(html).toMatch(/data-bascik-server-id="[^"]+" data-bascik-stream><\/script>$/);
    const entries = Object.values(serverSidecarRegistry.getAllScripts());
    expect(entries.map((e) => e.mode)).toEqual(["server", "stream"]);
    const plan = planServerScripts(html);
    expect(plan.segments.map((s) => (s.kind === "script" ? s.mode : "static"))).toEqual(["server", "stream"]);
    // Re-running extraction over placeholders is a no-op (step 0).
    expect(extractServerScriptsToSidecar(html, "pages/x.html")).toBe(html);
  });

  it("round-trips multi-byte UTF-8 static content byte-exact", async () => {
    const html = `<p>héllo 日本 🚀</p><script data-bascik-stream>/*T*/</script><p>ünïcode</p>`;
    const t = deferred();
    route({ "/*T*/": t });
    const plan = planServerScripts(html);
    const { writes, sink } = makeSink();
    const s = streamServerScripts(plan, req, 1000, undefined, sink);
    await s.ready;
    s.commit();
    t.resolve("<b>ok</b>");
    await s.done;
    expect(Buffer.concat(writes).toString("utf8")).toBe(`<p>héllo 日本 🚀</p><b>ok</b><p>ünïcode</p>`);
  });
});

describe("streamServerScripts", () => {
  const TWO = `<p>a</p><script data-bascik-stream>/*T1*/</script><p>b</p><script data-bascik-stream>/*T2*/</script><p>c</p>`;

  it("ready rejects when a server job throws under 'error' and nothing was written", async () => {
    route({ "/*S*/": { fail: new Error("boom") } });
    const { writes, sink } = makeSink();
    const s = streamServerScripts(planServerScripts(`<p>a</p><script data-bascik-server>/*S*/</script>`), req, 1000, undefined, sink);
    await expect(s.ready).rejects.toThrow(/boom/);
    expect(writes).toHaveLength(0);
    // `done` resolves quietly after a phase-one failure: the failure was
    // already reported through `ready`, and a caller that never commits must
    // not be left with an unhandled rejection.
    await expect(s.done).resolves.toBeUndefined();
  });

  it("writes in document order even when a later stream job resolves first", async () => {
    const t1 = deferred();
    const t2 = deferred();
    route({ "/*T1*/": t1, "/*T2*/": t2 });
    const { writes, sink } = makeSink();
    const s = streamServerScripts(planServerScripts(TWO), req, 1000, undefined, sink);
    await s.ready;
    s.commit();
    await tick();
    expect(Buffer.concat(writes).toString()).toBe("<p>a</p>");
    t2.resolve("<i>2</i>");
    await tick();
    await tick();
    expect(Buffer.concat(writes).toString()).toBe("<p>a</p>");
    t1.resolve("<i>1</i>");
    await s.done;
    expect(Buffer.concat(writes).toString()).toBe("<p>a</p><i>1</i><p>b</p><i>2</i><p>c</p>");
  });

  it.each(["error", "warn", "ignore"] as const)(
    "a stream job failing under '%s' after commit yields an empty slot and a complete document",
    async (policy) => {
      configState.scripts.onServerScriptError = policy;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
      try {
        const t2 = deferred();
        route({ "/*T1*/": { fail: new Error("kaput") }, "/*T2*/": t2 });
        const { writes, sink } = makeSink();
        const s = streamServerScripts(planServerScripts(TWO), req, 1000, undefined, sink);
        await s.ready;
        s.commit();
        t2.resolve("<i>2</i>");
        await s.done;
        expect(Buffer.concat(writes).toString()).toBe("<p>a</p><p>b</p><i>2</i><p>c</p>");
        if (policy === "error") expect(errorSpy).toHaveBeenCalled();
        if (policy === "warn") expect(warnSpy).toHaveBeenCalled();
        if (policy === "ignore") {
          expect(errorSpy).not.toHaveBeenCalled();
          expect(warnSpy).not.toHaveBeenCalled();
        }
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    },
  );

  it("stops writing after the signal aborts and never calls the sink again", async () => {
    const t1 = deferred();
    const t2 = deferred();
    route({ "/*T1*/": t1, "/*T2*/": t2 });
    const { sink } = makeSink();
    const abort = new AbortController();
    const s = streamServerScripts(planServerScripts(TWO), req, 1000, undefined, sink, abort.signal);
    await s.ready;
    s.commit();
    await tick();
    const callsBefore = sink.write.mock.calls.length;
    abort.abort();
    t1.resolve("<i>1</i>");
    t2.resolve("<i>2</i>");
    await s.done;
    expect(sink.write.mock.calls.length).toBe(callsBefore);
  });
});

describe("stream scripts share the server-script machinery", () => {
  it("executeServerScripts still treats a stream script as a script (same output)", async () => {
    const t = deferred();
    route({ "/*T*/": t });
    t.resolve("<b>x</b>");
    expect(await executeServerScripts(`<p>a</p><script data-bascik-stream>/*T*/</script>`, req)).toBe("<p>a</p><b>x</b>");
  });

  it("class names inside a component's stream-script source are scoped like server-script source", async () => {
    const { prefixElementAttribute } = await import("./javascript.ts");
    const make = (directive: string) => ({
      name: "swap-card",
      fileContent: `<div class="card"><script data-bascik-${directive}>return '<h2 class="result">x</h2>';</script></div>`,
      cssFileContent: ".card{} .result{}",
    }) as any;
    const server = prefixElementAttribute(make("server"), "class", "abc", true).fileContent as string;
    const stream = prefixElementAttribute(make("stream"), "class", "abc", true).fileContent as string;
    expect(stream).toContain(`class="bascik__swap-card__result"`);
    expect(stream.replace("data-bascik-stream", "data-bascik-server")).toBe(server);
  });

  it("transformServerScriptSource is directive-agnostic (same source, same module)", () => {
    const src = "return `<p>${escapeHtml(req.path)}</p>`;";
    expect(transformServerScriptSource(src)).toBe(transformServerScriptSource(src));
    expect(transformServerScriptSource(src)).toContain("const escapeHtml");
  });
});
