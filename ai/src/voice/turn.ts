/**
 * The record of one voice turn: the ids its calls are kept under, the limits
 * on what it holds, settling a finished call into it, the views kept for a
 * conversation, and the messages stored when the turn ends.
 */
import { createHash } from "node:crypto";
import type { ChatMessage, MessagePart, ToolPart } from "../model.ts";
import type { VoiceTurn } from "./types.ts";

export const newVoiceTurn = (): VoiceTurn => ({ parts: [] });

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The id a voice tool call is recorded, claimed and shown under. A provider's
 * id of 1 to 64 letters, digits, `_` or `-` is kept as it is; any other is
 * mapped to one made from its SHA-256 hash, so one raw id always gives one id.
 */
export function voiceCallId(raw: string): string {
  return SAFE_ID.test(raw)
    ? raw
    : `h${createHash("sha256").update(raw).digest("hex").slice(0, 63)}`;
}

/** The most parts (tool calls and shown views) one voice turn records before it is stored. */
export const MAX_VOICE_PARTS = 64;
/** The most characters one voice turn's parts hold, as JSON, before it is stored. */
export const MAX_VOICE_TURN_CHARS = 512_000;
/** The most shown views kept for one conversation's voice calls; the oldest go first. */
export const MAX_VOICE_VIEWS = 64;

/**
 * The most call ids remembered from turns already stored, newest last, so a
 * call sent again after its turn was stored is refused, not run again.
 */
export const MAX_VOICE_CALL_IDS = 256;

/** Whether `turn` has room for one more part. */
export const roomFor = (turn: VoiceTurn, part: MessagePart): boolean =>
  turn.parts.length < MAX_VOICE_PARTS &&
  JSON.stringify(turn.parts).length + JSON.stringify(part).length <=
    MAX_VOICE_TURN_CHARS;

/**
 * Record a finished call in the latest turn, in place of the part that said
 * it was running. `round` is the one `startVoiceTool` answered with: a turn
 * stored meanwhile stored the call as ended, and a later turn is left as it
 * is, even one that holds a call with the same id. An output or error too
 * long for the turn's `MAX_VOICE_TURN_CHARS` is kept as a note that says so.
 */
export function settleVoiceTool(
  turn: VoiceTurn,
  part: ToolPart,
  round: number = turn.round ?? 0,
): void {
  if ((turn.round ?? 0) !== round) return;
  const at = turn.parts.findIndex(
    (other) =>
      other.type === "tool" &&
      other.id === part.id &&
      (other.state === "running" || other.state === "approved"),
  );
  if (at < 0) return;
  turn.parts[at] = part;
  if (JSON.stringify(turn.parts).length > MAX_VOICE_TURN_CHARS) {
    // The part fit when it was recorded, so what it gained is what goes.
    turn.parts[at] = {
      ...part,
      ...(part.output === undefined ? {} : { output: TOO_LONG_TO_KEEP }),
      ...(part.error === undefined ? {} : { error: TOO_LONG_TO_KEEP }),
    };
  }
}

const TOO_LONG_TO_KEEP = "(too long to keep)";

/**
 * Note that the view for `call` is stored, newest last. Answers the calls
 * whose views are past `MAX_VOICE_VIEWS`, oldest first, for the caller to delete.
 */
export function noteVoiceView(turn: VoiceTurn, call: string): string[] {
  const views = (turn.views ?? []).filter((other) => other !== call);
  views.push(call);
  const dropped = views.splice(0, Math.max(0, views.length - MAX_VOICE_VIEWS));
  turn.views = views;
  return dropped;
}

/**
 * End a voice turn: the messages to store for it. What the reader said, then
 * one assistant message with what the model said, called, and showed. `show`
 * is what the thread shows for the reader's message when that is not what
 * the model was told: the label of a form they pressed, or nothing. A call
 * the reader never answered is stored as refused. The turn's call ids are
 * kept (the last `MAX_VOICE_CALL_IDS`): an id is used once in a call.
 */
export function voiceMessages(
  turn: VoiceTurn,
  said: { reader: string; model: string; show?: string },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const reader = said.reader.trim();
  const show = said.show?.trim();
  if (reader) {
    messages.push({
      role: "user",
      content: reader,
      ...(show !== undefined && show !== reader ? { show } : {}),
    });
  }
  const spoken = said.model.trim();
  const parts: MessagePart[] = [
    ...(spoken ? [{ type: "text" as const, text: spoken, spoken: true }] : []),
    ...turn.parts.map((part): MessagePart => {
      if (part.type !== "tool") return part;
      if (part.state === "approval-requested") {
        return { ...part, state: "denied" };
      }
      // Claimed and not finished: it ends here, and what it returns later
      // is recorded in no turn.
      if (part.state === "running" || part.state === "approved") {
        return { ...part, state: "failed", error: "ended with the call" };
      }
      return part;
    }),
  ];
  if (parts.length) {
    messages.push({ role: "assistant", content: spoken, parts });
  }
  turn.parts = [];
  // The ids stay, so a call that is sent again is known. Only the oldest go.
  turn.calls = (turn.calls ?? []).slice(-MAX_VOICE_CALL_IDS);
  turn.round = (turn.round ?? 0) + 1;
  return messages;
}
