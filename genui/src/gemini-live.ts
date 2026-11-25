/**
 * A `VoiceProvider` for Google's Gemini Live API, through the Gemini
 * Developer API (an AI Studio key).
 *
 * The server asks Google for a one-use token with the session's whole setup
 * locked into it: the model, the system prompt, and the tools. The browser
 * connects to Google with that token, so it never sees the API key and
 * cannot change what the session may do.
 */
import type { Tool, ToolInputSchema } from "./model.ts";
import type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceTicket,
} from "./voice.ts";

export interface GeminiLiveOptions {
  /** Defaults to GEMINI_API_KEY from the environment. */
  apiKey?: string;
  /** A model that supports live sessions. */
  model?: string;
  /** One of the provider's voice names. Left out, the provider picks. */
  voice?: string;
  /** How long a ticket may be used to start a session, in seconds (default 60). */
  startWithinSeconds?: number;
  /** How long a session may last, in seconds (default 900, the provider's own limit for audio). */
  sessionSeconds?: number;
  /** The provider's HTTP and WebSocket roots. Replace them for a test server or a proxy. */
  httpBase?: string;
  wsBase?: string;
  /** Replace `fetch`, for a test. */
  fetch?: typeof fetch;
}

const HTTP_BASE = "https://generativelanguage.googleapis.com";
const WS_BASE = "wss://generativelanguage.googleapis.com";
const SERVICE = "google.ai.generativelanguage.v1beta.GenerativeService";

/** The provider writes JSON Schema types in capitals. */
function declaration(tool: Tool): Record<string, unknown> {
  const schema: ToolInputSchema = tool.inputSchema;
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([name, property]) => [
      name,
      {
        type: property.type.toUpperCase(),
        ...(property.description ? { description: property.description } : {}),
      },
    ]),
  );
  return {
    name: tool.name,
    description: tool.description,
    // A tool with no input declares no parameters: an empty object schema is refused.
    ...(Object.keys(properties).length
      ? {
          parameters: {
            type: "OBJECT",
            properties,
            ...(schema.required?.length ? { required: schema.required } : {}),
          },
        }
      : {}),
  };
}

/** The session setup the token locks in. */
export function geminiLiveSetup(
  config: VoiceSessionConfig,
  options: { model: string; voice?: string },
): Record<string, unknown> {
  return {
    model: options.model,
    generationConfig: {
      responseModalities: ["AUDIO"],
      ...(options.voice
        ? {
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: options.voice },
              },
            },
          }
        : {}),
    },
    systemInstruction: { parts: [{ text: config.system }] },
    ...(config.tools.length
      ? { tools: [{ functionDeclarations: config.tools.map(declaration) }] }
      : {}),
    // What each side says, as text: the captions and the stored conversation.
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

export function geminiLiveVoice(
  options: GeminiLiveOptions = {},
): VoiceProvider {
  const {
    model = "models/gemini-3.8-live",
    voice,
    startWithinSeconds = 60,
    sessionSeconds = 900,
    httpBase = HTTP_BASE,
    wsBase = WS_BASE,
  } = options;
  const send = options.fetch ?? fetch;
  return {
    protocol: "gemini-live",
    async createSession(config): Promise<VoiceTicket> {
      const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("No Gemini API key is set.");
      const at = (seconds: number): string =>
        new Date(Date.now() + seconds * 1000).toISOString();
      const response = await send(`${httpBase}/v1beta/auth_tokens`, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          uses: 1,
          newSessionExpireTime: at(startWithinSeconds),
          expireTime: at(sessionSeconds),
          bidiGenerateContentSetup: geminiLiveSetup(config, { model, voice }),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        name?: string;
        error?: { message?: string };
      };
      if (!response.ok || !body.name) {
        throw new Error(
          `The voice provider answered ${response.status}${body.error?.message ? `: ${body.error.message.slice(0, 300)}` : ""}`,
        );
      }
      return {
        protocol: "gemini-live",
        url: `${wsBase}/ws/${SERVICE}.BidiGenerateContentConstrained?access_token=${encodeURIComponent(body.name)}`,
        // The token carries the rest of the setup; the model has to be named again.
        setup: { setup: { model } },
      };
    },
  };
}
