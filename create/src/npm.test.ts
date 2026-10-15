import { describe, expect, it, vi } from "vitest";
import { npmInvocation, runNpm } from "./npm.ts";

describe("npmInvocation", () => {
  it("runs npm directly on macOS and Linux", () => {
    expect(npmInvocation(["install"], "darwin")).toEqual({ command: "npm", args: ["install"] });
    expect(npmInvocation(["run", "dev"], "linux")).toEqual({ command: "npm", args: ["run", "dev"] });
  });

  it("goes through cmd.exe on Windows, because npm is a .cmd file that Node cannot start directly", () => {
    expect(npmInvocation(["run", "dev"], "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm", "run", "dev"],
    });
  });

  it("falls back to cmd.exe on Windows when ComSpec is not set", () => {
    expect(npmInvocation(["install"], "win32", {}).command).toBe("cmd.exe");
  });

  it("never asks for npm.cmd by name, which is the call that fails", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(npmInvocation(["install"], platform, {}).command).not.toBe("npm.cmd");
    }
  });
});

describe("runNpm", () => {
  const spawned = (overrides: object) => vi.fn(() => ({ status: 0, ...overrides }) as never);

  it("runs in the project folder with the terminal attached", () => {
    const spawn = spawned({});
    expect(runNpm(["install"], "/work/app", { platform: "linux", spawn })).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith("npm", ["install"], { cwd: "/work/app", stdio: "inherit" });
  });

  it("starts cmd.exe on Windows", () => {
    const spawn = spawned({});
    runNpm(["install"], "C:\\work\\app", { platform: "win32", env: { ComSpec: "cmd.exe" }, spawn });
    expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", "npm", "install"], {
      cwd: "C:\\work\\app",
      stdio: "inherit",
    });
  });

  it("reports a failed exit without throwing", () => {
    expect(runNpm(["install"], "/x", { platform: "linux", spawn: spawned({ status: 1 }) })).toEqual({ ok: false });
  });

  it("reports a program that could not start, with the reason", () => {
    const result = runNpm(["install"], "/x", {
      platform: "linux",
      spawn: spawned({ status: null, error: new Error("spawn npm ENOENT") }),
    });
    expect(result).toEqual({ ok: false, error: "spawn npm ENOENT" });
  });
});
