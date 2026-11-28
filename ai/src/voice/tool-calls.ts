/**
 * Running one tool call a voice model made, on the server: checking and
 * recording it, waiting for approval, rendering `show` through the catalog,
 * and running the tool, in one step or in two around a lock.
 */
import type { Catalog } from "../catalog.ts";
import {
  invalidToolInput,
  type MessagePart,
  type Tool,
  type ToolPart,
} from "../model.ts";
import { renderToolPart, type TurnRenderOptions } from "../render-turn.ts";
import { renderText } from "../render.ts";
import { FILL_TOOL, SHOW_TOOL, voiceTools } from "./tools.ts";
import { roomFor, voiceCallId } from "./turn.ts";
import type {
  VoiceToolRequest,
  VoiceToolResult,
  VoiceToolStart,
  VoiceTurn,
} from "./types.ts";

/** The component tags a piece of markup uses, each once, in order of name. */
const componentsIn = (markup: string): string[] =>
  [
    ...new Set(
      [...markup.matchAll(/<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();

/**
 * The most characters of a tool's result the model is told. A relay drops a
 * longer result whole (Azure Voice Live's passes 200,000), and the model
 * would wait for an answer that never comes, so a long one is cut here.
 */
export const MAX_VOICE_TOOL_OUTPUT = 100_000;
const CUT_SHORT = "\n(The result was too long. This is the start of it.)";

/** How long a voice tool may run before the model is told it failed, unless the caller says. */
export const VOICE_TOOL_TIMEOUT_MS = 60_000;

/** `output`, cut to what a voice model is told. */
const told = (output: string): string =>
  output.length <= MAX_VOICE_TOOL_OUTPUT
    ? output
    : `${output.slice(0, MAX_VOICE_TOOL_OUTPUT - CUT_SHORT.length)}${CUT_SHORT}`;

const ALREADY_CALLED: VoiceToolResult = {
  state: "failed",
  output: "Error: already called.",
  html: "",
};

const TOO_MUCH: VoiceToolResult = {
  state: "failed",
  output:
    "Error: this turn holds too much. Finish what you are saying; the next turn can show more.",
  html: "",
};

/**
 * The first half of a voice tool call, done on the latest turn with no one
 * else changing it: the input is checked, the call is recorded, a call that
 * needs approval waits, and a decision claims the call it answers. A call
 * with an id the turn already holds is refused, and a decision about a call
 * that is not waiting does nothing, so a call runs at most once however many
 * requests arrive together. The ids of calls in turns already stored are
 * remembered too (the last `MAX_VOICE_CALL_IDS`), so a call sent again after
 * its turn was stored does not run a second time. `show` is rendered through the catalog like any
 * reply. A call to run comes back as `run`, for `finishVoiceTool`.
 */
export function startVoiceTool(
  turn: VoiceTurn,
  request: VoiceToolRequest,
  tools: readonly Tool[],
  catalog: Catalog,
  options: TurnRenderOptions = {},
): VoiceToolStart {
  // Normalized once, before anything looks it up.
  const id = voiceCallId(request.id);
  const offered = voiceTools(tools);
  const view = { ...options, tools: offered };

  if (request.name === FILL_TOOL) {
    // The form is in the reader's browser, which is where this is done.
    return {
      result: {
        state: "failed",
        output: "Error: a form is filled in by the reader's browser.",
        html: "",
      },
    };
  }
  if (request.name === SHOW_TOOL && !request.decision) {
    const markup =
      typeof request.input === "object" && request.input !== null
        ? (request.input as { markup?: unknown }).markup
        : undefined;
    if (typeof markup !== "string" || !markup.trim()) {
      return {
        result: {
          state: "failed",
          output: "Error: markup is required.",
          html: "",
        },
      };
    }
    // Stored as text, so a reload renders it through the same catalog.
    const shown: MessagePart = { type: "text", text: markup };
    if ((turn.calls ?? []).includes(id)) return { result: ALREADY_CALLED };
    if (!roomFor(turn, shown)) return { result: TOO_MUCH };
    turn.parts.push(shown);
    turn.calls = [...(turn.calls ?? []), id];
    // A reader who asks to "see it another way" often gets the same view
    // back. The model is told when a view repeats, and decides what that means.
    const view = componentsIn(markup);
    const repeated =
      view.length > 0 && view.join() === (turn.lastView ?? []).join();
    turn.lastView = view;
    return {
      result: {
        state: "done",
        output: repeated
          ? `Shown on the reader's screen. This view uses the same components as the one before it (${view.join(", ")}). If the reader asked to see it a different way, that was not a different way: call ${SHOW_TOOL} again now with other components from the catalog. If they asked for new content, carry on.`
          : "Shown on the reader's screen.",
        html: renderText(markup, catalog, options),
      },
    };
  }

  // A decision is about a call that is already waiting in this turn.
  let part = turn.parts.find(
    (candidate): candidate is ToolPart =>
      candidate.type === "tool" && candidate.id === id,
  );
  if (request.decision) {
    if (part?.state !== "approval-requested") {
      return {
        result: {
          state: "failed",
          output: "Error: nothing is waiting.",
          html: "",
        },
      };
    }
    // The claim: once the state moves on, no other decision finds it waiting.
    part.state = request.decision === "approve" ? "approved" : "denied";
  } else {
    if (part || (turn.calls ?? []).includes(id)) {
      return { result: ALREADY_CALLED };
    }
    const tool = offered.find((candidate) => candidate.name === request.name);
    const invalid = tool
      ? invalidToolInput(tool.inputSchema, request.input)
      : `there is no tool named ${request.name}`;
    part = {
      type: "tool",
      id,
      name: request.name,
      input:
        typeof request.input === "object" && request.input !== null
          ? (request.input as Record<string, unknown>)
          : {},
      state: "running",
    };
    if (!roomFor(turn, part)) return { result: TOO_MUCH };
    turn.parts.push(part);
    turn.calls = [...(turn.calls ?? []), id];
    if (invalid || !tool) {
      part.state = "failed";
      part.error = `Invalid call: ${invalid}.`;
    } else if (
      typeof tool.approval === "function"
        ? tool.approval(part.input)
        : tool.approval === true
    ) {
      part.state = "approval-requested";
      return {
        result: {
          state: part.state,
          html: renderToolPart(part, catalog, view),
        },
      };
    }
  }
  if (part.state === "running" || part.state === "approved") {
    return { run: part, round: turn.round ?? 0 };
  }
  return { result: voiceToolResult(part, catalog, view) };
}

function voiceToolResult(
  part: ToolPart,
  catalog: Catalog,
  view: TurnRenderOptions,
): VoiceToolResult {
  return {
    state: part.state,
    output: told(
      part.state === "done"
        ? (part.output ?? "")
        : part.state === "denied"
          ? "The reader declined this action. It was not done."
          : `Error: ${part.error ?? "the tool failed"}`,
    ),
    html: renderToolPart(part, catalog, view),
  };
}

/**
 * The second half of a voice tool call: run the call `startVoiceTool`
 * claimed, with no lock held, and change `part` to what came of it. Record
 * it with `settleVoiceTool`. A tool that has not answered after
 * `limits.timeoutMs` (default `VOICE_TOOL_TIMEOUT_MS`; 0 for no limit) is
 * recorded as failed and its `signal` is aborted, so the model is told and
 * the reader is not left waiting.
 */
export async function finishVoiceTool(
  part: ToolPart,
  tools: readonly Tool[],
  catalog: Catalog,
  options: TurnRenderOptions = {},
  limits: { timeoutMs?: number } = {},
): Promise<VoiceToolResult> {
  const { timeoutMs = VOICE_TOOL_TIMEOUT_MS } = limits;
  const offered = voiceTools(tools);
  const tool = offered.find((candidate) => candidate.name === part.name);
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!tool?.run) throw new Error(`There is no tool named ${part.name}.`);
    const late = new Promise<never>((_resolve, reject) => {
      if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return;
      timer = setTimeout(() => {
        stop.abort();
        reject(new Error("The tool took too long to answer."));
      }, timeoutMs);
    });
    part.output = await Promise.race([
      Promise.resolve(tool.run(part.input, { signal: stop.signal })),
      late,
    ]);
    part.state = "done";
  } catch (error) {
    part.error = error instanceof Error ? error.message : "The tool failed.";
    part.state = "failed";
  } finally {
    clearTimeout(timer);
  }
  return voiceToolResult(part, catalog, { ...options, tools: offered });
}

/**
 * Run one tool call a voice model made, and record it in the turn. This is
 * the server's side of a voice session: the input is checked, a tool that
 * needs approval waits for the reader, and `show` is rendered through the
 * catalog like any reply. A server whose calls can overlap uses
 * `startVoiceTool` under a lock, then `finishVoiceTool` and
 * `settleVoiceTool`, so a call runs at most once.
 */
export async function runVoiceTool(
  turn: VoiceTurn,
  request: VoiceToolRequest,
  tools: readonly Tool[],
  catalog: Catalog,
  options: TurnRenderOptions = {},
  limits: { timeoutMs?: number } = {},
): Promise<VoiceToolResult> {
  const started = startVoiceTool(turn, request, tools, catalog, options);
  if (!started.run) return started.result!;
  // The part is the turn's own, so finishing it records it.
  return finishVoiceTool(started.run, tools, catalog, options, limits);
}
