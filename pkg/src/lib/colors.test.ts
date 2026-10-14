import { PassThrough } from "node:stream";
import tty from "node:tty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { colorStatus, stderr, stdout, stripColors, workerEnvironment } from "./colors.ts";

const ESC = "\u001B[";

describe("colors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns plain text when the stream is not a color terminal", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", undefined);
    expect(stdout.green("ok")).toBe("ok");
    expect(stderr.tag("warn", "[bascik] warning")).toBe("[bascik] warning");
    expect(colorStatus(404)).toBe("404");
  });

  it("adds color when FORCE_COLOR is set", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    expect(stdout.green("ok")).toContain(ESC);
    expect(colorStatus(500)).not.toBe(colorStatus(200));
  });

  it("strips every color sequence", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const colored = `${stdout.bold("a")} ${stdout.dim("b")} ${stderr.tag("error")}`;
    expect(colored).toContain(ESC);
    expect(stripColors(colored)).toBe("a b [bascik]");
  });

  describe("workerEnvironment", () => {
    // Node's color check wants real streams. A PassThrough is one; marking it a terminal is what the check reads.
    const stream = (isTTY: boolean): NodeJS.WriteStream => {
      const s = new PassThrough() as unknown as NodeJS.WriteStream;
      s.isTTY = isTTY;
      // Delegate to Node's own implementation, so NO_COLOR and TERM=dumb are decided by Node's rules, not mine.
      s.getColorDepth = (env?: object) => tty.WriteStream.prototype.getColorDepth.call(s, env);
      return s;
    };
    const terminal = () => stream(true);
    const pipe = () => stream(false);

    beforeEach(() => {
      vi.stubEnv("NO_COLOR", undefined);
      vi.stubEnv("FORCE_COLOR", undefined);
      vi.stubEnv("TERM", "xterm-256color");
    });

    it("tells a worker to color when both streams are color terminals", () => {
      const env = workerEnvironment({ stdout: terminal(), stderr: terminal() });
      expect(env?.FORCE_COLOR).toBe("1");
      expect(env?.TERM).toBe("xterm-256color");
    });

    it("leaves the worker alone when either stream is not a terminal, so redirected output never gets escape codes", () => {
      expect(workerEnvironment({ stdout: pipe(), stderr: terminal() })).toBeUndefined();
      expect(workerEnvironment({ stdout: terminal(), stderr: pipe() })).toBeUndefined();
      expect(workerEnvironment({ stdout: pipe(), stderr: pipe() })).toBeUndefined();
    });

    it("honors NO_COLOR and TERM=dumb", () => {
      vi.stubEnv("NO_COLOR", "1");
      expect(workerEnvironment({ stdout: terminal(), stderr: terminal() })).toBeUndefined();
      vi.stubEnv("NO_COLOR", undefined);
      vi.stubEnv("TERM", "dumb");
      expect(workerEnvironment({ stdout: terminal(), stderr: terminal() })).toBeUndefined();
    });

    it("keeps the rest of the environment, and does not change this process's own", () => {
      vi.stubEnv("KEEP", "me");
      const env = workerEnvironment({ stdout: terminal(), stderr: terminal() });
      expect(env?.KEEP).toBe("me");
      expect(process.env.FORCE_COLOR).toBeUndefined();
    });
  });
});
