import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_LEVELS, QUIET_LOG_LEVEL, shouldLog } from "./log-level.ts";

const { config } = vi.hoisted(() => ({
  config: { logging: undefined as { level?: string } | undefined },
}));
vi.mock("./config.js", () => ({ BascikConfig: config }));

import { logInfo } from "./log.ts";

afterEach(() => {
  config.logging = undefined;
  vi.restoreAllMocks();
});

describe("logInfo", () => {
  const run = (level: string | undefined) => {
    config.logging = level === undefined ? undefined : { level };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logInfo("progress", 1);
    return log;
  };

  it("prints at the default level, when no logging config exists at all", () => {
    expect(run(undefined)).toHaveBeenCalledWith("progress", 1);
  });

  it.each(["info", "debug"])("prints at %s", (level) => {
    expect(run(level)).toHaveBeenCalledTimes(1);
  });

  it.each(["warn", "error", "silent"])("prints nothing at %s", (level) => {
    expect(run(level)).not.toHaveBeenCalled();
  });
});

describe("log levels", () => {
  it("--quiet's level hides info and keeps warn and error", () => {
    expect(shouldLog(QUIET_LOG_LEVEL, "info")).toBe(false);
    expect(shouldLog(QUIET_LOG_LEVEL, "warn")).toBe(true);
    expect(shouldLog(QUIET_LOG_LEVEL, "error")).toBe(true);
  });

  it("is a real level, so the CLI and the config validator can accept it", () => {
    expect(LOG_LEVELS).toContain(QUIET_LOG_LEVEL);
  });
});
