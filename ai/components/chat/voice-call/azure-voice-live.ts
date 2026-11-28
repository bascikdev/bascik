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
  /** The reply being made, by the provider's name for it. */
  let replying: unknown;
  /**
   * Whether a message is about a reply that another has already replaced:
   * the end of one that was cut off can arrive after the next has begun.
   */
  const stale = (id: unknown): boolean =>
    id !== undefined && replying !== undefined && id !== replying;
  /**
   * The utterance being heard. The provider names each one (`item_id`); one
   * it does not name is numbered here.
   */
  let utterances = 0;
  let utterance = "utterance-0";
  const named = (message: { item_id?: unknown }): string =>
    typeof message.item_id === "string" && message.item_id
      ? message.item_id
      : utterance;
  return {
    byMeter: false,
    begin: () => {},
    audio: (audio) => send(azureAudio(audio)),
    // The silence sent after the reader's last sound is what ends their turn.
    pause: () => {},
    // The relay ends a call nobody speaks on, and it sees only speech: it is
    // told of the use the page alone knows of.
    alive: () => send({ type: "call.active" }),
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
        case "input_audio_buffer.speech_started": {
          // The reader cut in, or began a new turn.
          if (active) cut = true;
          // A reply the reader heard some of is a turn of its own. One they
          // spoke over before it was heard was the model answering a pause:
          // it is taken back, and what they say next is the same turn.
          const replied = hooks.said().trim() !== "";
          const taken = replied && hooks.dropReply();
          hooks.quiet();
          if (replied && !taken) hooks.endTurn();
          utterance = `utterance-${++utterances}`;
          utterance = named(message);
          // Its place in the turn is kept now: its words can come late.
          hooks.heard("", utterance);
          hooks.mark({ hearing: true, thinking: false });
          hooks.active();
          break;
        }
        case "input_audio_buffer.speech_stopped":
          // The reader is done: the model has not answered yet.
          hooks.mark({ hearing: false, thinking: true });
          break;
        case "conversation.item.input_audio_transcription.delta":
          // The words of one utterance so far; its completed text replaces them.
          if (message.delta) hooks.heard(message.delta, named(message));
          break;
        case "conversation.item.input_audio_transcription.completed":
          // Only that utterance's words: a reader who paused has said more than one.
          if (message.transcript) {
            hooks.heard(message.transcript, named(message), true);
          }
          break;
        case "response.created": {
          active = true;
          cut = false;
          // The calls of a reply that was replaced are not this one's.
          tools = [];
          replying = message.response?.id;
          hooks.newResponse();
          // A turn can be more than one response: keep their words apart.
          const said = hooks.said();
          if (said && !/\s$/.test(said)) hooks.spoke(" ");
          break;
        }
        case "response.audio.delta":
          if (message.delta && !cut && !stale(message.response_id)) {
            hooks.play(message.delta);
          }
          break;
        case "response.audio_transcript.delta":
          if (message.delta && !cut && !stale(message.response_id)) {
            hooks.spoke(message.delta);
          }
          break;
        case "response.audio_timestamp.delta":
          if (message.text && !cut && !stale(message.response_id)) {
            hooks.timedWord(message.text, message.audio_offset_ms ?? 0);
          }
          break;
        case "response.function_call_arguments.done": {
          // A reply that was cut off does not get to act.
          if (cut || stale(message.response_id)) break;
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
          // The end of a reply that another has replaced ends nothing.
          if (stale(message.response?.id)) break;
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
