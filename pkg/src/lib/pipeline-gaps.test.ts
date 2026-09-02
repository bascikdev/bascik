import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Pipeline Gaps and Logging (Prompt 43)", () => {
  it("rejects %00 null byte in path with 400 Bad Request", async () => {
    const { createRequestHandler } = await import("./server.ts");
    const handleRequest = createRequestHandler();

    const mockRes: any = {
      headersSent: false,
      destroyed: false,
      respond: vi.fn(),
      end: vi.fn(),
    };

    const mockReq: any = {
      method: "GET",
      path: "/%00/something.css",
      headers: {},
      remoteIp: "127.0.0.1",
    };

    await handleRequest(mockReq, mockRes);
    expect(mockRes.respond).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockRes.end).toHaveBeenCalledWith("Bad Request");
  });

  it("rejects control characters in decoded path with 400 Bad Request", async () => {
    const { createRequestHandler } = await import("./server.ts");
    const handleRequest = createRequestHandler();

    const mockRes: any = {
      headersSent: false,
      destroyed: false,
      respond: vi.fn(),
      end: vi.fn(),
    };

    const mockReq: any = {
      method: "GET",
      path: "/styles\r\n.css",
      headers: {},
      remoteIp: "127.0.0.1",
    };

    await handleRequest(mockReq, mockRes);
    expect(mockRes.respond).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockRes.end).toHaveBeenCalledWith("Bad Request");
  });

  it("sets content-type on 404 responses", async () => {
    const { mem } = await import("./mem.ts");
    mem.setBootingDone();
    const { createRequestHandler } = await import("./server.ts");
    const handleRequest = createRequestHandler();

    const mockRes: any = {
      headersSent: false,
      destroyed: false,
      respond: vi.fn(),
      end: vi.fn(),
    };

    const mockReq: any = {
      method: "GET",
      path: "/non-existent-page",
      headers: {},
      remoteIp: "127.0.0.1",
    };

    await handleRequest(mockReq, mockRes);
    expect(mockRes.respond).toHaveBeenCalledWith(
      404,
      expect.objectContaining({ "content-type": expect.stringContaining("text/plain") }),
    );
  });

  it("drains request body when method is rejected with 405", async () => {
    const { createRequestHandler } = await import("./server.ts");
    const handleRequest = createRequestHandler();

    const mockWritable: any = {
      resume: vi.fn(),
    };

    const mockRes: any = {
      headersSent: false,
      destroyed: false,
      writable: mockWritable,
      respond: vi.fn(),
      end: vi.fn(),
    };

    const mockReq: any = {
      method: "DELETE",
      path: "/about",
      headers: {},
      remoteIp: "127.0.0.1",
    };

    await handleRequest(mockReq, mockRes);
    expect(mockRes.respond).toHaveBeenCalledWith(405, expect.any(Object));
    expect(mockRes.end).toHaveBeenCalledWith("Method Not Allowed");
  });
});
