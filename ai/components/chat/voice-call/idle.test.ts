import { describe, expect, test } from "vitest";
import {
  ALIVE_EVERY_MS,
  aliveDue,
  IDLE_SECONDS,
  IDLE_WARNING_SECONDS,
  idleLimits,
  idlePhase,
} from "./idle.ts";

describe("idleLimits", () => {
  test("uses the defaults when nothing is set", () => {
    expect(idleLimits({})).toEqual({
      idleMs: IDLE_SECONDS * 1000,
      warningMs: IDLE_WARNING_SECONDS * 1000,
    });
  });

  test("reads seconds, and parts of one", () => {
    expect(idleLimits({ idleSeconds: "2", idleWarningSeconds: "1.5" })).toEqual(
      { idleMs: 2000, warningMs: 1500 },
    );
  });

  test("0 is kept: it turns the limit off", () => {
    expect(idleLimits({ idleSeconds: "0" }).idleMs).toBe(0);
  });

  test.each(["", " ", "soon", "-5", "NaN", "Infinity"])(
    "falls back to the default for %j",
    (value) => {
      expect(
        idleLimits({ idleSeconds: value, idleWarningSeconds: value }),
      ).toEqual(idleLimits({}));
    },
  );
});

describe("aliveDue", () => {
  test("is due once the time between two tellings has passed, and not before", () => {
    expect(ALIVE_EVERY_MS).toBe(20_000);
    expect(aliveDue(5000, 5000)).toBe(false);
    expect(aliveDue(5000 + ALIVE_EVERY_MS - 1, 5000)).toBe(false);
    expect(aliveDue(5000 + ALIVE_EVERY_MS, 5000)).toBe(true);
  });

  test("is due at once for a call that has never told", () => {
    expect(aliveDue(0, -Infinity)).toBe(true);
  });
});

describe("idlePhase", () => {
  const limits = { idleMs: 2000, warningMs: 1000 };

  test("is active until nobody has spoken for the limit", () => {
    expect(idlePhase(1000, 1000, limits)).toBe("active");
    expect(idlePhase(2999, 1000, limits)).toBe("active");
  });

  test("asks, for as long as the warning lasts", () => {
    expect(idlePhase(3000, 1000, limits)).toBe("warning");
    expect(idlePhase(3999, 1000, limits)).toBe("warning");
  });

  test("is over after that", () => {
    expect(idlePhase(4000, 1000, limits)).toBe("over");
    expect(idlePhase(1e9, 1000, limits)).toBe("over");
  });

  test("never asks or ends with a limit of 0", () => {
    expect(idlePhase(1e9, 0, { idleMs: 0, warningMs: 1000 })).toBe("active");
  });
});
