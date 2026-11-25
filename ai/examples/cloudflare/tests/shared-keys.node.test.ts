import { describe, expect, it } from "vitest";
import { sharedKeys } from "@bascik/ai";
import {
  UnknownKeyError,
  liveObjectName,
  parseSharedKey,
} from "../src/lib/shared-keys.ts";

const conversation = "77777777-7777-4777-8777-777777777777";

describe("shared keys", () => {
  const keys = sharedKeys("books");
  // Every builder @bascik/ai has: a new one fails here until the parser knows it.
  const built: Record<keyof typeof keys, string> = {
    lease: keys.lease(conversation),
    turn: keys.turn(conversation),
    stop: keys.stop(conversation, "turn-1"),
    reply: keys.reply(conversation, "turn-1"),
    voice: keys.voice(conversation),
    voiceOpen: keys.voiceOpen(conversation),
    voiceLock: keys.voiceLock(conversation),
    view: keys.view(conversation, "call-1"),
  };

  it("parses every key the chat builds to its conversation", () => {
    expect(Object.keys(built).sort()).toEqual(Object.keys(keys).sort());
    for (const [name, key] of Object.entries(built)) {
      expect(parseSharedKey(key), name).toMatchObject({
        chatId: "books",
        conversationId: conversation,
      });
      expect(liveObjectName(key, true), name).toBe(
        `live:books:${conversation}`,
      );
    }
  });

  it("keeps two conversations and two chats apart", () => {
    expect(liveObjectName(sharedKeys("books").lease("a"), true)).not.toBe(
      liveObjectName(sharedKeys("books").lease("b"), true),
    );
    expect(liveObjectName(sharedKeys("books").lease("a"), true)).not.toBe(
      liveObjectName(sharedKeys("docs").lease("a"), true),
    );
  });

  it("throws in development for a key it does not know, and spreads it in production", () => {
    for (const key of [
      "genui:books:mystery:x",
      "other:key",
      `genui:books:lease:${conversation}:a:b`,
      "genui:books:lease:../x",
    ]) {
      expect(() => liveObjectName(key, true), key).toThrow(UnknownKeyError);
    }
    const errors = console.error;
    console.error = () => {};
    try {
      expect(liveObjectName("other:key", false)).toMatch(/^live:misc:\d+$/);
    } finally {
      console.error = errors;
    }
  });
});
