/*
 * Tool calls during a voice call: the model asks, the server runs the tool,
 * and the reader approves what needs approving on screen. The component
 * gives the requests and the waiting; these functions decide the order.
 */

import type { ToolAnswer, ToolRequest } from "./types.ts";

/** A tool call whose id has been checked. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** What running one tool call needs from the component. */
export interface ToolDeps {
  /** Ask the server, with these fields added to the call's own. */
  ask(fields: Record<string, string>): Promise<ToolAnswer>;
  /** Wait for the reader's decision on screen; null when no call is on. */
  wait(id: string): Promise<string> | null;
  /** The decision has been made: stop waiting for it. */
  done(id: string): void;
}

/** The form fields that describe a tool call to /api/voice-tool. */
export const toolFields = (tool: ToolCall): Record<string, string> => ({
  id: tool.id,
  name: tool.name,
  input: JSON.stringify(tool.args ?? {}),
});

/**
 * Run a tool call on the server. One that asks for approval waits for the
 * reader's decision, and is asked again with it. Gives what the model is told.
 */
export async function runTool(tool: ToolCall, deps: ToolDeps): Promise<string> {
  const fields = toolFields(tool);
  let answer = await deps.ask(fields);
  if (answer.state === "approval-requested") {
    const waiting = deps.wait(tool.id);
    if (waiting) {
      const decision = await waiting;
      deps.done(tool.id);
      answer = await deps.ask({ ...fields, decision });
    }
  }
  return answer.output ?? "";
}

/**
 * Answer a provider's tool call: fill_form is done in the page, any other
 * tool on the server. A call with no id cannot be matched to its answer or
 * its approval: it is refused here, and never posted as "undefined".
 */
export function answerTool(
  tool: ToolRequest,
  deps: {
    fillForm(args: unknown): Promise<string>;
    runTool(tool: ToolCall): Promise<string>;
  },
): Promise<string> {
  const id = tool.id;
  if (typeof id !== "string" || !id) {
    return Promise.resolve("Error: the tool call has no id.");
  }
  // Run the dep inside the promise chain, so one that throws before it
  // returns a promise is told to the model like one that rejects.
  return Promise.resolve()
    .then(() =>
      tool.name === "fill_form"
        ? deps.fillForm(tool.args)
        : deps.runTool({ ...tool, id }),
    )
    .catch(() => "Error: the tool could not be run.");
}
