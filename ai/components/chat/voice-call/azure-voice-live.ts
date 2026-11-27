/*
 * The azure-voice-live protocol, as voice-call speaks it through the
 * server's relay: the realtime events the browser sends, and what each event
 * it receives does to the call. The component passes its socket and hooks in.
 */

import { sender } from "./gemini-live.ts";
import type { Wire, WireHooks, WireSocket } from "./types.ts";

/** A piece of microphone audio, appended to the input buffer. */
export const azureAudio = (audio: string) => ({
  type: "input_audio_buffer.append",
  audio,
});

/** A typed message, as a user item in the conversation. */
export const azureUserText = (text: string) => ({
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  },
});

/** What a tool said, as the item that answers its call. */
export const azureToolOutput = (callId: unknown, output: string) => ({
  type: "conversation.item.create",
  item: { type: "function_call_output", call_id: callId, output },
});

/**
 * A tool call's arguments. Text that is not JSON is passed on as it is: the
 * server refuses it, and the model is told.
 */
export function parseToolArguments(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return raw;
  }
}

/**
 * Azure Voice Live, through the server's relay. The relay sends the
 * session's setup, so the first thing heard here is that it is on.
 */
export function azureVoiceLive(
  current: { socket: WireSocket },
  hooks: WireHooks,
): Wire {
  const send = sender(current.socket);
  /** A reply is being made. */
  let active = false;
  /** The tool calls of the reply being made. */
  let tools: Promise<void>[] = [];
  /**
   * The reply being made was cut off, by the reader's voice or by a typed
   * message. What is still on its way from it is neither played nor shown,
   * and its end is not the end of the turn that replaced it.
   */
  let cut = false;
  return {
    byMeter: false,
    begin: () => {},
    audio: (audio) => send(azureAudio(audio)),
    text(text) {
      if (active) {
        cut = true;
        send({ type: "response.cancel" });
      }
      send(azureUserText(text));
      send({ type: "response.create" });
    },
    async receive(message) {
      switch (message.type) {
        case "session.updated":
          hooks.connected();
          break;
        case "input_audio_buffer.speech_started":
          // The reader cut in, or began a new turn.
          if (active) cut = true;
          hooks.quiet();
          if (hooks.said().trim()) hooks.endTurn();
          hooks.mark({ hearing: true, thinking: false });
          break;
        case "input_audio_buffer.speech_stopped":
          // The reader is done: the model has not answered yet.
          hooks.mark({ hearing: false, thinking: true });
          break;
        case "conversation.item.input_audio_transcription.delta":
          // The words so far; the completed text that follows replaces them.
          if (message.delta) hooks.heard(message.delta);
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (message.transcript) hooks.heard(message.transcript, true);
          break;
        case "response.created": {
          active = true;
          cut = false;
          hooks.newResponse();
          // A turn can be more than one response: keep their words apart.
          const said = hooks.said();
          if (said && !/\s$/.test(said)) hooks.spoke(" ");
          break;
        }
        case "response.audio.delta":
          if (message.delta && !cut) hooks.play(message.delta);
          break;
        case "response.audio_transcript.delta":
          if (message.delta && !cut) hooks.spoke(message.delta);
          break;
        case "response.audio_timestamp.delta":
          if (message.text && !cut) {
            hooks.timedWord(message.text, message.audio_offset_ms ?? 0);
          }
          break;
        case "response.function_call_arguments.done": {
          // A reply that was cut off does not get to act.
          if (cut) break;
          const tool = {
            id: message.call_id,
            name: message.name,
            args: parseToolArguments(message.arguments),
          };
          tools.push(
            hooks
              .answerTool(tool)
              .then((output) => send(azureToolOutput(tool.id, output))),
          );
          break;
        }
        case "response.done": {
          active = false;
          const called = tools;
          tools = [];
          if (cut) {
            // The turn that replaced this reply is already under way.
            cut = false;
            break;
          }
          if (called.length && message.response?.status !== "cancelled") {
            // The model hears the results once its reply is over, and goes on.
            await Promise.all(called);
            if (hooks.isCurrent()) {
              hooks.mark({ thinking: true });
              send({ type: "response.create" });
            }
          } else {
            hooks.endTurn();
          }
          break;
        }
      }
    },
  };
}
