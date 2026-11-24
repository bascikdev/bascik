// POST /api/approve: the reader's answer to a tool call that needs their
// say-so. The approval card is a plain form that posts here:
//
//   app=books  call=<the tool call's id>  verdict=approve|deny
//
// The answer is stored on the tool part. Nothing runs here: the page this
// redirects to carries the turn on, runs an approved call, and tells the
// model what happened either way.
import { decideToolCall } from "@bascik/genui";
import {
  backToChat,
  loadConversation,
  saveConversation,
  sessionFor,
} from "../lib/chat.ts";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const named = form.get("app");
  const call = form.get("call");
  const verdict = form.get("verdict");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const conversation = await loadConversation(session);
  if (
    !conversation ||
    typeof call !== "string" ||
    (verdict !== "approve" && verdict !== "deny") ||
    !decideToolCall(conversation.messages, call, verdict === "approve")
  ) {
    return new Response("No tool call is waiting for that answer.", {
      status: 400,
    });
  }
  await saveConversation(session, conversation);
  return backToChat(session, conversation.id);
};
