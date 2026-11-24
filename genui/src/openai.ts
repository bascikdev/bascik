/**
 * A `Model` backed by any server that speaks the OpenAI chat completions
 * API: Ollama, LM Studio, llama.cpp, vLLM, a gateway, or OpenAI itself. It
 * uses `fetch` and reads the event stream itself, so there is no SDK and
 * nothing hidden between the request and the reply.
 */
import { invalidToolInput, type Model, type Tool } from "./model.ts";

export interface OpenAiCompatibleOptions {
  /** The API root, for example `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** The model's name on that server. */
  model: string;
  /** Sent as a bearer token when set. Local servers need none. */
  apiKey?: string;
  /** How many rounds of tool calls one reply may take. */
  maxToolRounds?: number;
  /** Replace `fetch`, for a test or a proxy. */
  fetch?: typeof fetch;
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
async function* events(
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

async function runTool(
  tools: Tool[],
  call: ToolCall,
  signal: AbortSignal | undefined,
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return `Error: there is no tool named ${call.name}.`;
  let input: unknown;
  try {
    input = JSON.parse(call.arguments || "{}");
  } catch {
    return "Error: the tool input was not valid JSON.";
  }
  const invalid = invalidToolInput(tool.inputSchema, input);
  if (invalid) return `Error: invalid input: ${invalid}.`;
  try {
    return await tool.run(input as Record<string, unknown>, { signal });
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "the tool failed"}.`;
  }
}

/** The tool's input as an object, for its progress note. Never thrown. */
const noteInput = (call: ToolCall): Record<string, unknown> => {
  try {
    const input: unknown = JSON.parse(call.arguments || "{}");
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export function openAiCompatibleModel(options: OpenAiCompatibleOptions): Model {
  const { model, apiKey, maxToolRounds = 8 } = options;
  const send = options.fetch ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async function* ({ system, messages, tools = [], signal }) {
    const conversation: WireMessage[] = [
      { role: "system", content: system },
      ...messages,
    ];
    for (let round = 0; ; round++) {
      const response = await send(endpoint, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages: conversation,
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

      let text = "";
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
        if (content) {
          text += content;
          yield content;
        }
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

      const asked = calls.filter((call) => call?.name);
      if (finish === "length") {
        // A tool call cut off here has a truncated input: never run it.
        yield "\n\nThe reply was cut off at the length limit.";
        return;
      }
      if (asked.length === 0) return;
      if (round >= maxToolRounds) {
        yield "\n\nStopped: this reply needed too many tool calls.";
        return;
      }

      for (const [index, call] of asked.entries()) {
        call.id ||= `call_${round}_${index}`;
        const note = tools
          .find((candidate) => candidate.name === call.name)
          ?.note?.(noteInput(call));
        if (note) yield `\n${note}\n`;
      }
      const results = await Promise.all(
        asked.map((call) => runTool(tools, call, signal)),
      );
      conversation.push({
        role: "assistant",
        content: text || null,
        tool_calls: asked.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        })),
      });
      for (const [index, call] of asked.entries()) {
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: results[index]!,
        });
      }
      // Text after a tool round starts on its own line.
      yield "\n";
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
