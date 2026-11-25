import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicModel, toMessageParams } from "./anthropic.ts";
import type { ChatMessage, ModelEvent } from "./model.ts";

const history: ChatMessage[] = [
  { role: "user", content: "Hold Dune" },
  {
    role: "assistant",
    content: "Checking.\nHeld.",
    parts: [
      { type: "text", text: "Checking." },
      {
        type: "tool",
        id: "toolu_a",
        name: "look_up",
        input: { title: "Dune" },
        state: "done",
        output: "In stock",
      },
      {
        type: "tool",
        id: "toolu_b",
        name: "place_hold",
        input: { title: "Dune" },
        state: "denied",
      },
      { type: "text", text: "Held." },
    ],
  },
  { role: "user", content: "Thanks" },
  { role: "assistant", content: "Any time." },
];

describe("toMessageParams", () => {
  it("writes each round as the assistant's calls, then their results", () => {
    expect(toMessageParams(history)).toEqual([
      { role: "user", content: "Hold Dune" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool_use",
            id: "toolu_a",
            name: "look_up",
            input: { title: "Dune" },
          },
          {
            type: "tool_use",
            id: "toolu_b",
            name: "place_hold",
            input: { title: "Dune" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "In stock" },
          {
            type: "tool_result",
            tool_use_id: "toolu_b",
            content: "The reader declined this action.",
            is_error: true,
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Held." }] },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "Any time." },
    ]);
  });
});

/** A client that answers every request with one scripted message. */
function fakeClient(message: Record<string, unknown>, deltas: string[]) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(request: Record<string, unknown>) {
          requests.push(structuredClone(request));
          return {
            async *[Symbol.asyncIterator]() {
              for (const text of deltas) {
                yield {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text },
                };
              }
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const collect = async (events: AsyncIterable<ModelEvent>) => {
  const all: ModelEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
};

describe("anthropicModel", () => {
  it("streams the text of one round, then yields its tool calls without running them", async () => {
    const thinking = { type: "thinking", thinking: "…", signature: "sig" };
    const use = {
      type: "tool_use",
      id: "toolu_new",
      name: "look_up",
      input: { title: "Dune" },
    };
    const { client, requests } = fakeClient(
      { stop_reason: "tool_use", content: [thinking, use] },
      ["Check", "ing."],
    );
    const model = anthropicModel({ client });
    expect(
      await collect(
        model({ system: "s", messages: [{ role: "user", content: "Hi" }] }),
      ),
    ).toEqual([
      "Check",
      "ing.",
      { type: "tool-call", id: "toolu_new", name: "look_up", input: use.input },
    ]);
    expect(requests).toHaveLength(1);

    // The next round sends that round back as it was received, with the
    // blocks the parts do not keep.
    await collect(
      model({
        system: "s",
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: "Checking.",
            parts: [
              { type: "text", text: "Checking." },
              {
                type: "tool",
                id: "toolu_new",
                name: "look_up",
                input: use.input,
                state: "done",
                output: "In stock",
              },
            ],
          },
        ],
      }),
    );
    const sent = requests[1]!.messages as { role: string; content: unknown }[];
    expect(sent[1]).toEqual({ role: "assistant", content: [thinking, use] });
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_new", content: "In stock" },
      ],
    });
  });

  it("never yields a call from a reply that was cut off or refused", async () => {
    const use = { type: "tool_use", id: "toolu_x", name: "look_up", input: {} };
    for (const stop_reason of ["max_tokens", "refusal"]) {
      const { client } = fakeClient({ stop_reason, content: [use] }, []);
      const events = await collect(
        anthropicModel({ client })({ system: "", messages: [] }),
      );
      expect(events.every((event) => typeof event === "string")).toBe(true);
      expect(events).toHaveLength(1);
    }
  });
});
