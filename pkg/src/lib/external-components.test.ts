import { describe, it, expect } from "vitest";
import { createExternalTagMatcher } from "./external-components.ts";

describe("createExternalTagMatcher", () => {
  it("matches nothing when no entries are configured", () => {
    expect(createExternalTagMatcher(undefined)("heading-anchors")).toBe(false);
    expect(createExternalTagMatcher([])("heading-anchors")).toBe(false);
  });

  it("matches exact names case-insensitively on both sides", () => {
    const matches = createExternalTagMatcher(["Heading-Anchors"]);
    expect(matches("heading-anchors")).toBe(true);
    expect(matches("HEADING-ANCHORS")).toBe(true);
    expect(matches("heading-anchor")).toBe(false);
    expect(matches("my-heading-anchors")).toBe(false);
  });

  it("matches prefix, suffix, and bare wildcards the way scoping.preserve does", () => {
    const prefix = createExternalTagMatcher(["vendor-*"]);
    expect(prefix("vendor-chart")).toBe(true);
    expect(prefix("vendor-chart-legend")).toBe(true);
    expect(prefix("my-vendor-chart")).toBe(false);
    const suffix = createExternalTagMatcher(["*-widget"]);
    expect(suffix("clock-widget")).toBe(true);
    expect(suffix("widget-clock")).toBe(false);
    expect(createExternalTagMatcher(["*"])("any-tag")).toBe(true);
  });

  it("treats regex metacharacters in entries literally and ignores non-strings", () => {
    const matches = createExternalTagMatcher(["a.b-c", 42 as unknown as string, ""]);
    expect(matches("a.b-c")).toBe(true);
    expect(matches("axb-c")).toBe(false);
  });
});
