/**
 * The Voice Live messages the relay writes or checks: the session setup it
 * sends Azure itself, and the filter that rebuilds what a browser may say to
 * the provider, field by field.
 */
import type { Tool } from "../model.ts";
import type { VoiceSessionConfig } from "../voice.ts";
import { pauseMsOf } from "../voice/pause.ts";

const isAzureVoice = (name: string): boolean =>
  /^[a-z]{2,3}-[A-Z]{2}-/.test(name);

function declaration(tool: Tool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

/**
 * How Voice Live tells that the reader's turn is over: by meaning as well as
 * silence, waiting `pauseMs` of silence. What the developer passes as
 * `turnDetection` is laid over it. OpenAI's own `semantic_vad` has no wait
 * to set, so it is given none.
 */
function turnDetection(
  pauseMs: number | undefined,
  given: Record<string, unknown> = {},
): Record<string, unknown> {
  const type = given.type ?? "azure_semantic_vad";
  return {
    type,
    ...(type === "semantic_vad"
      ? {}
      : { silence_duration_ms: pauseMsOf(pauseMs) }),
    ...given,
  };
}

/** The session setup the relay sends, which the browser has no say in. */
export function azureVoiceLiveSession(
  config: VoiceSessionConfig,
  options: {
    voice: string;
    pauseMs?: number;
    turnDetection?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const azureVoice = isAzureVoice(options.voice);
  return {
    modalities: ["text", "audio"],
    instructions: config.system,
    voice: {
      type: azureVoice ? "azure-standard" : "openai",
      name: options.voice,
    },
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    input_audio_sampling_rate: 16_000,
    // What the reader says, as text: their side of the stored conversation.
    input_audio_transcription: { model: "azure-speech" },
    turn_detection: turnDetection(options.pauseMs, options.turnDetection),
    input_audio_noise_reduction: { type: "azure_deep_noise_suppression" },
    input_audio_echo_cancellation: { type: "server_echo_cancellation" },
    // Only an Azure voice can say when each word is spoken.
    ...(azureVoice ? { output_audio_timestamp_types: ["word"] } : {}),
    tools: config.tools.map(declaration),
    tool_choice: "auto",
  };
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

/**
 * What a browser may say to the provider through the relay, rebuilt field by
 * field: microphone audio, a typed message, a tool's result, and asking for
 * or stopping a reply. `call.active` is said to the relay and goes no
 * further. Anything else, a new session setup included, is null.
 */
export function relayedClientEvent(
  raw: string,
): Record<string, unknown> | null {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const { type, audio, item } = event as Record<string, unknown>;
  switch (type) {
    case "input_audio_buffer.append":
      return text(audio, 400_000) ? { type, audio } : null;
    case "input_audio_buffer.clear":
    case "response.cancel":
    case "response.create":
    // For the relay alone: the page counts the call as in use.
    case "call.active":
      return { type };
    case "conversation.item.create": {
      if (typeof item !== "object" || item === null) return null;
      const {
        type: kind,
        call_id,
        output,
        content,
      } = item as Record<string, unknown>;
      if (kind === "function_call_output") {
        return text(call_id, 200) && text(output, 200_000)
          ? { type, item: { type: kind, call_id, output } }
          : null;
      }
      const said = Array.isArray(content)
        ? (content[0] as { text?: unknown } | undefined)?.text
        : undefined;
      return kind === "message" && text(said, 20_000)
        ? {
            type,
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: said }],
            },
          }
        : null;
    }
    default:
      return null;
  }
}
