import { describe, expect, test } from "vitest";
import { answerTool, runTool, toolFields } from "./tools.ts";
import type { ToolDeps } from "./tools.ts";
import type { ToolAnswer } from "./types.ts";

const tool = { id: "t1", name: "find_book", args: { title: "Kindred" } };

/** Deps that answer from `answers` in turn and record what was asked. */
function deps(answers: ToolAnswer[], decision: string | null = "allow") {
  const asked: Record<string, string>[] = [];
  const log: string[] = [];
  const value: ToolDeps = {
    ask: async (fields) => {
      asked.push(fields);
      return answers.shift()!;
    },
    wait: (id) => {
      log.push(`wait ${id}`);
      return decision === null ? null : Promise.resolve(decision);
    },
    done: (id) => log.push(`done ${id}`),
  };
  return { value, asked, log };
}

describe("toolFields", () => {
  test("posts the call's id, name and arguments as JSON", () => {
    expect(toolFields(tool)).toEqual({
      id: "t1",
      name: "find_book",
      input: '{"title":"Kindred"}',
    });
    expect(toolFields({ ...tool, args: undefined }).input).toBe("{}");
  });
});

describe("runTool", () => {
  test("gives the server's output", async () => {
    const { value, asked } = deps([
      { state: "output-available", output: "Found it", view: false },
    ]);
    expect(await runTool(tool, value)).toBe("Found it");
    expect(asked).toHaveLength(1);
  });

  test("gives nothing when the server has no output", async () => {
    const { value } = deps([{ state: "output-error", view: false }]);
    expect(await runTool(tool, value)).toBe("");
  });

  test("asks again with the reader's decision when approval is needed", async () => {
    const { value, asked, log } = deps([
      { state: "approval-requested", view: true },
      { state: "output-available", output: "Ordered", view: false },
    ]);
    expect(await runTool(tool, value)).toBe("Ordered");
    expect(log).toEqual(["wait t1", "done t1"]);
    expect(asked[1]).toEqual({ ...toolFields(tool), decision: "allow" });
  });

  test("does not wait when there is no call to wait in", async () => {
    const { value, asked } = deps(
      [{ state: "approval-requested", view: false }],
      null,
    );
    expect(await runTool(tool, value)).toBe("");
    expect(asked).toHaveLength(1);
  });
});

describe("answerTool", () => {
  const route = {
    fillForm: async () => "filled",
    runTool: async (call: { id: string }) => `ran ${call.id}`,
  };

  test("refuses a call with no id", async () => {
    for (const id of [undefined, "", 7]) {
      expect(await answerTool({ id, name: "x", args: {} }, route)).toBe(
        "Error: the tool call has no id.",
      );
    }
  });

  test("fills forms in the page, and runs other tools on the server", async () => {
    expect(
      await answerTool({ id: "a", name: "fill_form", args: {} }, route),
    ).toBe("filled");
    expect(
      await answerTool({ id: "b", name: "find_book", args: {} }, route),
    ).toBe("ran b");
  });

  test("a tool that fails tells the model so", async () => {
    const failing = {
      fillForm: async () => {
        throw new Error("no");
      },
      runTool: async () => {
        throw new Error("no");
      },
    };
    expect(
      await answerTool({ id: "a", name: "fill_form", args: {} }, failing),
    ).toBe("Error: the tool could not be run.");
    expect(await answerTool({ id: "b", name: "x", args: {} }, failing)).toBe(
      "Error: the tool could not be run.",
    );
  });
});
