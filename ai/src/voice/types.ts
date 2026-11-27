/**
 * The types a voice session is built from: the ticket a browser connects
 * with, the provider that makes it, the turn being recorded, and the request,
 * result and two-step start of one voice tool call.
 */
import type { MessagePart, Tool, ToolPart } from "../model.ts";

/** What a browser needs to open one voice session. It holds no API key. */
export interface VoiceTicket {
  /** Which wire protocol the browser speaks: `gemini-live` or `azure-voice-live`. */
  protocol: string;
  /** The WebSocket address, with a short-lived credential in it. */
  url: string;
  /** The first message to send once connected, or null when there is none. */
  setup: unknown;
  /** Who is on the line, as the reader is told: the provider and its model. */
  label?: string;
}

export interface VoiceSessionConfig {
  /** The system prompt, usually `voicePrompt(...)` after the app's own instructions. */
  system: string;
  /** The tools the model may call, usually `voiceTools(...)`. */
  tools: readonly Tool[];
  /**
   * Whose session this is, when the caller knows: the chat kit passes the
   * reader. A provider with a relay uses it to limit how many calls one
   * reader has open.
   */
  owner?: string;
}

/** A speech-to-speech provider: it turns a session's config into a ticket. */
export interface VoiceProvider {
  protocol: string;
  createSession(config: VoiceSessionConfig): Promise<VoiceTicket>;
}

/** A voice turn being recorded: what was called and shown since the last one was stored. */
export interface VoiceTurn {
  parts: MessagePart[];
  /**
   * The components of the view shown last, kept from turn to turn, so a
   * model that shows the same kind of view again can be told so.
   */
  lastView?: string[];
  /**
   * The calls whose shown views are stored, oldest first, kept from turn to
   * turn so no more than `MAX_VOICE_VIEWS` are.
   */
  views?: string[];
  /**
   * The call ids recorded, `show` calls included, so a second call with one
   * id is refused: this turn's, and the last `MAX_VOICE_CALL_IDS` of the
   * turns stored before it.
   */
  calls?: string[];
  /**
   * The ids of the turns stored last, as the browser named them, so a turn
   * that is sent twice is stored once.
   */
  stored?: string[];
  /**
   * How many turns were stored before this one. A call that finishes after
   * its turn was stored is not recorded in a later one.
   */
  round?: number;
}

export interface VoiceToolRequest {
  /** The provider's id for the call. */
  id: string;
  name: string;
  input: unknown;
  /** The reader's answer, when this call was waiting for their approval. */
  decision?: "approve" | "deny";
}

export interface VoiceToolResult {
  /** `done`, `failed`, `denied`, or `approval-requested` when the reader has to answer first. */
  state: ToolPart["state"];
  /** What to tell the model. Absent while the call waits for approval. */
  output?: string;
  /** What to put on the reader's screen for this call, if anything. */
  html: string;
}

/** What `startVoiceTool` decided: an answer now, or a call to run. */
export interface VoiceToolStart {
  /** The answer, when there is nothing to run. */
  result?: VoiceToolResult;
  /**
   * The call to run, already recorded in the turn as `running` or
   * `approved`. Only the request that recorded it runs it.
   */
  run?: ToolPart;
  /** The turn's `round` when `run` was recorded, for `settleVoiceTool`. */
  round?: number;
}
