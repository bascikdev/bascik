/** The one thing the renderer needs from a model: its reply as slices of text. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
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
  run(
    input: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ): Promise<string> | string;
  /**
   * Text to put in the reply while the tool runs, in the model's own output
   * format, so the reader sees progress. For example a catalog tag.
   */
  note?(input: Record<string, unknown>): string;
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

export type Model = (request: ModelRequest) => AsyncIterable<string>;

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
 * A model that needs no API key: it streams the text `reply` returns, a few
 * characters at a time. For demos, tests, and working on the UI offline.
 */
export function scriptedModel(
  reply: (request: ModelRequest) => string,
  options: { chunkSize?: number; delayMs?: number } = {},
): Model {
  const { chunkSize = 7, delayMs = 12 } = options;
  return async function* (request) {
    const text = reply(request);
    for (let at = 0; at < text.length; at += chunkSize) {
      if (request.signal?.aborted) return;
      if (delayMs > 0) await wait(delayMs, request.signal);
      yield text.slice(at, at + chunkSize);
    }
  };
}
