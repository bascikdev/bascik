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
  return {
    byMeter: true,
    begin: () => send(setup),
    audio: (data) => send(geminiAudio(data)),
    text: (text) => send(geminiText(text)),
    async receive(message) {
      if (message.setupComplete) {
        hooks.connected();
        return;
      }
      if (message.toolCall) {
        const functionResponses: GeminiFunctionResponse[] = [];
        for (const tool of message.toolCall.functionCalls ?? []) {
          const result = await hooks.answerTool(tool);
          functionResponses.push({
            id: tool.id,
            name: tool.name,
            response: { result },
          });
        }
        send(geminiToolResponse(functionResponses));
        // The model goes on with what the tools said.
        hooks.mark({ thinking: true });
        return;
      }
      const content = message.serverContent;
      if (!content) return;
      if (content.interrupted) hooks.quiet();
      if (content.inputTranscription?.text) {
        hooks.heard(content.inputTranscription.text);
      }
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) hooks.play(part.inlineData.data);
      }
      if (content.outputTranscription?.text) {
        hooks.spoke(content.outputTranscription.text);
      }
      // A turn that only called tools is not over: the model speaks next.
      if (content.turnComplete && (hooks.said().trim() || !hooks.hasReply())) {
        hooks.endTurn();
      }
    },
  };
}
