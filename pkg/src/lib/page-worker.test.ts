import { describe, it, expect, vi } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { resolve } from "node:path";
import { BuildScriptError } from "./build-error.ts";
import { mem } from "./mem.ts";

const { _mockTranspilePage } = vi.hoisted(() => ({
  _mockTranspilePage: vi.fn(),
}));

vi.mock("./processing.js", () => ({
  transpilePage: _mockTranspilePage,
}));

const { _mockSetChildWorkerCount } = vi.hoisted(() => ({
  _mockSetChildWorkerCount: vi.fn(),
}));

vi.mock("./script-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./script-runner.ts")>()),
  setChildWorkerCount: _mockSetChildWorkerCount,
}));

import {
  createPageWorkerListener,
  handlePageWorkerMessage,
  type PageWorkerMessage,
} from "./page-worker.ts";
import {
  CHILD_WORKER_COUNT_MESSAGE,
  PAGE_WORKER_INIT_MESSAGE,
} from "./page-worker-messages.ts";

const firstMessage = (port: {
  postMessage: ReturnType<typeof vi.fn>;
}): PageWorkerMessage => port.postMessage.mock.calls[0][0] as PageWorkerMessage;

describe("handlePageWorkerMessage", () => {
  // The build trims its early-started pool to the job count and tells the
  // survivors, so each one re-divides the build-script child budget.
  it("applies a worker-count message without transpiling or replying", () => {
    const port = { postMessage: vi.fn() };
    const listener = createPageWorkerListener(port, {
      componentList: {},
      globalStylesHtml: "",
    });
    listener({ kind: CHILD_WORKER_COUNT_MESSAGE, workerCount: 3 });
    expect(_mockSetChildWorkerCount).toHaveBeenCalledWith(3);
    expect(_mockTranspilePage).not.toHaveBeenCalled();
    // A reply would be taken by the pool for a task result.
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  // The pool starts before the component list is loaded; the list arrives
  // as an init message ahead of the first page.
  it("compiles with the component list from the init message", async () => {
    _mockTranspilePage.mockResolvedValueOnce({
      relativePagePath: "index.html",
      distHtml: "<p>ok</p>",
    });
    const port = { postMessage: vi.fn() };
    const listener = createPageWorkerListener(port, null);
    const componentList = { card: { path: "src/components/card.html" } };
    listener({
      kind: PAGE_WORKER_INIT_MESSAGE,
      componentList: componentList as never,
      globalStylesHtml: "<style>x</style>",
    });
    expect(port.postMessage).not.toHaveBeenCalled();
    listener("src/pages/index.html");
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    expect(_mockTranspilePage).toHaveBeenCalledWith(
      "src/pages/index.html",
      componentList,
      "<style>x</style>",
      null,
      undefined,
      { deferDiskWrite: true },
    );
    expect(firstMessage(port).ok).toBe(true);
  });

  it("fails a page that arrives before the init message instead of compiling it without components", () => {
    const port = { postMessage: vi.fn() };
    createPageWorkerListener(port, null)("src/pages/index.html");
    expect(_mockTranspilePage).not.toHaveBeenCalled();
    const msg = firstMessage(port);
    expect(msg.ok).toBe(false);
    if (msg.ok) throw new Error("unreachable");
    expect(msg.error).toMatch(/before its component list/);
  });

  it("posts success result when transpilePage resolves with string path", async () => {
    const mockResult = {
      relativePagePath: "index.html",
      distHtml: "<p>ok</p>",
    };
    _mockTranspilePage.mockResolvedValueOnce(mockResult);

    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(
      port,
      { componentList: {}, globalStylesHtml: "" },
      "src/index.html",
    );

    expect(_mockTranspilePage).toHaveBeenCalledWith(
      "src/index.html",
      {},
      "",
      null,
      undefined,
      { deferDiskWrite: true },
    );
    const msg = firstMessage(port);
    expect(msg.ok).toBe(true);
    if (!msg.ok) throw new Error("unreachable");
    expect(msg.result!.relativePagePath).toBe("index.html");
    expect(Buffer.from(msg.result!.distHtmlBytes).toString("utf8")).toBe(
      "<p>ok</p>",
    );
  });

  it("posts success result when transpilePage resolves with PageJob", async () => {
    const mockResult = {
      relativePagePath: "blog/post-1.html",
      distHtml: "<h1>Post 1</h1>",
    };
    _mockTranspilePage.mockResolvedValueOnce(mockResult);

    const port = { postMessage: vi.fn() };
    const job = {
      pagePath: "src/pages/blog/[slug].html",
      route: { params: { slug: "post-1" } },
      relativePagePath: "blog/post-1.html",
      preCleanedHtml: "<h1>Post 1</h1>",
    };
    await handlePageWorkerMessage(
      port,
      { componentList: {}, globalStylesHtml: "" },
      job,
    );

    expect(_mockTranspilePage).toHaveBeenCalledWith(
      "src/pages/blog/[slug].html",
      {},
      "",
      job.route,
      job.preCleanedHtml,
      { deferDiskWrite: true },
    );
    const msg = firstMessage(port);
    expect(msg.ok).toBe(true);
    if (!msg.ok) throw new Error("unreachable");
    expect(msg.result!.relativePagePath).toBe("blog/post-1.html");
  });

  it("posts a null result with no transfer list when transpilePage resolves null", async () => {
    _mockTranspilePage.mockResolvedValueOnce(null);
    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, null, "src/missing.html");
    expect(port.postMessage).toHaveBeenCalledWith({ ok: true, result: null });
  });

  it("posts error result when transpilePage rejects", async () => {
    _mockTranspilePage.mockRejectedValueOnce(new Error("Transpile failed"));

    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, null, "src/bad.html");

    expect(port.postMessage).toHaveBeenCalledWith({
      ok: false,
      error: "Transpile failed",
    });
  });

  // F054: a structured clone keeps neither the class nor the fields of a
  // BuildScriptError, so the worker posts them as data.
  it("posts a build script failure's location beside its message", async () => {
    _mockTranspilePage.mockRejectedValueOnce(
      new BuildScriptError("build script error in site-footer", {
        sourceFile: "components/site-footer.html",
        line: 7,
        column: 3,
      }),
    );
    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, null, "src/pages/index.html");
    expect(port.postMessage).toHaveBeenCalledWith({
      ok: false,
      error: "build script error in site-footer",
      detail: {
        message: "build script error in site-footer",
        location: {
          sourceFile: "components/site-footer.html",
          line: 7,
          column: 3,
        },
      },
    });
  });

  // F053: the helpers a failed compile could not import were recorded only
  // in this worker's own store; they now travel with the failure.
  it("posts the missing helpers the failed compile recorded, and only this compile's", async () => {
    const page = resolve("src/pages/index.html");
    mem.recordFailedDependencies(page, ["src/pages/lib/stale.ts"]);
    _mockTranspilePage.mockImplementationOnce(async () => {
      mem.recordFailedDependencies(page, ["src/pages/lib/prices.ts"]);
      throw new Error("Cannot find module './lib/prices.ts'");
    });
    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, null, page);
    expect(firstMessage(port)).toEqual({
      ok: false,
      error: "Cannot find module './lib/prices.ts'",
      detail: {
        message: "Cannot find module './lib/prices.ts'",
        failedDependencies: ["src/pages/lib/prices.ts"],
      },
    });

    // A later failure that records nothing must not resend the old list.
    _mockTranspilePage.mockRejectedValueOnce(new Error("no body"));
    const again = { postMessage: vi.fn() };
    await handlePageWorkerMessage(again, null, page);
    expect(firstMessage(again)).toEqual({ ok: false, error: "no body" });
  });

  it("handles non-Error objects thrown during transpile", async () => {
    _mockTranspilePage.mockRejectedValueOnce("String error exception");

    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, null, "src/bad.html");

    expect(port.postMessage).toHaveBeenCalledWith({
      ok: false,
      error: "String error exception",
    });
  });
});

describe("prompt 86: page output crosses the thread boundary as a transferred buffer", () => {
  it("encodes distHtml to a dedicated Uint8Array and passes its ArrayBuffer in the transfer list", async () => {
    const html = "<html><body>" + "x".repeat(20000) + "</body></html>";
    _mockTranspilePage.mockResolvedValueOnce({
      relativePagePath: "index.html",
      absolutePagePath: "/abs/src/pages/index.html",
      distHtml: html,
      usedComponentsNames: [],
    });
    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, null, "src/pages/index.html");

    const [msg, transferList] = port.postMessage.mock.calls[0] as [
      PageWorkerMessage,
      unknown[],
    ];
    expect(msg.ok).toBe(true);
    if (!msg.ok) throw new Error("unreachable");
    const bytes = msg.result!.distHtmlBytes;
    expect(bytes).toBeInstanceOf(Uint8Array);
    // The message carries bytes, never the UTF-16 string.
    expect("distHtml" in msg.result!).toBe(false);
    // The typed array owns its whole ArrayBuffer (not a slice of Node's shared
    // Buffer pool), so transferring it cannot detach memory used elsewhere.
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
    expect(transferList).toEqual([bytes.buffer]);
    expect(Buffer.from(bytes).toString("utf8")).toBe(html);
  });

  it("through a real MessagePort the ArrayBuffer is detached in the sender and intact in the receiver", async () => {
    const html = "<p>" + "transfer".repeat(1000) + "</p>";
    _mockTranspilePage.mockResolvedValueOnce({
      relativePagePath: "t.html",
      absolutePagePath: "/abs/src/pages/t.html",
      distHtml: html,
      usedComponentsNames: ["a-comp"],
      fileDependencies: ["dep.ts"],
    });
    const { port1, port2 } = new MessageChannel();
    let sentBytes: Uint8Array | undefined;
    const spyPort = {
      postMessage: (
        msg: PageWorkerMessage,
        transfer?: readonly ArrayBuffer[],
      ) => {
        if (msg.ok && msg.result) sentBytes = msg.result.distHtmlBytes;
        port1.postMessage(msg, transfer as ArrayBuffer[]);
      },
    };
    const received = new Promise<PageWorkerMessage>((resolve) =>
      port2.once("message", resolve),
    );
    await handlePageWorkerMessage(spyPort, null, "src/pages/t.html");
    const msg = await received;
    port1.close();
    port2.close();

    // Ownership moved: the sender-side view is detached (zero length).
    expect(sentBytes).toBeDefined();
    expect(sentBytes!.byteLength).toBe(0);
    expect(sentBytes!.buffer.byteLength).toBe(0);

    expect(msg.ok).toBe(true);
    if (!msg.ok) throw new Error("unreachable");
    expect(msg.result!.relativePagePath).toBe("t.html");
    expect(msg.result!.usedComponentsNames).toEqual(["a-comp"]);
    expect(msg.result!.fileDependencies).toEqual(["dep.ts"]);
    expect(Buffer.from(msg.result!.distHtmlBytes).toString("utf8")).toBe(html);
  });

  it("across a real worker_threads boundary the bytes arrive intact and the worker-side buffer is detached", async () => {
    const { Worker } = await import("node:worker_threads");
    const html =
      "<!DOCTYPE html><html><body>" +
      "\u00e9\u4e2d".repeat(500) +
      "</body></html>";
    // A tiny stand-in worker that does exactly what page-worker.ts does on the
    // send side, then reports whether its own view was detached by the transfer.
    const script = `
      const { parentPort } = require("node:worker_threads");
      parentPort.once("message", (html) => {
        const bytes = new TextEncoder().encode(html);
        parentPort.postMessage({ ok: true, result: { distHtmlBytes: bytes } }, [bytes.buffer]);
        parentPort.postMessage({ detachedAfterTransfer: bytes.byteLength === 0 && bytes.buffer.byteLength === 0 });
      });
    `;
    const worker = new Worker(script, { eval: true });
    const messages: unknown[] = [];
    const twoMessages = new Promise<void>((resolve) => {
      worker.on("message", (m) => {
        messages.push(m);
        if (messages.length === 2) resolve();
      });
    });
    worker.postMessage(html);
    await twoMessages;
    await worker.terminate();

    const first = messages[0] as {
      ok: boolean;
      result: { distHtmlBytes: Uint8Array };
    };
    expect(first.ok).toBe(true);
    expect(first.result.distHtmlBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(first.result.distHtmlBytes).toString("utf8")).toBe(html);
    expect(messages[1]).toEqual({ detachedAfterTransfer: true });
  });
});
