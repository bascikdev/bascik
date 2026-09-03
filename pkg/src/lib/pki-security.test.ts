import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getSecurityHeaders } from "./server.ts";

describe("Security Headers (Prompt 45)", () => {
  it("does not include deprecated interest-cohort permissions-policy", () => {
    const headers = getSecurityHeaders();
    expect(headers["permissions-policy"]).toBeUndefined();
  });

  it("includes Cross-Origin Opener Policy (COOP) header", () => {
    const headers = getSecurityHeaders();
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  });

  it("includes Cross-Origin Resource Policy (CORP) header", () => {
    const headers = getSecurityHeaders();
    expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("does not set Content-Security-Policy header by default", () => {
    const headers = getSecurityHeaders();
    expect(headers["content-security-policy"]).toBeUndefined();
  });
});
