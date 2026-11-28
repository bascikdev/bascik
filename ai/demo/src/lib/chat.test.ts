import { describe, expect, it } from "vitest";
import { pauseFrom, settingsFrom } from "./chat.ts";

describe("pauseFrom", () => {
  it("reads a number of milliseconds, and nothing from a variable left empty", () => {
    expect(pauseFrom("VOICE_PAUSE_MS", "1200")).toBe(1200);
    expect(pauseFrom("VOICE_PAUSE_MS", " 650 ")).toBe(650);
    expect(pauseFrom("VOICE_PAUSE_MS", undefined)).toBeUndefined();
    expect(pauseFrom("VOICE_PAUSE_MS", "")).toBeUndefined();
    expect(pauseFrom("VOICE_PAUSE_MS", " ")).toBeUndefined();
  });

  it("names the variable when its value is not a number", () => {
    for (const value of ["800ms", "1,200", "soon", "Infinity"]) {
      expect(() => pauseFrom("VOICE_PAUSE_MS", value)).toThrow(
        "VOICE_PAUSE_MS must be a number of milliseconds.",
      );
    }
  });
});

describe("settingsFrom", () => {
  it("reads a JSON object, and nothing from a variable left empty", () => {
    expect(settingsFrom("SETTINGS", '{"threshold":0.4}')).toEqual({
      threshold: 0.4,
    });
    expect(settingsFrom("SETTINGS", undefined)).toBeUndefined();
    expect(settingsFrom("SETTINGS", "")).toBeUndefined();
  });

  it("names the variable when its value is not a JSON object", () => {
    for (const value of ['["server_vad"]', "[]", "null", "5", '"x"', "{"]) {
      expect(() => settingsFrom("SETTINGS", value)).toThrow(
        "SETTINGS must be a JSON object.",
      );
    }
  });
});
