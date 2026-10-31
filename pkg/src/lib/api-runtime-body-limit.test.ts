import { describe, it, expect, vi } from "vitest";

// F093 defense in depth: config validation rejects a wrong-typed
// http.maxBodySize, but a value that reaches the runtime anyway (a config
// object built by hand, an adapter) must keep the default limit instead of
// turning the limit off, since `"1mb" > 0` and `"1mb" <= 0` are both false.
const { config } = vi.hoisted(() => ({
  config: { http: { maxBodySize: undefined as unknown } },
}));
vi.mock("./config.ts", () => ({ BascikConfig: config }));

import { declaresBodyOverLimit, resolveMaxBodySize } from "./api-runtime.ts";

describe("resolveMaxBodySize with a value that skipped validation", () => {
  it.each(["1mb", Number.NaN, null, true, {}])(
    "keeps the 1 MB default for %s",
    (value) => {
      config.http.maxBodySize = value;
      expect(resolveMaxBodySize()).toBe(1048576);
      expect(
        declaresBodyOverLimit("POST", { "content-length": "2000000" }),
      ).toBe(true);
    },
  );

  it("keeps a numeric limit and 0 for no limit", () => {
    config.http.maxBodySize = 10;
    expect(resolveMaxBodySize()).toBe(10);
    config.http.maxBodySize = 0;
    expect(resolveMaxBodySize()).toBe(0);
    expect(declaresBodyOverLimit("POST", { "content-length": "2000000" })).toBe(
      false,
    );
  });
});
