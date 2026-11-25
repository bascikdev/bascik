/**
 * A `Model` backed by any server that speaks the OpenAI chat completions
 * API: Ollama, LM Studio, llama.cpp, vLLM, a gateway, or OpenAI itself. It
 * uses `fetch` and reads the event stream itself, so there is no SDK and
 * nothing hidden between the request and the reply.
 */
import {
  partsOf,
  roundsOf,
  toolResult,
  type ChatMessage,
  type Model,
} from "./model.ts";

export interface OpenAiCompatibleOptions {
  /** The API root, for example `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** The model's name on that server. */
  model: string;
  /** Sent as a bearer token when set. Local servers need none. */
  apiKey?: string;
  /** Replace `fetch`, for a test or a proxy. */
  fetch?: typeof fetch;
  /**
   * Extra fields for the request body, for a server that needs one, such
   * as `{ reasoning_effort: "low" }`.
   */
  body?: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

type WireMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/** The `data:` payloads of a server-sent event stream, one at a time. */
export async function* events(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  // Cast: the DOM and Node stream types disagree on async iteration.
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const last = pending.trim();
  if (last.startsWith("data:")) yield last.slice(5).trim();
}

/**
 * The conversation in the API's shape: each round of an assistant message as
 * its text and calls, then one `tool` message per call with what it came to.
 */
export function toWireMessages(
  system: string,
  messages: ChatMessage[],
): WireMessage[] {
  const wire: WireMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user" || !message.parts) {
      wire.push({ role: message.role, content: message.content });
      continue;
    }
    for (const round of roundsOf(partsOf(message))) {
      if (round.calls.length === 0) {
        if (round.text.trim()) {
          wire.push({ role: "assistant", content: round.text });
        }
        continue;
      }
      wire.push({
        role: "assistant",
        content: round.text || null,
        tool_calls: round.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      });
      for (const call of round.calls) {
        const result = toolResult(call);
        wire.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.failed ? `Error: ${result.text}` : result.text,
        });
      }
    }
  }
  return wire;
}

/**
 * One round of the model: it streams text, then yields the tool calls it
 * made. `runTurn` runs them and calls this again with the results in
 * `messages`.
 */
export function openAiCompatibleModel(options: OpenAiCompatibleOptions): Model {
  const { model, apiKey } = options;
  const send = options.fetch ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async function* ({ system, messages, tools = [], signal }) {
    const response = await send(endpoint, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...options.body,
        model,
        stream: true,
        messages: toWireMessages(system, messages),
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
      }),
    });
    if (!response.ok || !response.body) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(
        `The model server answered ${response.status} for "${model}"${detail ? `: ${detail}` : ""}`,
      );
    }

    let finish = "";
    const calls: ToolCall[] = [];
    for await (const data of events(response.body)) {
      if (data === "[DONE]") break;
      let event: {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string | null;
        }[];
      };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = event.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const content = choice.delta?.content;
      if (content) yield content;
      // A tool call arrives in pieces: its name first, then its input.
      for (const piece of choice.delta?.tool_calls ?? []) {
        const call = (calls[piece.index ?? 0] ??= {
          id: "",
          name: "",
          arguments: "",
        });
        if (piece.id) call.id = piece.id;
        if (piece.function?.name) call.name += piece.function.name;
        if (piece.function?.arguments) {
          call.arguments += piece.function.arguments;
        }
      }
    }

    if (finish === "length") {
      // A tool call cut off here has a truncated input: never run it.
      yield "\n\nThe reply was cut off at the length limit.";
      return;
    }
    for (const call of calls) {
      if (!call?.name) continue;
      // Input that is not JSON is passed on as it is: the turn refuses it
      // and tells the model, like any other invalid call.
      let input: unknown = call.arguments;
      try {
        input = JSON.parse(call.arguments || "{}");
      } catch {
        // Kept as the text the model wrote.
      }
      yield {
        type: "tool-call",
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        input,
      };
    }
  };
}

/** The model names a server lists at `GET <baseUrl>/models`, or [] when it does not answer. */
export async function listOpenAiCompatibleModels(options: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<string[]> {
  const send = options.fetch ?? fetch;
  try {
    const response = await send(
      `${options.baseUrl.replace(/\/+$/, "")}/models`,
      {
        signal: AbortSignal.timeout(options.timeoutMs ?? 500),
        headers: options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {},
      },
    );
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}
