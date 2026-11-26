import { describe, expect, test } from "vitest";
import {
  closeReason,
  providerLabel,
  sessionFailure,
  statusText,
  toggleLabel,
} from "./status.ts";

describe("statusText", () => {
  const idle = {
    waiting: new Map<string, (decision: string) => void>(),
    working: 0,
    thinking: false,
    hearing: false,
    base: "Listening.",
  };

  test("says the base line when nothing else is going on", () => {
    expect(statusText(idle)).toBe("Listening.");
  });

  test("puts the most pressing first", () => {
    const all = {
      ...idle,
      waiting: new Map([["1", () => {}]]),
      working: 1,
      thinking: true,
      hearing: true,
    };
    expect(statusText(all)).toBe("Waiting for your answer on screen.");
    expect(statusText({ ...all, waiting: new Map() })).toBe("Working…");
    expect(statusText({ ...all, waiting: new Map(), working: 0 })).toBe(
      "Thinking…",
    );
    expect(statusText({ ...idle, hearing: true })).toBe("Hearing you…");
  });
});

describe("labels", () => {
  test("names the provider from the ticket's label, or its protocol", () => {
    expect(providerLabel({ protocol: "gemini-live" })).toBe("Gemini Live");
    expect(providerLabel({ protocol: "azure-voice-live" })).toBe(
      "Azure Voice Live",
    );
    expect(
      providerLabel({ protocol: "gemini-live", label: "Books line" }),
    ).toBe("Books line");
    expect(providerLabel({ protocol: "other" })).toBe("");
  });

  test("says why a call could not start", () => {
    expect(sessionFailure(404)).toBe("Voice is not set up on this server.");
    expect(sessionFailure(502)).toBe("The voice service did not answer.");
  });

  test("names the button for what pressing it does", () => {
    expect(toggleLabel(true)).toBe("End call");
    expect(toggleLabel(false)).toBe("Voice call");
  });

  test("keeps a hang-up reason short, with a default", () => {
    expect(closeReason("")).toBe("The call ended.");
    expect(closeReason("Quota used up")).toBe("Quota used up");
    expect(closeReason("x".repeat(200))).toHaveLength(160);
  });
});
