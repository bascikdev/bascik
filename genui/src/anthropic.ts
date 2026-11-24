/** A `Model` backed by the Claude API, through the official SDK. */
import Anthropic from "@anthropic-ai/sdk";
import type { Model } from "./model.ts";

export interface AnthropicModelOptions {
  /** Defaults to a client that reads its credentials from the environment. */
  client?: Anthropic;
  model?: string;
  /** How much the model thinks before it answers. `low` suits chat. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
}

export function anthropicModel(options: AnthropicModelOptions = {}): Model {
  const {
    client = new Anthropic(),
    model = "claude-opus-5-5",
    effort = "low",
    maxTokens = 64_000,
  } = options;

  return async function* ({ system, messages, signal }) {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        // If a safety classifier declines the request, the API retries it on
        // a fallback model inside the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort },
        // The catalog prompt is the same for every request, so cache it.
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        messages,
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
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      yield "\n\nThe model declined to answer this request.";
    } else if (message.stop_reason === "max_tokens") {
      yield "\n\nThe reply was cut off at the length limit.";
    }
  };
}
