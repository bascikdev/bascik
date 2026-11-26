import { describe, expect, it } from "vitest";
import type { MessagePart } from "../model.ts";
import {
  MAX_VOICE_PARTS,
  MAX_VOICE_TURN_CHARS,
  newVoiceTurn,
  roomFor,
} from "./turn.ts";

const shown = (text: string): MessagePart => ({ type: "text", text });

describe("roomFor", () => {
  it("has room in a new turn", () => {
    expect(roomFor(newVoiceTurn(), shown("<book-card title=Dune />"))).toBe(
      true,
    );
  });

  it("has no room once the turn holds MAX_VOICE_PARTS parts", () => {
    const turn = newVoiceTurn();
    for (let at = 0; at < MAX_VOICE_PARTS - 1; at++) turn.parts.push(shown(""));
    expect(roomFor(turn, shown(""))).toBe(true);
    turn.parts.push(shown(""));
    expect(roomFor(turn, shown(""))).toBe(false);
  });

  it("counts the turn and the new part as JSON against MAX_VOICE_TURN_CHARS", () => {
    const turn = newVoiceTurn();
    turn.parts.push(shown("x".repeat(MAX_VOICE_TURN_CHARS / 2)));
    // `[`, `]`, and the part's JSON wrapper take the rest of the room.
    expect(roomFor(turn, shown("y".repeat(1_000)))).toBe(true);
    expect(roomFor(turn, shown("y".repeat(MAX_VOICE_TURN_CHARS / 2)))).toBe(
      false,
    );
  });
});
