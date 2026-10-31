import { describe, it, expect } from "vitest";
import { MIME_MAP } from "./mime.ts";

describe("MIME_MAP", () => {
  it("is a Map with entries", () => {
    expect(MIME_MAP).toBeInstanceOf(Map);
    expect(MIME_MAP.size).toBeGreaterThan(0);
  });

  it("does not include .html", () => {
    expect(MIME_MAP.has(".html")).toBe(false);
  });

  it("does not assign readable MIME types to denied or source/config files", () => {
    const unsafeExtensions = [
      ".env",
      ".map",
      ".md",
      ".ts",
      ".mts",
      ".cts",
      ".yaml",
      ".yml",
      ".toml",
      ".ini",
      ".lock",
      ".sh",
      ".py",
      ".rb",
      ".go",
      ".java",
      ".c",
      ".cpp",
      ".h",
    ];

    expect(
      unsafeExtensions.filter((extension) => MIME_MAP.has(extension)),
    ).toEqual([]);
  });

  // F083: publishable text formats a site serves on purpose. Without a type
  // they fell back to application/octet-stream, which, with nosniff, makes
  // a browser download a feed or refuse a caption track. YAML stays
  // untyped on purpose (config files, see above).
  it.each([
    [".rss", "application/rss+xml; charset=utf-8"],
    [".atom", "application/atom+xml; charset=utf-8"],
    [".vtt", "text/vtt; charset=utf-8"],
    [".srt", "text/plain; charset=utf-8"],
    [".xhtml", "application/xhtml+xml; charset=utf-8"],
    [".jsonld", "application/ld+json; charset=utf-8"],
  ])("%s → %s", (extension, type) => {
    expect(MIME_MAP.get(extension)).toBe(type);
  });

  it(".css → text/css; charset=utf-8", () => {
    expect(MIME_MAP.get(".css")).toBe("text/css; charset=utf-8");
  });

  it(".js → text/javascript; charset=utf-8", () => {
    expect(MIME_MAP.get(".js")).toBe("text/javascript; charset=utf-8");
  });

  it(".json → application/json; charset=utf-8", () => {
    expect(MIME_MAP.get(".json")).toBe("application/json; charset=utf-8");
  });

  it(".png → image/png", () => {
    expect(MIME_MAP.get(".png")).toBe("image/png");
  });

  it(".jpg → image/jpeg", () => {
    expect(MIME_MAP.get(".jpg")).toBe("image/jpeg");
  });

  it(".svg → image/svg+xml", () => {
    expect(MIME_MAP.get(".svg")).toBe("image/svg+xml");
  });

  it(".woff2 → font/woff2", () => {
    expect(MIME_MAP.get(".woff2")).toBe("font/woff2");
  });

  it(".woff → font/woff", () => {
    expect(MIME_MAP.get(".woff")).toBe("font/woff");
  });

  it(".webp → image/webp", () => {
    expect(MIME_MAP.get(".webp")).toBe("image/webp");
  });

  it(".pdf → application/pdf", () => {
    expect(MIME_MAP.get(".pdf")).toBe("application/pdf");
  });
});
