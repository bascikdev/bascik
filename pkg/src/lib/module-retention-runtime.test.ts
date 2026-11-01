import { describe, expect, it } from "vitest";
import * as retention from "./module-retention.test-helper.ts";

// WHY: the parent-side skip gate for the http2 retention lanes and the
// child-side `assertSupportedTlsCleanupRuntime` must agree on which runtimes
// are supported. When they drifted (gate `>= 24`, assertion `v24.` only), Node
// 25/26 ran the lane and the child aborted instead of the lane skipping. These
// cases pin one shared predicate for both sides.
const {
  assertSupportedTlsCleanupRuntime,
  isTlsCleanupRuntimeSupported,
  skipUnsupportedRetentionLane,
} = retention;

const destroySslPrototype = { _destroySSL() {} };

describe("TLS cleanup runtime gate", () => {
  it.each([
    ["v22.22.0", false],
    ["v23.11.1", false],
    ["v24.0.0", true],
    ["v24.21.0", true],
    ["v25.0.0", false],
    ["v26.1.0", false],
    // Misuse: a bare version without the `v` prefix, or a prefix lookalike,
    // must not be read as Node 24.
    ["24.21.0", false],
    ["v240.0.0", false],
    ["", false],
  ])("treats %j as supported=%s", (version, supported) => {
    expect(isTlsCleanupRuntimeSupported(version)).toBe(supported);
  });

  it.each(["v22.22.0", "v24.21.0", "v25.0.0", "v26.1.0"])(
    "assertion agrees with the skip predicate for %s",
    (version) => {
      const run = () =>
        assertSupportedTlsCleanupRuntime(version, destroySslPrototype);
      if (isTlsCleanupRuntimeSupported(version)) expect(run).not.toThrow();
      else expect(run).toThrow(/requires the verified Node 24/);
    },
  );

  it("derives the exported flag from the current runtime", () => {
    expect(retention.tlsCleanupRuntimeSupported).toBe(
      isTlsCleanupRuntimeSupported(process.version),
    );
  });

  it("still rejects a runtime without _destroySSL on Node 24", () => {
    expect(() => assertSupportedTlsCleanupRuntime("v24.21.0", {})).toThrow(
      /_destroySSL must exist/,
    );
  });
});

// WHY: on the Node 22.22 floor lane the http2 retention rows skip, and the
// default reporter shows only a skipped count: not the note passed to
// `skip()`, not a skipped test's console output. The lane gate writes its
// reason straight to stderr, which every reporter passes through, and gates
// only http2 so the http1 and dev rows still assert there.
describe("retention lane gate", () => {
  const record = (mode: "dev" | "http1" | "http2", version: string) => {
    const skipped: string[] = [];
    const logged: string[] = [];
    skipUnsupportedRetentionLane(
      mode,
      (note) => skipped.push(note),
      version,
      (message) => logged.push(message),
    );
    return { skipped, logged };
  };

  it("skips an http2 lane off Node 24 and logs why", () => {
    const { skipped, logged } = record("http2", "v22.22.0");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/TLS cleanup callback ordering.*v22\.22\.0/);
    expect(logged).toEqual([`[retention] skipped: ${skipped[0]}`]);
  });

  it.each(["dev", "http1"] as const)(
    "runs the %s lane on the Node 22.22 floor",
    (mode) => {
      expect(record(mode, "v22.22.0")).toEqual({ skipped: [], logged: [] });
    },
  );

  it("runs the http2 lane on Node 24 without logging", () => {
    expect(record("http2", "v24.21.0")).toEqual({ skipped: [], logged: [] });
  });
});
