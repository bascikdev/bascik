import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../model.ts";
import type { Conversation } from "../store.ts";
import { applyChanges } from "./merge.ts";

const conversation = (
  messages: ChatMessage[],
  extra: Record<string, unknown> = {},
): Conversation =>
  ({
    id: "c1",
    title: "Books",
    updatedAt: 1,
    messages,
    ...extra,
  }) as Conversation;

const said = (content: string): ChatMessage => ({ role: "user", content });

describe("applyChanges", () => {
  it("takes the stored messages when the caller changed none", () => {
    const base = conversation([said("Recommend a novel")]);
    const ours = conversation([said("Recommend a novel")]);
    const latest = conversation([
      said("Recommend a novel"),
      { role: "assistant", content: "Try Dune by Frank Herbert." },
    ]);
    expect(applyChanges(ours, base, latest).messages).toEqual(latest.messages);
  });

  it("puts the caller's added messages after the ones stored since", () => {
    const base = conversation([said("Recommend a novel")]);
    const ours = conversation([said("Recommend a novel"), said("Ours")]);
    const latest = conversation([said("Recommend a novel"), said("Stored")]);
    expect(applyChanges(ours, base, latest).messages).toEqual([
      said("Recommend a novel"),
      said("Stored"),
      said("Ours"),
    ]);
  });

  it("refuses when both sides changed the same messages", () => {
    const base = conversation([said("Recommend a novel")]);
    const ours = conversation([said("Recommend a poem")]);
    const latest = conversation([said("Recommend a play")]);
    expect(() => applyChanges(ours, base, latest)).toThrow(
      /changed by another write/,
    );
  });

  it("keeps a field the caller changed and takes the rest from the store", () => {
    const base = conversation([]);
    const ours = conversation([], { title: "Dune" });
    const latest = conversation([], { title: "Stored title", pinned: true });
    const merged = applyChanges(ours, base, latest) as Conversation & {
      pinned?: boolean;
    };
    expect(merged.title).toBe("Dune");
    expect(merged.pinned).toBe(true);
  });

  it("drops a field the store removed and the caller left alone", () => {
    const base = conversation([], { pinned: true });
    const ours = conversation([], { pinned: true });
    const latest = conversation([]);
    expect("pinned" in applyChanges(ours, base, latest)).toBe(false);
  });

  it("leaves the caller's conversation as it was, so a failed save can retry", () => {
    const base = conversation([said("Recommend a novel")]);
    const ours = conversation([said("Recommend a novel"), said("Ours")]);
    const latest = conversation([said("Recommend a novel"), said("Stored")]);
    const before = JSON.stringify(ours);
    const merged = applyChanges(ours, base, latest);
    expect(JSON.stringify(ours)).toBe(before);
    expect(merged).not.toBe(ours);
    expect(merged.messages).not.toBe(latest.messages);
  });
});
