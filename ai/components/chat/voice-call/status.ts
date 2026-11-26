/*
 * What voice-call's status line and labels say. The line shows one thing at
 * a time, the most pressing first; the provider label names the speech model
 * on the line, so it is not taken for the browser's voice.
 */

import type { CallStatus } from "./types.ts";

/** The speech models a ticket can name, as the reader is told. */
export const PROVIDERS: Readonly<Record<string, string>> = {
  "azure-voice-live": "Azure Voice Live",
  "gemini-live": "Gemini Live",
};

/** The provider's name for the reader: the ticket's own label first. */
export const providerLabel = (ticket: {
  protocol: string;
  label?: string;
}): string => ticket.label ?? PROVIDERS[ticket.protocol] ?? "";

/** Approval waits, then work, then thinking, then hearing, then listening. */
export const statusText = (call: CallStatus): string =>
  call.waiting.size
    ? "Waiting for your answer on screen."
    : call.working > 0
      ? "Working…"
      : call.thinking
        ? "Thinking…"
        : call.hearing
          ? "Hearing you…"
          : call.base;

/** Why a call could not start, from the session route's HTTP status. */
export const sessionFailure = (status: number): string =>
  status === 404
    ? "Voice is not set up on this server."
    : "The voice service did not answer.";

/** What the button says it does: start a call, or end the one that is on. */
export const toggleLabel = (on: boolean): string =>
  on ? "End call" : "Voice call";

/** Why the call ended, as a relay or provider said it, kept short. */
export const closeReason = (reason: string): string =>
  reason.slice(0, 160) || "The call ended.";
