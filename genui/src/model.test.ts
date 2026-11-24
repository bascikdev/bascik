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
  it("streams the reply in slices and stops when the request is aborted", async () => {
    const model = scriptedModel(() => "abcdefghij", {
      chunkSize: 3,
      delayMs: 0,
    });
    const slices: string[] = [];
    for await (const slice of model({ system: "", messages: [] }))
      slices.push(slice);
    expect(slices).toEqual(["abc", "def", "ghi", "j"]);

    const controller = new AbortController();
    const stopped: string[] = [];
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
