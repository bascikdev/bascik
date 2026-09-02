import { describe, it, expect, vi, beforeEach } from "vitest";
import zlib from "node:zlib";
import { getBrotliQuality } from "./mem.ts";
import { BascikConfig } from "./config.ts";
import { onError, type BascikResponse } from "./server.ts";
import { mem } from "./mem.ts";

describe("Prompt 38 - Brotli Quality Selection", () => {
  it("selects BROTLI_MAX_QUALITY under --build", () => {
    expect(getBrotliQuality({ isBuild: true, isProdServer: false })).toBe(zlib.constants.BROTLI_MAX_QUALITY);
  });

  it("selects BROTLI_MAX_QUALITY under --server", () => {
    expect(getBrotliQuality({ isBuild: false, isProdServer: true })).toBe(zlib.constants.BROTLI_MAX_QUALITY);
  });

  it("selects BROTLI_MIN_QUALITY in dev mode", () => {
    expect(getBrotliQuality({ isBuild: false, isProdServer: false })).toBe(zlib.constants.BROTLI_MIN_QUALITY);
  });
});

describe("Prompt 38 - 500 Error Page and Fallback", () => {
  let mockRes: BascikResponse;
  let sentStatus: number;
  let sentHeaders: Record<string, any>;
  let sentBody: any;

  beforeEach(() => {
    sentStatus = 0;
    sentHeaders = {};
    sentBody = undefined;

    mockRes = {
      headersSent: false,
      destroyed: false,
      writable: {} as any,
      respond: vi.fn((status, headers) => {
        sentStatus = status;
        sentHeaders = headers;
        mockRes.headersSent = true;
      }),
      write: vi.fn(),
      end: vi.fn((chunk) => {
        sentBody = chunk;
      }),
      close: vi.fn(),
      on: vi.fn(),
    };
  });

  it("serves custom /500 page by path convention when stored in memory", () => {
    vi.spyOn(mem, "getPageExact").mockImplementation((path: string) => {
      if (path === "/500") {
        return {
          content: Buffer.from("<html><body>Custom 500 Page</body></html>"),
          relativePagePath: "pages/500.html",
          absolutePagePath: "/app/src/pages/500.html",
          usedComponentsSet: new Set(),
        } as any;
      }
      return undefined;
    });

    const errorMarker = "SECRET_DATABASE_FAILURE_MARKER_98765";
    onError(new Error(errorMarker), mockRes);

    expect(sentStatus).toBe(500);
    expect(sentHeaders["content-type"]).toBe("text/html; charset=utf-8");
    const bodyStr = Buffer.isBuffer(sentBody) ? sentBody.toString("utf8") : String(sentBody);
    expect(bodyStr).toContain("Custom 500 Page");
    expect(bodyStr).not.toContain(errorMarker);
  });

  it("serves built-in fallback when no /500 page exists, with content-type and non-empty body", () => {
    vi.spyOn(mem, "getPageExact").mockReturnValue(undefined);

    const errorMarker = "SECRET_STACK_TRACE_LINE_AT_INTERNAL_MODULE";
    onError(new Error(errorMarker), mockRes);

    expect(sentStatus).toBe(500);
    expect(sentHeaders["content-type"]).toBe("text/html; charset=utf-8");
    const bodyStr = Buffer.isBuffer(sentBody) ? sentBody.toString("utf8") : String(sentBody);
    expect(bodyStr).toContain("Internal Server Error");
    expect(bodyStr).not.toContain(errorMarker);
  });

  it("guards against recursion if /500 lookup or serving throws", () => {
    vi.spyOn(mem, "getPageExact").mockImplementation(() => {
      throw new Error("500 page broken");
    });

    expect(() => {
      onError(new Error("original crash"), mockRes);
    }).not.toThrow();

    expect(sentStatus).toBe(500);
    expect(sentHeaders["content-type"]).toBe("text/html; charset=utf-8");
    const bodyStr = Buffer.isBuffer(sentBody) ? sentBody.toString("utf8") : String(sentBody);
    expect(bodyStr).toContain("Internal Server Error");
  });

  it("includes security headers in the 500 response", () => {
    vi.spyOn(mem, "getPageExact").mockReturnValue(undefined);

    onError(new Error("some crash"), mockRes);

    expect(sentHeaders["x-content-type-options"]).toBe("nosniff");
    expect(sentHeaders["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
