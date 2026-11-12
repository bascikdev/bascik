/**
 * A server or stream script that yields, on the Node host.
 *
 * Real scripts run through the real ScriptRegistry (inline `data:` modules):
 * a `data-bascik-stream` script written as a generator has each yielded
 * value written to the sink as it is produced; everywhere else (a
 * `data-bascik-server` script, a buffered response) the values are joined.
 * The scheduler itself is covered in `request-execution-chunks.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  executeServerScripts,
  planServerScripts,
  streamServerScripts,
} from "./server-scripts.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { scriptRegistry } from "./script-registry.ts";
import { BascikConfig } from "./config.ts";

vi.mock("./config.js", () => ({
  BascikConfig: {
    scripts: { onServerScriptError: "error", timeout: 30000 },
    directory: { out: "dist" },
  },
}));

const baseContext = { remoteIp: "127.0.0.1" };
const FILE = "src/pages/orders.html";

type Policy = "error" | "warn" | "ignore";
const configure = (
  onServerScriptError: Policy,
  extra: Record<string, unknown> = {},
) => {
  const config = BascikConfig as unknown as Record<string, unknown>;
  config.scripts = { onServerScriptError, timeout: 30000, ...extra };
  config.isProdServer = false;
  config.isBuild = false;
};

/** What a script leaves for the test to read: flags it sets on its way out. */
const probe = (): Record<string, unknown> => {
  const store = globalThis as unknown as {
    __bascikChunkProbe?: Record<string, unknown>;
  };
  return (store.__bascikChunkProbe ??= {});
};

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  serverSidecarRegistry.clear();
  scriptRegistry.clear();
  configure("error");
  for (const key of Object.keys(probe())) delete probe()[key];
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

const page = (body: string, directive = "data-bascik-stream") =>
  `<ul><script ${directive}>\n${body}\n</script></ul><footer>foot</footer>`;

/** Stream a page and record every sink write as its own string. */
const stream = async (
  html: string,
  options: { timeoutMs?: number; signal?: AbortSignal; url?: string } = {},
) => {
  const writes: string[] = [];
  const streamer = streamServerScripts(
    planServerScripts(html, FILE),
    new Request(options.url ?? "http://localhost/orders"),
    baseContext,
    options.timeoutMs ?? 30000,
    FILE,
    {
      write: async (chunk) => {
        writes.push(Buffer.from(chunk).toString("utf8"));
      },
    },
    options.signal,
  );
  await streamer.ready;
  streamer.commit();
  return { writes, done: streamer.done };
};

const until = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe("data-bascik-stream: a script that yields", () => {
  it("writes each yielded value as its own chunk, in order, where the script tag was", async () => {
    const { writes, done } = await stream(
      page(`export default async function* () {
        for (const title of ["Dune", "Emma", "Ulysses"]) {
          await new Promise((r) => setTimeout(r, 1));
          yield "<li>" + title + "</li>";
        }
      }`),
    );
    await done;
    expect(writes).toEqual([
      "<ul>",
      "<li>Dune</li>",
      "<li>Emma</li>",
      "<li>Ulysses</li>",
      "</ul><footer>foot</footer>",
    ]);
  });

  it("sends a chunk before the script has produced the next one", async () => {
    const { writes, done } = await stream(
      page(`export default async function* () {
        const probe = globalThis.__bascikChunkProbe;
        yield "<li>first</li>";
        await new Promise((resolve) => { probe.release = resolve; });
        yield "<li>second</li>";
      }`),
    );
    await until(() => typeof probe().release === "function", "second pull");
    expect(writes).toEqual(["<ul>", "<li>first</li>"]);
    (probe().release as () => void)();
    await done;
    expect(writes).toEqual([
      "<ul>",
      "<li>first</li>",
      "<li>second</li>",
      "</ul><footer>foot</footer>",
    ]);
  });

  it("prints each yielded value by the rules for a returned one: html values, arrays, numbers; null, undefined and false print nothing", async () => {
    const { writes, done } = await stream(
      page(`const HTML = Symbol.for("bascik.html");
      export default async function* () {
        yield { [HTML]: "<li>branded</li>" };
        yield ["<li>a</li>", ["<li>b</li>"]];
        yield null;
        yield undefined;
        yield false;
        yield 42;
      }`),
    );
    await done;
    expect(writes).toEqual([
      "<ul>",
      "<li>branded</li>",
      "<li>a</li><li>b</li>",
      "42",
      "</ul><footer>foot</footer>",
    ]);
  });

  it("a sync generator is written chunk by chunk too", async () => {
    const { writes, done } = await stream(
      page(`export default function* () {
        yield "<li>1</li>";
        yield "<li>2</li>";
      }`),
    );
    await done;
    expect(writes).toEqual([
      "<ul>",
      "<li>1</li>",
      "<li>2</li>",
      "</ul><footer>foot</footer>",
    ]);
  });

  it("an async function that returns an async iterable is treated the same way", async () => {
    const { writes, done } = await stream(
      page(`async function* rows() { yield "<li>x</li>"; yield "<li>y</li>"; }
      export default async () => rows();`),
    );
    await done;
    expect(writes.slice(1, -1)).toEqual(["<li>x</li>", "<li>y</li>"]);
  });

  it("the script receives the request, the context and a signal, as a script that returns does", async () => {
    const { writes, done } = await stream(
      page(`export default async function* (request, context, { signal }) {
        yield "<li>" + new URL(request.url).searchParams.get("q") + "</li>";
        yield "<li>" + context.remoteIp + "</li>";
        yield "<li>" + (signal instanceof AbortSignal) + "</li>";
      }`),
      { url: "http://localhost/orders?q=books" },
    );
    await done;
    expect(writes.slice(1, -1)).toEqual([
      "<li>books</li>",
      "<li>127.0.0.1</li>",
      "<li>true</li>",
    ]);
  });

  it("strips terminal color codes from each chunk unless scripts.stripAnsi is off", async () => {
    const body = `export default async function* () { yield "<li>\\u001b[31mred\\u001b[0m</li>"; }`;
    const stripped = await stream(page(body));
    await stripped.done;
    expect(stripped.writes[1]).toBe("<li>red</li>");

    configure("error", { stripAnsi: false });
    const kept = await stream(page(body));
    await kept.done;
    expect(kept.writes[1]).toBe("<li>\u001b[31mred\u001b[0m</li>");
  });

  it("a generator that yields nothing leaves an empty slot and reports nothing", async () => {
    const { writes, done } = await stream(
      page(`export default async function* () {}`),
    );
    await done;
    expect(writes).toEqual(["<ul>", "</ul><footer>foot</footer>"]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("data-bascik-stream: a script that fails while yielding", () => {
  const failing = page(`export default async function* () {
    yield "<li>one</li>";
    yield "<li>two</li>";
    throw new Error("row three failed");
  }`);

  it('under "error": the rows already sent stay, the failure is logged once at error severity with the file, and the page completes', async () => {
    const { writes, done } = await stream(failing);
    await done;
    expect(writes).toEqual([
      "<ul>",
      "<li>one</li>",
      "<li>two</li>",
      "</ul><footer>foot</footer>",
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]![0]);
    expect(message).toContain('[bascik] server script error at "/orders"');
    expect(message).toContain("row three failed");
    expect(message).toContain(`${FILE}:`);
  });

  it('under "warn": the same page, logged as a warning', async () => {
    configure("warn");
    const { writes, done } = await stream(failing);
    await done;
    expect(writes.slice(1, -1)).toEqual(["<li>one</li>", "<li>two</li>"]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain("row three failed");
  });

  it('under "ignore": the same page, and nothing is logged', async () => {
    configure("ignore");
    const { writes, done } = await stream(failing);
    await done;
    expect(writes.slice(1, -1)).toEqual(["<li>one</li>", "<li>two</li>"]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a failure before the first yield leaves an empty slot, like a script that throws", async () => {
    const { writes, done } = await stream(
      page(`export default async function* () {
        throw new Error("no rows at all");
      }`),
    );
    await done;
    expect(writes).toEqual(["<ul>", "</ul><footer>foot</footer>"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("the script timeout ends a generator that stops producing: the rows sent stay and the timeout is reported with where the script starts", async () => {
    const { writes, done } = await stream(
      page(`export default async function* (request, context, { signal }) {
        const probe = globalThis.__bascikChunkProbe;
        signal.addEventListener("abort", () => { probe.signalAborted = true; });
        try {
          yield "<li>one</li>";
          await new Promise(() => {});
          yield "<li>never</li>";
        } finally {
          probe.finallyRan = true;
        }
      }`),
      { timeoutMs: 40 },
    );
    await done;
    expect(writes).toEqual([
      "<ul>",
      "<li>one</li>",
      "</ul><footer>foot</footer>",
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]![0]);
    expect(message).toContain("Script execution timed out after 40ms");
    expect(message).toContain(`in the script that starts at ${FILE}:`);
    expect(probe().signalAborted).toBe(true);
  });

  it("the timeout counts the script's own time, not the time the client takes to accept a chunk", async () => {
    const writes: string[] = [];
    const streamer = streamServerScripts(
      planServerScripts(
        page(`export default async function* () {
          for (let i = 1; i <= 4; i++) yield "<li>" + i + "</li>";
        }`),
        FILE,
      ),
      new Request("http://localhost/orders"),
      baseContext,
      60,
      FILE,
      {
        // A slow client: every write takes longer than a third of the budget.
        write: async (chunk) => {
          writes.push(Buffer.from(chunk).toString("utf8"));
          await new Promise((r) => setTimeout(r, 30));
        },
      },
    );
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(writes.join("")).toBe(
      "<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul><footer>foot</footer>",
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("data-bascik-stream: a yielded value that is not markup", () => {
  const yieldsObject = page(`export default async function* () {
    yield "<li>one</li>";
    yield { title: "Dune" };
    yield "<li>three</li>";
  }`);

  it('in development under "error": the stream stops there and the message says what was yielded and where', async () => {
    const { writes, done } = await stream(yieldsObject);
    await done;
    expect(writes).toEqual([
      "<ul>",
      "<li>one</li>",
      "</ul><footer>foot</footer>",
    ]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]![0]);
    expect(message).toMatch(
      /The stream script in src\/pages\/orders\.html:\d+ yielded an object \(\[object Object\]\), which is not markup/,
    );
  });

  it("in production: that value is skipped, the rest is sent, and the warning is logged once per script", async () => {
    (BascikConfig as unknown as Record<string, unknown>).isProdServer = true;
    const first = await stream(yieldsObject);
    await first.done;
    expect(first.writes.slice(1, -1)).toEqual([
      "<li>one</li>",
      "<li>three</li>",
    ]);
    const second = await stream(yieldsObject);
    await second.done;
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain("yielded an object");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("misuse: yielding the bytes of a fetched body is refused with the decode fix, never printed as numbers", async () => {
    const { writes, done } = await stream(
      page(`export default async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<li>bytes</li>"));
            controller.close();
          },
        });`),
    );
    await done;
    expect(writes).toEqual(["<ul>", "</ul><footer>foot</footer>"]);
    const message = String(errorSpy.mock.calls[0]![0]);
    expect(message).toContain("yielded bytes (Uint8Array)");
    expect(message).toContain("new TextDecoder().decode(bytes");
  });

  it("any async iterable of text is sent value by value", async () => {
    const { writes, done } = await stream(
      page(`export default async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue("<li>one</li>");
            controller.enqueue("<li>two</li>");
            controller.close();
          },
        });`),
    );
    await done;
    expect(writes).toEqual([
      "<ul>",
      "<li>one</li>",
      "<li>two</li>",
      "</ul><footer>foot</footer>",
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a value the generator returns is sent as its last chunk", async () => {
    const { writes, done } = await stream(
      page(`export default async function* (request) {
        const rows = new URL(request.url).searchParams.get("empty") ? [] : ["<li>one</li>"];
        if (rows.length === 0) return "<li>No orders yet</li>";
        yield* rows;
        return "<li>end</li>";
      }`),
    );
    await done;
    expect(writes.slice(1, -1)).toEqual(["<li>one</li>", "<li>end</li>"]);

    const empty = await stream(
      page(`export default async function* (request) {
        const rows = new URL(request.url).searchParams.get("empty") ? [] : ["<li>one</li>"];
        if (rows.length === 0) return "<li>No orders yet</li>";
        yield* rows;
      }`),
      { url: "http://localhost/orders?empty=1" },
    );
    await empty.done;
    expect(empty.writes.slice(1, -1)).toEqual(["<li>No orders yet</li>"]);
  });

  it("misuse: yielding a generator instead of delegating to it is refused with the yield* fix", async () => {
    const { writes, done } = await stream(
      page(`async function* rows() { yield "<li>x</li>"; }
      export default async function* () { yield rows(); }`),
    );
    await done;
    expect(writes).toEqual(["<ul>", "</ul><footer>foot</footer>"]);
    const message = String(errorSpy.mock.calls[0]![0]);
    expect(message).toContain("yielded a generator");
    expect(message).toContain("yield*");
  });

  it("misuse: a script that returns an array holding a generator is told to yield from one generator", async () => {
    const { done } = await stream(
      page(`async function* rows() { yield "<li>x</li>"; }
      export default async () => [rows()];`),
    );
    await done;
    const message = String(errorSpy.mock.calls[0]![0]);
    expect(message).toContain("returned an array holding a generator at [0]");
  });
});

describe("data-bascik-stream: the client goes away while a script yields", () => {
  it("aborts the script's signal, runs its finally block, writes nothing more and reports nothing", async () => {
    const abort = new AbortController();
    const { writes, done } = await stream(
      page(`export default async function* (request, context, { signal }) {
        const probe = globalThis.__bascikChunkProbe;
        try {
          yield "<li>one</li>";
          await new Promise((resolve, reject) => {
            probe.waiting = true;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          yield "<li>never</li>";
        } finally {
          probe.finallyRan = true;
        }
      }`),
      { signal: abort.signal },
    );
    await until(() => probe().waiting === true, "script waiting");
    abort.abort(new Error("client went away"));
    await done;
    await until(() => probe().finallyRan === true, "finally block");
    expect(writes).toEqual(["<ul>", "<li>one</li>"]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("a script that yields where nothing is streamed", () => {
  it("data-bascik-server: the yielded values are joined into the page", async () => {
    const result = await executeServerScripts(
      page(
        `export default async function* () {
          yield "<li>1</li>";
          yield ["<li>2</li>", "<li>3</li>"];
        }`,
        "data-bascik-server",
      ),
      new Request("http://localhost/orders"),
      baseContext,
      30000,
      FILE,
    );
    expect(result).toBe(
      "<ul><li>1</li><li>2</li><li>3</li></ul><footer>foot</footer>",
    );
  });

  it('data-bascik-server under "error": a failure while yielding rejects, so the page can be a 500 and no partial markup is sent', async () => {
    await expect(
      executeServerScripts(
        page(
          `export default async function* () {
            yield "<li>1</li>";
            throw new Error("server row failed");
          }`,
          "data-bascik-server",
        ),
        new Request("http://localhost/orders"),
        baseContext,
        30000,
        FILE,
      ),
    ).rejects.toThrow(/server row failed/);
  });

  it('data-bascik-server under "warn": the rows before the failure are kept, as for a stream script', async () => {
    configure("warn");
    const result = await executeServerScripts(
      page(
        `export default async function* () {
          yield "<li>1</li>";
          throw new Error("server row failed");
        }`,
        "data-bascik-server",
      ),
      new Request("http://localhost/orders"),
      baseContext,
      30000,
      FILE,
    );
    expect(result).toBe("<ul><li>1</li></ul><footer>foot</footer>");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("a stream script on a buffered response is joined too", async () => {
    const result = await executeServerScripts(
      page(`export default async function* () {
        yield "<li>a</li>";
        yield "<li>b</li>";
      }`),
      new Request("http://localhost/orders"),
      baseContext,
      30000,
      FILE,
    );
    expect(result).toBe("<ul><li>a</li><li>b</li></ul><footer>foot</footer>");
  });

  it("a server script that yields is finished before the response commits, ahead of a stream script after it", async () => {
    const html =
      `<header><script data-bascik-server>\nexport default async function* () { yield "<b>A</b>"; yield "<b>B</b>"; }\n</script></header>` +
      `<ul><script data-bascik-stream>\nexport default async function* () { yield "<li>1</li>"; yield "<li>2</li>"; }\n</script></ul>`;
    const { writes, done } = await stream(html);
    await done;
    expect(writes).toEqual([
      "<header>",
      "<b>A</b><b>B</b>",
      "</header><ul>",
      "<li>1</li>",
      "<li>2</li>",
      "</ul>",
    ]);
  });
});
