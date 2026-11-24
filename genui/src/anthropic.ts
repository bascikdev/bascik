/** A `Model` backed by the Claude API, through the official SDK. */
import Anthropic from "@anthropic-ai/sdk";
import { invalidToolInput, type Model, type Tool } from "./model.ts";

export interface AnthropicModelOptions {
  /** Defaults to a client that reads its credentials from the environment. */
  client?: Anthropic;
  model?: string;
  /** How much the model thinks before it answers. `low` suits chat. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /** How many rounds of tool calls one reply may take. */
  maxToolRounds?: number;
}

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

async function runTool(
  tools: Tool[],
  call: ToolUse,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const failed = (content: string): ToolResult => ({
    type: "tool_result",
    tool_use_id: call.id,
    is_error: true,
    content,
  });
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return failed(`There is no tool named ${call.name}.`);
  const invalid = invalidToolInput(tool.inputSchema, call.input);
  if (invalid) return failed(`Invalid input: ${invalid}.`);
  try {
    const content = await tool.run(call.input as Record<string, unknown>, {
      signal,
    });
    return { type: "tool_result", tool_use_id: call.id, content };
  } catch (error) {
    return failed(error instanceof Error ? error.message : "The tool failed.");
  }
}

export function anthropicModel(options: AnthropicModelOptions = {}): Model {
  const {
    client = new Anthropic(),
    model = "claude-opus-5-5",
    effort = "low",
    maxTokens = 64_000,
    maxToolRounds = 8,
  } = options;

  return async function* ({ system, messages, tools = [], signal }) {
    const conversation: MessageParam[] = [...messages];
    for (let round = 0; ; round++) {
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
      if (calls.length === 0) return;
      if (round >= maxToolRounds) {
        yield "\n\nStopped: this reply needed too many tool calls.";
        return;
      }

      // Tell the reader what is happening, then run the calls together and
      // answer them all in one message.
      for (const call of calls) {
        const tool = tools.find((candidate) => candidate.name === call.name);
        const note = tool?.note?.(call.input as Record<string, unknown>);
        if (note) yield `\n${note}\n`;
      }
      const results = await Promise.all(
        calls.map((call) => runTool(tools, call, signal)),
      );
      conversation.push({ role: "assistant", content: message.content });
      conversation.push({ role: "user", content: results });
      // Text after a tool round starts on its own line.
      yield "\n";
    }
  };
}
