import { describe, it, expect } from "vitest";
import { hasHiddenSegment, WELL_KNOWN_SEGMENT } from "./route-matching.ts";

describe("hasHiddenSegment", () => {
  it("names the RFC 8615 well-known segment", () => {
    expect(WELL_KNOWN_SEGMENT).toBe(".well-known");
  });

  it.each([
    "/.env",
    "/.git/config",
    "/foo/.hidden",
    "/.bascik/manifest.json",
    "/.bascik/server-scripts.json",
    "/.well-knownx/a.json",
    "/.Well-Known/a.json",
    "/.WELL-KNOWN/a.json",
    "/.well-known/.env",
    "/.well-known/agent-skills/.secret/a.json",
    "/blog/.well-known/a.json",
    "/api/.well-known/a.json",
    ".env",
    "dir/.env",
  ])("treats %s as hidden", (path) => {
    expect(hasHiddenSegment(path)).toBe(true);
  });

  it.each([
    "/",
    "",
    "/about",
    "/assets/app.js",
    "/.well-known",
    "/.well-known/",
    "/.well-known/security.txt",
    "/.well-known/agent-skills/index.json",
    "/.well-known/agent-skills/bascik.tar.gz",
    "//.well-known/security.txt",
    ".well-known/security.txt",
    "well-known/a.json",
    "/file.with.dots.txt",
  ])("allows %s", (path) => {
    expect(hasHiddenSegment(path)).toBe(false);
  });

  describe("with a non-root base", () => {
    it("allows the well-known segment directly below the base", () => {
      expect(hasHiddenSegment("/docs/.well-known/security.txt", "/docs/")).toBe(
        false,
      );
      expect(
        hasHiddenSegment("/docs/.well-known/agent-skills/index.json", "/docs/"),
      ).toBe(false);
    });

    it("still hides other dot segments below the base", () => {
      expect(hasHiddenSegment("/docs/.env", "/docs/")).toBe(true);
      expect(hasHiddenSegment("/docs/.well-known/.env", "/docs/")).toBe(true);
      expect(hasHiddenSegment("/docs/blog/.well-known/a.json", "/docs/")).toBe(
        true,
      );
    });

    it("applies the root rule to paths outside the base, which are 404 anyway", () => {
      expect(hasHiddenSegment("/other/.well-known/a.json", "/docs/")).toBe(
        true,
      );
      expect(hasHiddenSegment("/.env", "/docs/")).toBe(true);
    });

    it("does not treat a base-like prefix without a boundary as the base", () => {
      expect(hasHiddenSegment("/docsx/.well-known/a.json", "/docs/")).toBe(
        true,
      );
    });
  });
});
