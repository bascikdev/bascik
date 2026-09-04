import { describe, it, expect, vi } from "vitest";
import { MessageChannel } from "node:worker_threads";

const { _mockTranspilePage } = vi.hoisted(() => ({
  _mockTranspilePage: vi.fn(),
}));

vi.mock("./processing.js", () => ({
  transpilePage: _mockTranspilePage,
}));

import { handlePageWorkerMessage, type PageWorkerMessage } from "./page-worker.ts";

const firstMessage = (port: { postMessage: ReturnType<typeof vi.fn> }): PageWorkerMessage =>
  port.postMessage.mock.calls[0][0] as PageWorkerMessage;

describe("handlePageWorkerMessage", () => {
  it("posts success result when transpilePage resolves with string path", async () => {
    const mockResult = { relativePagePath: "index.html", distHtml: "<p>ok</p>" };
    _mockTranspilePage.mockResolvedValueOnce(mockResult);

    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, { componentList: {}, globalStylesHtml: "" }, "src/index.html");

    expect(_mockTranspilePage).toHaveBeenCalledWith("src/index.html", {}, "", null, undefined);
    const msg = firstMessage(port);
    expect(msg.ok).toBe(true);
    if (!msg.ok) throw new Error("unreachable");
    expect(msg.result!.relativePagePath).toBe("index.html");
    expect(Buffer.from(msg.result!.distHtmlBytes).toString("utf8")).toBe("<p>ok</p>");
  });

  it("posts success result when transpilePage resolves with PageJob", async () => {
    const mockResult = { relativePagePath: "blog/post-1.html", distHtml: "<h1>Post 1</h1>" };
    _mockTranspilePage.mockResolvedValueOnce(mockResult);

    const port = { postMessage: vi.fn() };
    const job = {
      pagePath: "src/pages/blog/[slug].html",
      route: { params: { slug: "post-1" } },
      relativePagePath: "blog/post-1.html",
      preCleanedHtml: "<h1>Post 1</h1>",
    };
    await handlePageWorkerMessage(port, { componentList: {}, globalStylesHtml: "" }, job);

    expect(_mockTranspilePage).toHaveBeenCalledWith(
      "src/pages/blog/[slug].html",
      {},
      "",
      job.route,
      job.preCleanedHtml,
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

    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, error: "Transpile failed" });
  });

  it("handles non-Error objects thrown during transpile", async () => {
    _mockTranspilePage.mockRejectedValueOnce("String error exception");

    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, null, "src/bad.html");

    expect(port.postMessage).toHaveBeenCalledWith({ ok: false, error: "String error exception" });
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

    const [msg, transferList] = port.postMessage.mock.calls[0] as [PageWorkerMessage, unknown[]];
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
      postMessage: (msg: PageWorkerMessage, transfer?: readonly ArrayBuffer[]) => {
        if (msg.ok && msg.result) sentBytes = msg.result.distHtmlBytes;
        port1.postMessage(msg, transfer as ArrayBuffer[]);
      },
    };
    const received = new Promise<PageWorkerMessage>((resolve) => port2.once("message", resolve));
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
    const html = "<!DOCTYPE html><html><body>" + "\u00e9\u4e2d".repeat(500) + "</body></html>";
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

    const first = messages[0] as { ok: boolean; result: { distHtmlBytes: Uint8Array } };
    expect(first.ok).toBe(true);
    expect(first.result.distHtmlBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(first.result.distHtmlBytes).toString("utf8")).toBe(html);
    expect(messages[1]).toEqual({ detachedAfterTransfer: true });
  });
});
