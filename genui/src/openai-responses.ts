/**
 * A `Model` backed by a server that speaks the OpenAI Responses API: OpenAI
 * itself and Azure OpenAI. Some newer models take tools only on this API and
 * not on chat completions (`./openai.ts`). Like that adapter it uses `fetch`
 * and reads the event stream itself.
 *
 * Nothing is kept on the server between rounds (`store: false`): each round
 * sends the whole conversation, as every adapter here does.
 */
import {
  partsOf,
  roundsOf,
  toolResult,
  type ChatMessage,
  type Model,
} from "./model.ts";
import { events } from "./openai.ts";

export interface OpenAiResponsesOptions {
  /** The API root, for example `https://api.openai.com/v1`. */
  baseUrl: string;
  /** The model's name, or on Azure the deployment's. */
  model: string;
  /** Sent as a bearer token when set. */
  apiKey?: string;
  /** Extra fields for the request body, such as `{ reasoning: { effort: "low" } }`. */
  body?: Record<string, unknown>;
  /** Replace `fetch`, for a test or a proxy. */
  fetch?: typeof fetch;
}

type InputItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/**
 * The conversation as the API's input items: each round of an assistant
 * message as its text, then each call it made followed by what it came to.
 */
export function toResponsesInput(messages: ChatMessage[]): InputItem[] {
  const input: InputItem[] = [];
  for (const message of messages) {
    if (message.role === "user" || !message.parts) {
      input.push({ role: message.role, content: message.content });
      continue;
    }
    for (const round of roundsOf(partsOf(message))) {
      if (round.text.trim()) {
        input.push({ role: "assistant", content: round.text });
      }
      for (const call of round.calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        });
      }
      for (const call of round.calls) {
        const result = toolResult(call);
        input.push({
          type: "function_call_output",
          call_id: call.id,
          output: result.failed ? `Error: ${result.text}` : result.text,
        });
      }
    }
  }
  return input;
}

/**
 * One round of the model: it streams text, then yields the tool calls it
 * made. `runTurn` runs them and calls this again with the results in
 * `messages`.
 */
export function openAiResponsesModel(options: OpenAiResponsesOptions): Model {
  const { model, apiKey } = options;
  const send = options.fetch ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/responses`;

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
        store: false,
        instructions: system,
        input: toResponsesInput(messages),
        ...(tools.length > 0
          ? {
              tools: tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
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

    let cutOff = false;
    const calls: { id: string; name: string; arguments: string }[] = [];
    for await (const data of events(response.body)) {
      if (data === "[DONE]") break;
      let event: {
        type?: string;
        delta?: string;
        item?: {
          type?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        };
        message?: string;
        response?: {
          status?: string;
          error?: { message?: string } | null;
        };
      };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield event.delta;
          break;
        case "response.output_item.done":
          // A call is taken whole, once its input has all arrived.
          if (event.item?.type === "function_call" && event.item.name) {
            calls.push({
              id: event.item.call_id ?? "",
              name: event.item.name,
              arguments: event.item.arguments ?? "",
            });
          }
          break;
        case "response.incomplete":
          cutOff = true;
          break;
        case "response.failed":
        case "error":
          throw new Error(
            `The model server failed for "${model}": ${(event.response?.error?.message ?? event.message ?? "no reason given").slice(0, 300)}`,
          );
      }
    }

    if (cutOff) {
      // A tool call cut off here has a truncated input: never run it.
      yield "\n\nThe reply was cut off at the length limit.";
      return;
    }
    for (const call of calls) {
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
