/*
 * The gemini-live protocol, as voice-call speaks it: the messages the
 * browser sends to Gemini Live, and what each message it receives does to
 * the call. The component passes its socket and its hooks in.
 */

import type { Wire, WireHooks, WireSocket } from "./types.ts";

/** A piece of microphone audio: 16 kHz, 16-bit, base64. */
export const geminiAudio = (data: string) => ({
  realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } },
});

/** A typed message, as a whole user turn. */
export const geminiText = (text: string) => ({
  clientContent: {
    turns: [{ role: "user", parts: [{ text }] }],
    turnComplete: true,
  },
});

/** The microphone was switched off: the provider stops waiting for more sound. */
export const geminiAudioEnd = () => ({
  realtimeInput: { audioStreamEnd: true },
});

/** One tool's answer, as the model reads it. */
export interface GeminiFunctionResponse {
  id: unknown;
  name: string;
  response: { result: string };
}

/** The answers to one tool-call message, all together. */
export const geminiToolResponse = (
  functionResponses: GeminiFunctionResponse[],
) => ({ toolResponse: { functionResponses } });

/** Send `message` as JSON while the socket is open; drop it otherwise. */
export const sender =
  (socket: WireSocket) =>
  (message: unknown): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

/**
 * Gemini Live. The browser sends the setup the ticket carries, and the
 * reader's speech is told by the microphone's level (`byMeter`).
 */
export function geminiLive(
  current: { socket: WireSocket },
  setup: unknown,
  hooks: WireHooks,
): Wire {
  const send = sender(current.socket);
  /** Which of the reader's utterances is being written down. */
  let utterance = 0;
  /**
   * The reader spoke over a reply before any of it was heard: the turn the
   * provider is about to call complete is not over here.
   */
  let held = false;
  /**
   * Something of a turn has come since the provider last called one
   * complete: the reader's words, the model's, or a tool call. Only then is
   * there a turn for the provider to call complete after a cut.
   */
  let open = false;
  /**
   * The model called a tool. The provider calls the turn complete straight
   * after the call, before the tool has answered: that is not the turn's end.
   */
  let tooled = false;
  /** Tool calls that have not been answered yet. */
  let answering = 0;
  return {
    byMeter: true,
    begin: () => send(setup),
    audio: (data) => send(geminiAudio(data)),
    text(text) {
      // What is heard after typed words is another utterance.
      utterance++;
      open = true;
      send(geminiText(text));
    },
    pause: () => send(geminiAudioEnd()),
    // Nothing between the browser and the provider ends a quiet call.
    alive: () => {},
    async receive(message) {
      if (message.setupComplete) {
        hooks.connected();
        return;
      }
      if (message.toolCall) {
        open = tooled = true;
        answering++;
        const functionResponses: GeminiFunctionResponse[] = [];
        try {
          for (const tool of message.toolCall.functionCalls ?? []) {
            const result = await hooks.answerTool(tool);
            functionResponses.push({
              id: tool.id,
              name: tool.name,
              response: { result },
            });
          }
        } finally {
          answering--;
        }
        send(geminiToolResponse(functionResponses));
        // The model goes on with what the tools said.
        hooks.mark({ thinking: true });
        return;
      }
      if (message.voiceActivity?.type === "ACTIVITY_START") hooks.active();
      const content = message.serverContent;
      if (!content) return;
      if (content.interrupted) {
        // A reply nobody heard was the model answering a pause: it is taken
        // back, and what the reader says next is the same turn.
        held = hooks.said().trim()
          ? hooks.dropReply()
          : open && !hooks.hasReply();
        hooks.quiet();
      }
      const spoken =
        !!content.modelTurn?.parts?.length ||
        !!content.outputTranscription?.text;
      // The model going on is past the call it made.
      if (spoken) tooled = false;
      if (spoken || content.inputTranscription?.text) open = true;
      if (content.inputTranscription?.text) {
        hooks.heard(content.inputTranscription.text, `utterance-${utterance}`);
      }
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) hooks.play(part.inlineData.data);
      }
      if (content.outputTranscription?.text) {
        hooks.spoke(content.outputTranscription.text);
      }
      if (content.turnComplete) {
        // What the reader says next is another utterance, in this turn or the next.
        utterance++;
        const goesOn = held || tooled;
        held = tooled = open = false;
        // A tool that is still being answered, or waits for the reader, is
        // not over: the model goes on with its answer, and ends the turn then.
        if (!goesOn && answering === 0) hooks.endTurn();
      }
    },
  };
}
