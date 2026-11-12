/**
 * Request-time component rendering of a job that yields: `wrapRunner` renders
 * each chunk on its own, as it renders a returned output, so a stream script
 * can yield component tags row by row. The renderer itself is covered in
 * `request-render.test.ts`; this file covers only what chunks add: one
 * stylesheet per response, ids that never repeat across chunks, nested
 * component scripts per chunk, and release of the job's place in the
 * stylesheet chain however the iteration ends.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("./config.js", () => ({
  BascikConfig: {
    base: "/",
    minify: { identifiers: false, html: false, css: false, js: false },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    scripts: {
      cache: { enabled: true },
      onBuildScriptError: "error",
      onServerScriptError: "error",
      timeout: 30000,
    },
    components: { external: [] },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import {
  buildComponentManifest,
  type ComponentManifest,
} from "./component-manifest.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import {
  collectScriptJobOutput,
  composeBufferedResponse,
  streamComposedResponse,
  type ExecutionPlan,
  type ExecutionSegment,
  type ScriptJobOutput,
  type ScriptOutputRunner,
  type StreamWriter,
} from "./request-execution.ts";
import {
  RequestRenderError,
  wrapRunner,
  type RenderHost,
} from "./request-render.ts";
import { clearScopingTemplates } from "./scoping-template.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import type { ComponentList } from "./types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const count = (text: string, needle: string): number =>
  text.split(needle).length - 1;

const staticSeg = (text: string): ExecutionSegment => ({
  kind: "static",
  bytes: enc.encode(text),
});
const scriptSeg = (
  id: string,
  mode: "server" | "stream",
): ExecutionSegment => ({ kind: "script", mode, id });
const planOf = (...segments: ExecutionSegment[]): ExecutionPlan => ({
  segments,
  firstStreamIndex: segments.findIndex(
    (s) => s.kind === "script" && s.mode === "stream",
  ),
});

const components = (): ComponentList => ({
  "book-row": {
    fileName: "src/components/book-row.html",
    fileContent: `<li class="row" id="row"><span class="title" data-bascik-prop-title>Untitled</span></li>`,
    cssFileContent: ".row { padding: 1px } .title { color: red }",
  },
  "stock-row": {
    fileName: "src/components/stock-row.html",
    fileContent: `<li class="stock"><script data-bascik-server>\nexport default () => '<b class="count">3</b>';\n</script></li>`,
    cssFileContent: ".stock { margin: 0 } .count { color: blue }",
  },
});

const build = async (): Promise<ComponentManifest> => {
  clearScopingTemplates();
  serverSidecarRegistry.clear();
  return buildComponentManifest(components(), BascikConfig);
};

const makeHost = (
  manifest: ComponentManifest,
  overrides: Partial<RenderHost> = {},
): RenderHost => ({
  manifest,
  hashName: (input) => input,
  hashHex: (input) => createHash("sha256").update(input).digest("hex"),
  httpPath: "/catalog",
  timeoutMs: 1000,
  runComponentJob: vi.fn(async () => '<b class="count">3</b>'),
  warnOnce: vi.fn(),
  externalTags: createExternalTagMatcher([]),
  ...overrides,
});

const row = (title: string) =>
  `<book-row data-bascik-prop-title="${title}"></book-row>`;
const styleBlock = (manifest: ComponentManifest, name: string) =>
  `<style>${(manifest.components[name].css as { text: string }).text}</style>`;

/** A runner answering each id with a string or a function making its output. */
const runnerFrom = (
  table: Record<string, string | (() => ScriptJobOutput)>,
): ScriptOutputRunner =>
  vi.fn(async (id: string) => {
    const target = table[id];
    if (target === undefined) throw new Error(`unrouted job ${id}`);
    return typeof target === "string" ? target : target();
  });

const chunksOf = async (output: ScriptJobOutput): Promise<string[]> => {
  if (typeof output === "string") return [output];
  const chunks: string[] = [];
  for await (const chunk of output) chunks.push(chunk);
  return chunks;
};

const signalOf = () => new AbortController().signal;
const idsIn = (html: string): string[] =>
  [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);

describe("wrapRunner: a job that yields component tags", () => {
  it("renders each chunk on its own; the first is byte for byte what the same markup renders to when returned", async () => {
    const manifest = await build();
    const plan = planOf(scriptSeg("s", "stream"));
    const yielded = wrapRunner(
      runnerFrom({
        s: async function* () {
          yield row("Dune");
          yield row("Emma");
          yield row("Ulysses");
        },
      }),
      plan,
      makeHost(manifest),
    );
    const chunks = await chunksOf(await yielded("s", signalOf()));
    expect(chunks).toHaveLength(3);
    for (const [index, title] of ["Dune", "Emma", "Ulysses"].entries()) {
      expect(chunks[index]).toContain(`>${title}</span>`);
      expect(chunks[index]).not.toContain("<book-row");
      expect(count(chunks[index], "<li")).toBe(1);
    }

    const returned = wrapRunner(
      runnerFrom({ s: row("Dune") }),
      plan,
      makeHost(manifest),
    );
    expect(chunks[0]).toBe(await returned("s", signalOf()));
  });

  it("the component's stylesheet goes out once, ahead of the first row, and never again", async () => {
    const manifest = await build();
    const wrapped = wrapRunner(
      runnerFrom({
        s: async function* () {
          yield row("Dune");
          yield row("Emma");
        },
      }),
      planOf(scriptSeg("s", "stream")),
      makeHost(manifest),
    );
    const chunks = await chunksOf(await wrapped("s", signalOf()));
    expect(chunks[0].startsWith(styleBlock(manifest, "book-row"))).toBe(true);
    expect(chunks[1]).not.toContain("<style>");
  });

  it("no scoped id repeats across the chunks of one job, however many rows", async () => {
    const manifest = await build();
    const wrapped = wrapRunner(
      runnerFrom({
        s: async function* () {
          for (let i = 0; i < 40; i++) yield row(`Book ${i}`);
        },
      }),
      planOf(scriptSeg("s", "stream")),
      makeHost(manifest),
    );
    const chunks = await chunksOf(await wrapped("s", signalOf()));
    const ids = idsIn(chunks.join(""));
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it("the ids are the same on every run, so two hosts send the same bytes", async () => {
    const manifest = await build();
    const render = async () =>
      (
        await chunksOf(
          await wrapRunner(
            runnerFrom({
              s: async function* () {
                yield row("Dune");
                yield row("Emma");
              },
            }),
            planOf(scriptSeg("s", "stream")),
            makeHost(manifest),
          )("s", signalOf()),
        )
      ).join("");
    expect(await render()).toBe(await render());
  });

  it("a chunk with no tag, and one with only vanilla markup, pass through untouched", async () => {
    const manifest = await build();
    const wrapped = wrapRunner(
      runnerFrom({
        s: async function* () {
          yield "plain text";
          yield "<li>vanilla</li>";
        },
      }),
      planOf(scriptSeg("s", "stream")),
      makeHost(manifest),
    );
    expect(await chunksOf(await wrapped("s", signalOf()))).toEqual([
      "plain text",
      "<li>vanilla</li>",
    ]);
  });

  it("a component's own server script runs for the row of every chunk", async () => {
    const manifest = await build();
    const host = makeHost(manifest);
    const wrapped = wrapRunner(
      runnerFrom({
        s: async function* () {
          yield "<stock-row></stock-row>";
          yield "<stock-row></stock-row>";
        },
      }),
      planOf(scriptSeg("s", "stream")),
      host,
    );
    const chunks = await chunksOf(await wrapped("s", signalOf()));
    expect(host.runComponentJob).toHaveBeenCalledTimes(2);
    for (const chunk of chunks) {
      expect(chunk).toContain('<b class="count">3</b>');
      expect(chunk).not.toContain("text/bascik-server");
    }
  });

  it("a later job that uses the same component waits for the yielding job and carries no second stylesheet", async () => {
    const manifest = await build();
    const plan = planOf(
      staticSeg("<ul>"),
      scriptSeg("s1", "stream"),
      staticSeg("</ul><ul>"),
      scriptSeg("s2", "stream"),
      staticSeg("</ul>"),
    );
    const wrapped = wrapRunner(
      runnerFrom({
        s1: async function* () {
          await tick();
          yield row("Dune");
          await tick();
          yield row("Emma");
        },
        s2: row("Ulysses"),
      }),
      plan,
      makeHost(manifest),
    );
    const writes: string[] = [];
    const writer: StreamWriter = {
      write: async (chunk) => void writes.push(dec.decode(chunk)),
    };
    const streamer = streamComposedResponse(plan, wrapped, writer);
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    const body = writes.join("");
    expect(count(body, "<style>")).toBe(1);
    expect(body.indexOf("<style>")).toBeLessThan(body.indexOf("<li"));
    expect(body.indexOf(">Dune<")).toBeLessThan(body.indexOf(">Emma<"));
    expect(body.indexOf(">Emma<")).toBeLessThan(body.indexOf(">Ulysses<"));
    // Each row was its own write.
    expect(writes.filter((write) => write.includes("<li"))).toHaveLength(3);
  });

  it("a yielding job that is closed early gives up its place, so the job after it is not left waiting", async () => {
    const manifest = await build();
    const plan = planOf(scriptSeg("s1", "stream"), scriptSeg("s2", "stream"));
    const closed = vi.fn();
    const wrapped = wrapRunner(
      runnerFrom({
        s1: async function* () {
          try {
            yield row("Dune");
            yield row("Emma");
          } finally {
            closed();
          }
        },
        s2: row("Ulysses"),
      }),
      plan,
      makeHost(manifest),
    );
    const first = await wrapped("s1", signalOf());
    const second = wrapped("s2", signalOf());
    const iterator = (first as AsyncIterable<string>)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(await collectScriptJobOutput(await second)).toContain(">Ulysses<");
    expect((await iterator.next()).done).toBe(true);
  });

  it("a yielding job that fails gives up its place too, and its failure reaches the caller", async () => {
    const manifest = await build();
    const plan = planOf(scriptSeg("s1", "stream"), scriptSeg("s2", "stream"));
    const wrapped = wrapRunner(
      runnerFrom({
        s1: async function* () {
          yield row("Dune");
          throw new Error("row failed");
        },
        s2: row("Ulysses"),
      }),
      plan,
      makeHost(manifest),
    );
    const first = (await wrapped("s1", signalOf())) as AsyncIterable<string>;
    const second = wrapped("s2", signalOf());
    const iterator = first[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("row failed");
    expect(await collectScriptJobOutput(await second)).toContain(">Ulysses<");
  });

  it("a chunk whose render fails follows the host's policy: dropped when the host returns, and the rows after it still render", async () => {
    const manifest = await build();
    const onRenderError = vi.fn();
    const wrapped = wrapRunner(
      runnerFrom({
        s: async function* () {
          yield row("Dune");
          yield row("Emma").repeat(3);
          yield row("Ulysses");
        },
      }),
      planOf(scriptSeg("s", "stream")),
      makeHost(manifest, { onRenderError, limits: { maxInstances: 1 } }),
    );
    const chunks = await chunksOf(await wrapped("s", signalOf()));
    expect(onRenderError).toHaveBeenCalledTimes(1);
    expect(onRenderError.mock.calls[0][0]).toBeInstanceOf(RequestRenderError);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain(">Dune<");
    expect(chunks[1]).toContain(">Ulysses<");
  });

  it("a chunk whose render fails ends the job when the host's policy throws", async () => {
    const manifest = await build();
    const wrapped = wrapRunner(
      runnerFrom({
        s: async function* () {
          yield row("Dune");
          yield row("Emma").repeat(3);
          yield row("Ulysses");
        },
      }),
      planOf(scriptSeg("s", "stream")),
      makeHost(manifest, {
        onRenderError: (error) => {
          throw error;
        },
        limits: { maxInstances: 1 },
      }),
    );
    const iterator = (
      (await wrapped("s", signalOf())) as AsyncIterable<string>
    )[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toContain(">Dune<");
    await expect(iterator.next()).rejects.toBeInstanceOf(RequestRenderError);
    expect((await iterator.next()).done).toBe(true);
  });

  it("a buffered response joins the rendered chunks, with the stylesheet first", async () => {
    const manifest = await build();
    const plan = planOf(
      staticSeg("<ul>"),
      scriptSeg("s", "stream"),
      staticSeg("</ul>"),
    );
    const wrapped = wrapRunner(
      runnerFrom({
        s: async function* () {
          yield row("Dune");
          yield row("Emma");
        },
      }),
      plan,
      makeHost(manifest),
    );
    const body = dec.decode(await composeBufferedResponse(plan, wrapped));
    expect(body.startsWith(`<ul>${styleBlock(manifest, "book-row")}<li`)).toBe(
      true,
    );
    expect(count(body, "<li")).toBe(2);
    expect(body.endsWith("</ul>")).toBe(true);
  });

  it("a runner that only returns strings still gets strings back", async () => {
    const manifest = await build();
    const wrapped = wrapRunner(
      async () => row("Dune"),
      planOf(scriptSeg("s", "server")),
      makeHost(manifest),
    );
    const output: string = await wrapped("s", signalOf());
    expect(output).toContain(">Dune<");
  });
});

describe("wrapRunner: a job that yields, what the review found", () => {
  it("a chunk dropped for a render failure does not abort the nested scripts of the chunks after it", async () => {
    const manifest = await build();
    const signals: boolean[] = [];
    const host = makeHost(manifest, {
      onRenderError: vi.fn(),
      limits: { maxInstances: 1 },
      runComponentJob: vi.fn(async (_id: string, signal: AbortSignal) => {
        signals.push(signal.aborted);
        return '<b class="count">3</b>';
      }),
    });
    const wrapped = wrapRunner(
      runnerFrom({
        s: async function* () {
          yield "<stock-row></stock-row>";
          yield "<stock-row></stock-row>".repeat(3);
          yield "<stock-row></stock-row>";
        },
      }),
      planOf(scriptSeg("s", "stream")),
      host,
    );
    const chunks = await chunksOf(await wrapped("s", signalOf()));
    expect(host.onRenderError).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(2);
    expect(signals).toEqual([false, false]);
    for (const chunk of chunks)
      expect(chunk).toContain('<b class="count">3</b>');
  });

  it("misuse: a runner that resolves to something that is neither a string nor iterable fails that job and frees its place", async () => {
    const manifest = await build();
    const plan = planOf(scriptSeg("s1", "stream"), scriptSeg("s2", "stream"));
    const wrapped = wrapRunner(
      (async (id: string) =>
        id === "s1" ? undefined : row("Ulysses")) as ScriptOutputRunner,
      plan,
      makeHost(manifest),
    );
    const first = wrapped("s1", signalOf());
    const second = wrapped("s2", signalOf());
    await expect(first).rejects.toThrow(TypeError);
    expect(await collectScriptJobOutput(await second)).toContain(">Ulysses<");
  });

  it("a server job that yields is joined before it is rendered, so a tag split across yields still renders", async () => {
    const manifest = await build();
    const wrapped = wrapRunner(
      runnerFrom({
        a: async function* () {
          yield '<book-row data-bascik-prop-title="Du';
          yield 'ne"></book-row>';
          yield row("Emma");
        },
      }),
      planOf(scriptSeg("a", "server")),
      makeHost(manifest),
    );
    const output = await wrapped("a", signalOf());
    expect(typeof output).toBe("string");
    expect(output).not.toContain("<book-row");
    expect(output).toContain(">Dune<");
    expect(output).toContain(">Emma<");
    // One output, so it is what the same markup renders to when returned.
    const returned = wrapRunner(
      runnerFrom({ a: row("Dune") + row("Emma") }),
      planOf(scriptSeg("a", "server")),
      makeHost(manifest),
    );
    expect(output).toBe(await returned("a", signalOf()));
  });
});
