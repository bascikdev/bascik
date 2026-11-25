// POST /api/voice-session: start a spoken conversation. Answers with a
// ticket the browser uses to connect to the voice provider itself:
//
//   { "protocol": "gemini-live", "url": "wss://...access_token=...", "setup": {...} }
//
// The ticket is good for one session, for a minute, and has the app's
// instructions and tools locked into it. The API key never leaves the server.
// 404 when this server has no voice provider.
import { voiceTools } from "@bascik/genui/voice";
import {
  chatCookies,
  loadConversation,
  loadVoice,
  newConversation,
  saveConversation,
  sessionFor,
  voiceSystemPrompt,
} from "../lib/chat.ts";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const named = form.get("app");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const voice = await loadVoice();
  if (!voice) {
    return new Response("This server has no voice provider.", { status: 404 });
  }
  // What is said is stored, so there has to be a conversation to store it in.
  let conversation = await loadConversation(session);
  if (!conversation) {
    conversation = newConversation();
    await saveConversation(session, conversation);
  }
  let ticket;
  try {
    ticket = await voice.createSession({
      system: await voiceSystemPrompt(session.app),
      tools: voiceTools(session.app.tools),
    });
  } catch (error) {
    console.error(`[${session.app.id}] no voice session:`, error);
    return new Response("The voice provider did not answer.", { status: 502 });
  }
  const headers = chatCookies(session, conversation.id);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(ticket), { headers });
};
