import { describe, it, expect, beforeEach } from "vitest";
import {
  setServerHealthState,
  getServerHealthState,
  isHealthEndpoint,
  handleHealthCheck,
} from "./server-lifecycle.ts";

describe("Health state management", () => {
  beforeEach(() => {
    setServerHealthState("booting");
  });

  it("reports non-200 (503) during booting", () => {
    expect(getServerHealthState()).toBe("booting");
    const result = handleHealthCheck();
    expect(result.status).toBe(503);
    expect(result.body).toContain("booting");
  });

  it("reports 200 OK when ready", () => {
    setServerHealthState("ready");
    expect(getServerHealthState()).toBe("ready");
    const result = handleHealthCheck();
    expect(result.status).toBe(200);
    expect(result.body).toContain("ok");
  });

  it("reports non-200 (503) during draining / shutting-down", () => {
    setServerHealthState("draining");
    expect(getServerHealthState()).toBe("draining");
    const result = handleHealthCheck();
    expect(result.status).toBe(503);
    expect(result.body).toContain("draining");
  });

  it("identifies health endpoint path correctly", () => {
    expect(isHealthEndpoint("/_health")).toBe(true);
    expect(isHealthEndpoint("/_health/ready")).toBe(true);
    expect(isHealthEndpoint("/_health/live")).toBe(true);
    expect(isHealthEndpoint("/health")).toBe(false);
    expect(isHealthEndpoint("/about")).toBe(false);
  });

  it("returns no-cache headers on health response", () => {
    setServerHealthState("ready");
    const result = handleHealthCheck();
    expect(result.headers["cache-control"]).toBe("no-store, no-cache, must-revalidate");
  });
});
