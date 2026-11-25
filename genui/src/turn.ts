/**
 * One turn of a conversation: ask the model, run the tools it asks for, ask
 * again, until it has nothing more to do or a tool needs the reader's say-so.
 *
 * The loop is here, not in a provider adapter, so every model gets the same
 * tool states, the same approval step, and the same stored message.
 */
import {
  invalidToolInput,
  partsOf,
  type ChatMessage,
  type MessagePart,
  type Model,
  type ModelRequest,
  type Tool,
  type ToolCall,
  type ToolPart,
} from "./model.ts";

/** What happens during a turn, in order. A tool part is sent again each time its state changes. */
export type TurnEvent =
  { type: "text"; delta: string } | { type: "tool"; part: ToolPart };

export interface TurnOptions {
  model: Model;
  system: string;
  /**
   * The conversation. When its last message is an assistant message that is
   * `awaiting: "model"`, the turn carries that message on: it runs the tool
   * calls the reader approved, then asks the model again.
   */
  messages: ChatMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
  /** How many times one turn may ask the model (default 8). */
  maxRounds?: number;
  /** Passed to the model with every request: how it reads an attached file. */
  readFile?: ModelRequest["readFile"];
}

export interface Turn {
  /**
   * The assistant message this turn writes. It is filled in as the events are
   * read, so it is worth storing even when the reader leaves halfway.
   */
  message: ChatMessage;
  events: AsyncGenerator<TurnEvent, void, undefined>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A client tool's result is the reader's text: it is kept to a sane length. */
const MAX_CLIENT_OUTPUT = 4000;

/** True for a call the reader, or their browser, still has to answer. */
const isWaiting = (part: MessagePart): part is ToolPart =>
  part.type === "tool" &&
  (part.state === "approval-requested" || part.state === "client-requested");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function runTurn(options: TurnOptions): Turn {
  const { model, system, tools = [], signal, maxRounds = 8 } = options;
  const history = [...options.messages];
  const last = history.at(-1);
  const resumed = last?.role === "assistant" && last.awaiting === "model";
  if (resumed) history.pop();
  const parts: MessagePart[] = resumed
    ? partsOf(last).map((part) => ({ ...part }))
    : [];
  const message: ChatMessage = { role: "assistant", content: "", parts };
  const taken = new Set(
    options.messages.flatMap((entry) =>
      partsOf(entry).flatMap((part) => (part.type === "tool" ? [part.id] : [])),
    ),
  );

  const settle = (): void => {
    message.content = parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
  };

  function* write(delta: string): Generator<TurnEvent> {
    const open = parts.at(-1);
    if (open?.type === "text") open.text += delta;
    else parts.push({ type: "text", text: delta });
    yield { type: "text", delta };
  }

  /** A model's call as a part: checked, and marked for approval when the tool asks for it. */
  const accept = (call: ToolCall): ToolPart => {
    let id = call.id && SAFE_ID.test(call.id) ? call.id : "";
    while (!id || taken.has(id)) id = `call_${crypto.randomUUID()}`;
    taken.add(id);
    const part: ToolPart = {
      type: "tool",
      id,
      name: call.name,
      input: isRecord(call.input) ? call.input : {},
      state: "running",
    };
    const tool = tools.find((candidate) => candidate.name === call.name);
    const invalid = tool
      ? invalidToolInput(tool.inputSchema, call.input)
      : `there is no tool named ${call.name}`;
    if (invalid || !tool) {
      part.state = "failed";
      part.error = `Invalid call: ${invalid}.`;
      return part;
    }
    const needsApproval =
      typeof tool.approval === "function"
        ? tool.approval(part.input)
        : tool.approval === true;
    if (tool.client) part.state = "client-requested";
    else if (needsApproval) part.state = "approval-requested";
    return part;
  };

  const run = async (part: ToolPart): Promise<void> => {
    const tool = tools.find((candidate) => candidate.name === part.name);
    try {
      if (!tool?.run) throw new Error(`There is no tool named ${part.name}.`);
      part.output = await tool.run(part.input, { signal });
      part.state = "done";
    } catch (error) {
      part.error = error instanceof Error ? error.message : "The tool failed.";
      part.state = "failed";
    }
  };

  /** Run the calls together; report each as running, then as it ended. */
  async function* runAll(calls: ToolPart[]): AsyncGenerator<TurnEvent> {
    for (const part of calls) {
      part.state = "running";
      yield { type: "tool", part: { ...part } };
    }
    await Promise.all(calls.map(run));
    for (const part of calls) yield { type: "tool", part: { ...part } };
  }

  async function* events(): AsyncGenerator<TurnEvent, void, undefined> {
    try {
      const approved = parts.filter(
        (part): part is ToolPart =>
          part.type === "tool" && part.state === "approved",
      );
      if (approved.length) yield* runAll(approved);

      for (let round = 0; ; round++) {
        if (signal?.aborted) return;
        if (round >= maxRounds) {
          yield* write("\n\nStopped: this reply needed too many tool calls.");
          return;
        }
        settle();
        const calls: ToolPart[] = [];
        const asked = model({
          system,
          messages: parts.length ? [...history, message] : history,
          tools,
          signal,
          ...(options.readFile ? { readFile: options.readFile } : {}),
        });
        for await (const event of asked) {
          if (typeof event === "string") yield* write(event);
          else calls.push(accept(event));
        }
        if (calls.length === 0) return;

        parts.push(...calls);
        const waiting = calls.filter(isWaiting);
        for (const part of calls) {
          if (part.state !== "running")
            yield { type: "tool", part: { ...part } };
        }
        yield* runAll(calls.filter((part) => part.state === "running"));
        if (waiting.length) {
          message.awaiting = "reader";
          return;
        }
      }
    } finally {
      // Also runs when the reader leaves: a call cut off never ran to its end.
      for (const part of parts) {
        if (part.type === "tool" && part.state === "running") {
          part.state = "failed";
          part.error = "Interrupted before it finished.";
        }
      }
      settle();
    }
  }

  return { message, events: events() };
}

/** The waiting call with this id in the conversation's open turn, if there is one. */
function waitingCall(
  messages: ChatMessage[],
  id: string,
  state: ToolPart["state"],
): { message: ChatMessage; part: ToolPart } | null {
  const message = messages.at(-1);
  if (message?.role !== "assistant" || message.awaiting !== "reader") {
    return null;
  }
  const part = message.parts?.find(
    (candidate): candidate is ToolPart =>
      candidate.type === "tool" &&
      candidate.id === id &&
      candidate.state === state,
  );
  return part ? { message, part } : null;
}

/** Once no call in the message is waiting, the model has to be asked again. */
const answered = (message: ChatMessage): void => {
  if (!message.parts!.some(isWaiting)) message.awaiting = "model";
};

/**
 * Record the reader's answer to a tool call that is waiting for approval.
 * Returns false when the conversation has no such call. Nothing runs here:
 * the next turn runs an approved call.
 */
export function decideToolCall(
  messages: ChatMessage[],
  id: string,
  approve: boolean,
): boolean {
  const found = waitingCall(messages, id, "approval-requested");
  if (!found) return false;
  found.part.state = approve ? "approved" : "denied";
  answered(found.message);
  return true;
}

/**
 * Record the result of a client tool call: what the reader's browser, or the
 * reader, sent. Returns false when the conversation has no such call. The
 * result is untrusted text, like anything a reader types.
 */
export function answerToolCall(
  messages: ChatMessage[],
  id: string,
  output: string,
): boolean {
  const found = waitingCall(messages, id, "client-requested");
  if (!found) return false;
  found.part.state = "done";
  found.part.output = output.slice(0, MAX_CLIENT_OUTPUT);
  answered(found.message);
  return true;
}

/**
 * The reader moved on without answering: every call that was waiting is
 * refused, so the model is told and nothing runs later.
 */
export function abandonToolCalls(messages: ChatMessage[]): void {
  const message = messages.at(-1);
  if (message?.awaiting !== "reader") return;
  for (const part of message.parts ?? []) {
    if (isWaiting(part)) part.state = "denied";
  }
  delete message.awaiting;
}

/** True when the page should stream: a new message to answer, or a turn to carry on. */
export const turnPending = (messages: readonly ChatMessage[]): boolean => {
  const last = messages.at(-1);
  return last?.role === "user" || last?.awaiting === "model";
};
