/**
 * Voice sessions with a speech-to-speech model.
 *
 * A text reply is a request and a growing page. A voice conversation is a
 * long two-way audio connection, so it has its own shape:
 *
 * - **The browser connects with a ticket.** A short-lived, one-use ticket
 *   the server made, with the session's setup locked in. The API key never
 *   leaves the server. Where the provider issues such a ticket itself
 *   (Gemini Live), the audio goes direct; where it does not (Azure Voice
 *   Live), the ticket is for a relay on the server.
 * - **Everything that runs or renders goes through the server.** When the
 *   model calls a tool, the browser asks the server to run it. When the
 *   model wants to show something, it calls the `show` tool with markup in
 *   the usual reply format, and the server renders it with the usual
 *   renderer. So the trust boundary, the catalog, tool input checks, and
 *   approval are the same ones a text reply has.
 * - **What was said is stored as a message.** The transcript, the tool calls
 *   and what was shown become one assistant message made of parts, so a
 *   reload shows the conversation, components included.
 *
 * The parts live in `voice/`: `tools.ts` holds what the model is offered,
 * `tool-calls.ts` runs a call, `turn.ts` records the turn and stores it, and
 * `types.ts` holds the shared types.
 */
export {
  finishVoiceTool,
  runVoiceTool,
  startVoiceTool,
} from "./voice/tool-calls.ts";
export {
  FILL_TOOL,
  SHOW_TOOL,
  voicePrompt,
  voiceTools,
} from "./voice/tools.ts";
export {
  MAX_VOICE_PARTS,
  MAX_VOICE_TURN_CHARS,
  MAX_VOICE_VIEWS,
  newVoiceTurn,
  noteVoiceView,
  settleVoiceTool,
  voiceCallId,
  voiceMessages,
} from "./voice/turn.ts";
export type {
  VoiceProvider,
  VoiceSessionConfig,
  VoiceTicket,
  VoiceToolRequest,
  VoiceToolResult,
  VoiceToolStart,
  VoiceTurn,
} from "./voice/types.ts";
