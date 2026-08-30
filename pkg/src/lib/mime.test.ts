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

  it(".css → text/css; charset=utf-8", () => {
    expect(MIME_MAP.get(".css")).toBe("text/css; charset=utf-8");
  });

  it(".js → text/javascript; charset=utf-8", () => {
    expect(MIME_MAP.get(".js")).toBe("text/javascript; charset=utf-8");
  });

  it(".mjs → text/javascript; charset=utf-8", () => {
    expect(MIME_MAP.get(".mjs")).toBe("text/javascript; charset=utf-8");
  });

  it(".cjs → text/javascript; charset=utf-8", () => {
    expect(MIME_MAP.get(".cjs")).toBe("text/javascript; charset=utf-8");
  });

  it(".ts → text/typescript; charset=utf-8", () => {
    expect(MIME_MAP.get(".ts")).toBe("text/typescript; charset=utf-8");
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
