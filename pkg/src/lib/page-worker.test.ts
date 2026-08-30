import { describe, it, expect, vi } from "vitest";

const { _mockTranspilePage } = vi.hoisted(() => ({
  _mockTranspilePage: vi.fn(),
}));

vi.mock("./processing.js", () => ({
  transpilePage: _mockTranspilePage,
}));

import { handlePageWorkerMessage } from "./page-worker.ts";

describe("handlePageWorkerMessage", () => {
  it("posts success result when transpilePage resolves", async () => {
    const mockResult = { relativePagePath: "index.html", content: Buffer.from("ok") };
    _mockTranspilePage.mockResolvedValueOnce(mockResult);

    const port = { postMessage: vi.fn() };
    await handlePageWorkerMessage(port, { componentList: {}, globalStylesHtml: "" }, "src/index.html");

    expect(_mockTranspilePage).toHaveBeenCalledWith("src/index.html", {}, "");
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
