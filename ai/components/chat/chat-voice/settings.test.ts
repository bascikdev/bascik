import { describe, expect, test } from "vitest";
import { aidsLabel, isActive, loadSettings, saveSettings } from "./settings.ts";

const defaults = { captions: false, aloud: false, talk: false, speed: "1" };

describe("loadSettings", () => {
  test("starts from the defaults", () => {
    expect(loadSettings(() => null, true)).toEqual(defaults);
  });

  test("keeps what was stored, except listening, which starts off", () => {
    const stored = JSON.stringify({
      captions: true,
      aloud: true,
      talk: true,
      speed: "1.5",
    });
    expect(loadSettings(() => stored, true)).toEqual({
      captions: true,
      aloud: true,
      talk: false,
      speed: "1.5",
    });
  });

  test("turns reading aloud off in a browser that cannot speak", () => {
    expect(loadSettings(() => '{"aloud":true}', false).aloud).toBe(false);
  });

  test("falls back to the defaults when storage throws or holds no JSON", () => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    expect(loadSettings(blocked, true)).toEqual(defaults);
    expect(loadSettings(() => "not json", true)).toEqual(defaults);
  });
});

describe("saveSettings", () => {
  test("writes the settings as JSON", () => {
    let written = "";
    saveSettings((value) => (written = value), { ...defaults, captions: true });
    expect(JSON.parse(written)).toEqual({ ...defaults, captions: true });
  });

  test("a write that throws is not an error", () => {
    expect(() =>
      saveSettings(() => {
        throw new Error("QuotaExceeded");
      }, defaults),
    ).not.toThrow();
  });
});

describe("isActive and aidsLabel", () => {
  test("is active with captions or reading aloud on", () => {
    expect(isActive(defaults)).toBe(false);
    expect(isActive({ ...defaults, captions: true })).toBe(true);
    expect(isActive({ ...defaults, aloud: true })).toBe(true);
    expect(isActive({ ...defaults, talk: true })).toBe(false);
  });

  test("names what is on", () => {
    expect(aidsLabel(defaults)).toEqual({ name: "Reading aids", on: false });
    expect(aidsLabel({ ...defaults, captions: true, talk: true })).toEqual({
      name: "Reading aids: captions, dictate",
      on: true,
    });
    expect(
      aidsLabel({ captions: true, aloud: true, talk: true, speed: "1" }).name,
    ).toBe("Reading aids: captions, read aloud, dictate");
  });
});
