/** A `Model` backed by the Claude API, through the official SDK. */
import Anthropic from "@anthropic-ai/sdk";
import {
  readAttachments,
  userPieces,
  type Attachments,
} from "./attachments.ts";
import {
  partsOf,
  roundsOf,
  toolResult,
  type ChatMessage,
  type Model,
} from "./model.ts";

export interface AnthropicModelOptions {
  /** Defaults to a client that reads its credentials from the environment. */
  client?: Anthropic;
  model?: string;
  /** How much the model thinks before it answers. `low` suits chat. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentParam = Anthropic.Beta.BetaContentBlockParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;

/**
 * What the API sent for a round that made tool calls, by the first call's id.
 * A round is sent back as it was received when it is still here (it may hold
 * blocks, such as thinking, that the parts do not keep), and rebuilt from the
 * parts when it is not: after a restart, or on another server.
 */
const REMEMBERED = 500;
const received = new Map<string, Message["content"]>();

function remember(id: string, content: Message["content"]): void {
  if (received.size >= REMEMBERED) {
    received.delete(received.keys().next().value!);
  }
  received.set(id, content);
}

/**
 * The conversation in the API's shape: each round's calls, then their results.
 * A user message with attached files is image and document blocks (PDF) and
 * text; `attachments` holds their bytes (see `readAttachments`).
 */
export function toMessageParams(
  messages: ChatMessage[],
  attachments: Attachments = new Map(),
): MessageParam[] {
  const params: MessageParam[] = [];
  for (const message of messages) {
    const pieces =
      message.role === "user"
        ? userPieces(message, attachments, { image: true, pdf: true })
        : null;
    if (pieces) {
      params.push({
        role: "user",
        content: pieces.map((piece): ContentParam => {
          switch (piece.kind) {
            case "image":
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: piece.mediaType as
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                  data: piece.data,
                },
              };
            case "pdf":
              return {
                type: "document",
                title: piece.name,
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: piece.data,
                },
              };
            default:
              return { type: "text", text: piece.text };
          }
        }),
      });
      continue;
    }
    if (message.role === "user" || !message.parts) {
      if (message.content) {
        params.push({ role: message.role, content: message.content });
      }
      continue;
    }
    for (const round of roundsOf(partsOf(message))) {
      const first = round.calls[0];
      const content: ContentParam[] = [];
      if (round.text.trim()) content.push({ type: "text", text: round.text });
      for (const call of round.calls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      if (content.length === 0) continue;
      params.push({
        role: "assistant",
        content: (first && received.get(first.id)) || content,
      });
      if (round.calls.length) {
        params.push({
          role: "user",
          content: round.calls.map((call) => {
            const result = toolResult(call);
            return {
              type: "tool_result" as const,
              tool_use_id: call.id,
              content: result.text,
              ...(result.failed ? { is_error: true } : {}),
            };
          }),
        });
      }
    }
  }
  return params;
}

/**
 * One round of Claude: it streams text, then yields the tool calls it made.
 * `runTurn` runs them and calls this again with the results in `messages`.
 */
export function anthropicModel(options: AnthropicModelOptions = {}): Model {
  const {
    client = new Anthropic(),
    model = "claude-opus-5-5",
    effort = "low",
    maxTokens = 64_000,
  } = options;

  return async function* ({ system, messages, tools = [], signal, readFile }) {
    const conversation = toMessageParams(
      messages,
      await readAttachments(messages, readFile),
    );
    // A paused turn is continued here; it is one round to the caller.
    for (;;) {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          // If a safety classifier declines the request, the API retries it
          // on a fallback model inside the same call.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort },
          // The catalog prompt and the tools are the same for every request,
          // so they are cached as a prefix.
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          messages: conversation,
        },
        { signal },
      );
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
      const message: Message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        yield "\n\nThe model declined to answer this request.";
        return;
      }
      if (message.stop_reason === "max_tokens") {
        // A tool call cut off here has a truncated input: never run it.
        yield "\n\nThe reply was cut off at the length limit.";
        return;
      }
      if (message.stop_reason === "pause_turn") {
        conversation.push({ role: "assistant", content: message.content });
        continue;
      }
      const calls = message.content.filter(
        (block): block is ToolUse => block.type === "tool_use",
      );
      if (calls.length) remember(calls[0]!.id, message.content);
      for (const call of calls) {
        yield {
          type: "tool-call",
          id: call.id,
          name: call.name,
          input: call.input,
        };
      }
      return;
    }
  };
}
