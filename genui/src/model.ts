/**
 * A message is its parts. A reply is not one string: it is text the model
 * wrote, and tool calls that each have a state. Parts are what is stored,
 * what a model is shown again, and what the page renders, so a tool call
 * looks the same while it runs, after a reload, and to the model.
 */
export interface TextPart {
  type: "text";
  /** Model output in the reply format: prose, catalog tags, fences. */
  text: string;
  /**
   * True for words a voice model spoke, as transcribed. They are shown as
   * plain text, never read as the reply format: speech has no markup, and a
   * transcript that looks like a tag is still only something that was said.
   */
  spoken?: boolean;
}

/**
 * Where a tool call is:
 * - `approval-requested`: waiting for the reader to allow or refuse it
 * - `client-requested`: a client tool, waiting for the reader's browser (or
 *   the reader) to send its result
 * - `approved`: allowed, not run yet (the next turn runs it)
 * - `denied`: refused; the model is told so
 * - `running`: only while a reply streams, never stored
 * - `done` and `failed`: it ran, and `output` or `error` says how it went
 */
export type ToolState =
  | "approval-requested"
  | "client-requested"
  | "approved"
  | "denied"
  | "running"
  | "done"
  | "failed";

export interface ToolPart {
  type: "tool";
  /** Unique in the conversation. Letters, digits, `_` and `-` only. */
  id: string;
  name: string;
  input: Record<string, unknown>;
  state: ToolState;
  /** What the tool returned, as the model reads it. */
  output?: string;
  /** Why it failed, as the model reads it. */
  error?: string;
}

export type MessagePart = TextPart | ToolPart;

export interface ChatMessage {
  role: "user" | "assistant";
  /** The message as plain text: for an assistant message, its text parts joined. */
  content: string;
  /** An assistant message's parts, in order. Absent on a message that is only text. */
  parts?: MessagePart[];
  /**
   * Set on an assistant message whose turn is not over: `reader` while a
   * tool call waits for the reader (an approval, or a client tool's result), `model` once every call is answered and
   * the model has to be asked again.
   */
  awaiting?: "reader" | "model";
}

/** The parts of a message, whether or not it was stored with any. */
export const partsOf = (message: ChatMessage): MessagePart[] =>
  message.parts ??
  (message.content ? [{ type: "text", text: message.content }] : []);

/** What the model is told a tool call came to. */
export function toolResult(part: ToolPart): { text: string; failed: boolean } {
  switch (part.state) {
    case "done":
      return { text: part.output ?? "", failed: false };
    case "failed":
      return { text: part.error ?? "The tool failed.", failed: true };
    case "denied":
      return { text: "The reader declined this action.", failed: true };
    default:
      return { text: "The action was never confirmed.", failed: true };
  }
}

/**
 * An assistant message as the rounds a model produced it in: some text, then
 * the tool calls made after it. A provider adapter turns each round into its
 * own message shape (the text and calls from the assistant, then the results).
 */
export interface Round {
  text: string;
  calls: ToolPart[];
}

export function roundsOf(parts: readonly MessagePart[]): Round[] {
  const rounds: Round[] = [];
  let round: Round | undefined;
  for (const part of parts) {
    if (part.type === "text") {
      if (!round || round.calls.length) {
        round = { text: "", calls: [] };
        rounds.push(round);
      }
      round.text += part.text;
    } else {
      if (!round) {
        round = { text: "", calls: [] };
        rounds.push(round);
      }
      round.calls.push(part);
    }
  }
  return rounds;
}

/** A JSON Schema for a tool's input: an object of named values. */
export type ToolInputSchema = {
  type: "object";
  properties: Record<
    string,
    { type: "string" | "number" | "integer" | "boolean"; description?: string }
  >;
  required?: string[];
};

/**
 * Something the model can call to get data before it writes. `run` returns
 * text for the model to read, usually JSON. A thrown error is reported to the
 * model as a failed call, so it can try something else.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  run?(
    input: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ): Promise<string> | string;
  /**
   * True for a tool the reader's side answers, such as their local time or
   * a choice only they can make. It has no `run`: the reply stops at the
   * call, the app draws it as a form, and the form's post is the result. A
   * script may fill the form in and send it; without scripts the reader does.
   */
  client?: boolean;
  /**
   * Text that stands for the call in the reply, in the model's own output
   * format, so the reader sees what is happening. For example a catalog tag.
   */
  note?(input: Record<string, unknown>): string;
  /**
   * True when the reader has to allow the call before it runs: anything that
   * changes something. The reply stops at the call and shows the question.
   */
  approval?: boolean | ((input: Record<string, unknown>) => boolean);
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
}

/**
 * Check a tool input the model wrote against the tool's schema. Returns what
 * is wrong, or null. Model output is untrusted: a tool never runs on input
 * that fails this.
 */
export function invalidToolInput(
  schema: ToolInputSchema,
  input: unknown,
): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "input must be an object";
  }
  const values = input as Record<string, unknown>;
  for (const name of schema.required ?? []) {
    if (values[name] === undefined) return `missing "${name}"`;
  }
  for (const [name, value] of Object.entries(values)) {
    const property = schema.properties[name];
    if (!property) return `unknown property "${name}"`;
    const ok =
      property.type === "integer"
        ? Number.isInteger(value)
        : property.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === property.type;
    if (!ok) return `"${name}" must be a ${property.type}`;
  }
  return null;
}

/** A model asking for a tool to be run. The id is the provider's, when it has one. */
export interface ToolCall {
  type: "tool-call";
  id?: string;
  name: string;
  input: unknown;
}

/** What a model sends: slices of text, and tool calls. */
export type ModelEvent = string | ToolCall;

/**
 * One round of a model: it reads the conversation, writes, and may ask for
 * tools. It never runs a tool itself; `runTurn` does, and asks again. A model
 * that needs no tools can simply yield text.
 */
export type Model = (request: ModelRequest) => AsyncIterable<ModelEvent>;

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * A model that needs no API key: it streams what `reply` returns, text a few
 * characters at a time and tool calls whole. For demos, tests, and working on
 * the UI offline.
 */
export function scriptedModel(
  reply: (request: ModelRequest) => string | ModelEvent[],
  options: { chunkSize?: number; delayMs?: number } = {},
): Model {
  const { chunkSize = 7, delayMs = 12 } = options;
  return async function* (request) {
    const written = reply(request);
    for (const event of typeof written === "string" ? [written] : written) {
      if (typeof event !== "string") {
        if (request.signal?.aborted) return;
        yield event;
        continue;
      }
      for (let at = 0; at < event.length; at += chunkSize) {
        if (request.signal?.aborted) return;
        if (delayMs > 0) await wait(delayMs, request.signal);
        yield event.slice(at, at + chunkSize);
      }
    }
  };
}
