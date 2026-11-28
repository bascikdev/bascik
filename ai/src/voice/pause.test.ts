import { describe, expect, it } from "vitest";
import { PAUSE_MS, pauseMsOf, turnSettingsOf } from "./pause.ts";

describe("pauseMsOf", () => {
  it("is the default when none is given, and a whole number within its range", () => {
    expect(pauseMsOf(undefined)).toBe(PAUSE_MS);
    expect(pauseMsOf(650.4)).toBe(650);
    expect(pauseMsOf(0)).toBe(200);
    expect(pauseMsOf(60_000)).toBe(3000);
  });

  it("tells the developer of a pause that is not a number", () => {
    expect(() => pauseMsOf(Number.NaN)).toThrow(TypeError);
    expect(() => pauseMsOf(Infinity)).toThrow(/pauseMs/);
  });
});

describe("turnSettingsOf", () => {
  it("passes an object of settings, and nothing as nothing", () => {
    const given = { threshold: 0.4 };
    expect(turnSettingsOf("turnDetection", given)).toBe(given);
    expect(turnSettingsOf("turnDetection", undefined)).toBeUndefined();
  });

  it("tells the developer, by the option's name, of anything else", () => {
    for (const given of [null, [], ["server_vad"], "server_vad", 5, true]) {
      expect(() => turnSettingsOf("realtimeInput", given)).toThrow(
        new TypeError("realtimeInput must be an object."),
      );
    }
  });
});
