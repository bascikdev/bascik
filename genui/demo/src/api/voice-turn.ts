// POST /api/voice-turn: store what was just said. The browser sends the two
// transcripts when the model finishes a turn (or the call ends); the tool
// calls and what was shown were recorded here as they happened.
//
//   app=books  reader=<what the reader said>  model=<what the model said>
import { voiceMessages } from "@bascik/genui/voice";
import {
  abandonApprovals,
  loadConversation,
  saveConversation,
  sessionFor,
  voiceState,
} from "../lib/chat.ts";

const MAX_LENGTH = 8000;

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const named = form.get("app");
  const reader = form.get("reader");
  const model = form.get("model");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const conversation = await loadConversation(session);
  if (
    !conversation ||
    typeof reader !== "string" ||
    typeof model !== "string"
  ) {
    return new Response("Not a voice turn.", { status: 400 });
  }
  const messages = voiceMessages(voiceState(conversation.id).turn, {
    reader: reader.slice(0, MAX_LENGTH),
    model: model.slice(0, MAX_LENGTH),
  });
  if (messages.length) {
    abandonApprovals(conversation);
    if (conversation.messages.length === 0) {
      const first = messages[0]!.content || "Voice conversation";
      conversation.title = first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
    conversation.messages.push(...messages);
    await saveConversation(session, conversation);
  }
  return new Response(null, { status: 204 });
};
