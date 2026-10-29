import { describe, expect, it } from "vitest";
import * as retention from "./module-retention.test-helper.ts";

// WHY: the parent-side skip gate for the http2 retention lanes and the
// child-side `assertSupportedTlsCleanupRuntime` must agree on which runtimes
// are supported. When they drifted (gate `>= 24`, assertion `v24.` only), Node
// 25/26 ran the lane and the child aborted instead of the lane skipping. These
// cases pin one shared predicate for both sides.
const { assertSupportedTlsCleanupRuntime, isTlsCleanupRuntimeSupported } =
  retention;

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
