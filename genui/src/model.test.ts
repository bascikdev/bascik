import { describe, expect, it } from "vitest";
import {
  invalidToolInput,
  scriptedModel,
  type ToolInputSchema,
} from "./model.ts";

const schema: ToolInputSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "integer" },
    exact: { type: "boolean" },
  },
  required: ["query"],
};

describe("invalidToolInput", () => {
  it("accepts input that matches the schema", () => {
    expect(invalidToolInput(schema, { query: "a" })).toBeNull();
    expect(
      invalidToolInput(schema, { query: "a", limit: 3, exact: false }),
    ).toBeNull();
  });

  it("names what is wrong with input a model got wrong", () => {
    expect(invalidToolInput(schema, {})).toBe('missing "query"');
    expect(invalidToolInput(schema, { query: 1 })).toBe(
      '"query" must be a string',
    );
    expect(invalidToolInput(schema, { query: "a", limit: 1.5 })).toBe(
      '"limit" must be a integer',
    );
    expect(invalidToolInput(schema, { query: "a", extra: 1 })).toBe(
      'unknown property "extra"',
    );
    expect(invalidToolInput(schema, null)).toBe("input must be an object");
    expect(invalidToolInput(schema, ["a"])).toBe("input must be an object");
    expect(invalidToolInput(schema, "query")).toBe("input must be an object");
  });
});

describe("scriptedModel", () => {
  it("streams text in slices and tool calls whole, in the order written", async () => {
    const call = { type: "tool-call" as const, name: "look_up", input: {} };
    const model = scriptedModel(() => ["abcd", call, "ef"], {
      chunkSize: 3,
      delayMs: 0,
    });
    const events: unknown[] = [];
    for await (const event of model({ system: "", messages: [] }))
      events.push(event);
    expect(events).toEqual(["abc", "d", call, "ef"]);
  });

  it("streams the reply in slices and stops when the request is aborted", async () => {
    const model = scriptedModel(() => "abcdefghij", {
      chunkSize: 3,
      delayMs: 0,
    });
    const slices: unknown[] = [];
    for await (const slice of model({ system: "", messages: [] }))
      slices.push(slice);
    expect(slices).toEqual(["abc", "def", "ghi", "j"]);

    const controller = new AbortController();
    const stopped: unknown[] = [];
    for await (const slice of model({
      system: "",
      messages: [],
      signal: controller.signal,
    })) {
      stopped.push(slice);
      controller.abort();
    }
    expect(stopped).toEqual(["abc"]);
  });
});
