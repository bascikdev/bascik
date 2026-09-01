import { describe, it, expect, vi } from "vitest";

const { _mockTranspilePage } = vi.hoisted(() => ({
  _mockTranspilePage: vi.fn(),
}));

vi.mock("./processing.js", () => ({
  transpilePage: _mockTranspilePage,
}));

import { handlePageWorkerMessage } from "./page-worker.ts";

describe("handlePageWorkerMessage", () => {
  it("posts success result when transpilePage resolves with string path", async () => {
    const mockResult = { relativePagePath: "index.html", content: Buffer.from("ok") };
    _mockTranspilePage.mockResolvedValueOnce(mockResult);

    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, { componentList: {}, globalStylesHtml: "" }, "src/index.html");

    expect(_mockTranspilePage).toHaveBeenCalledWith("src/index.html", {}, "", null, undefined);
    expect(port.postMessage).toHaveBeenCalledWith({ ok: true, result: mockResult });
  });

  it("posts success result when transpilePage resolves with PageJob", async () => {
    const mockResult = { relativePagePath: "blog/post-1.html", content: Buffer.from("ok") };
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
    expect(port.postMessage).toHaveBeenCalledWith({ ok: true, result: mockResult });
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
