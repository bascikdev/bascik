// POST /api/result: the result of a client tool call, sent by the form the
// call was drawn as. A script in the reader's browser fills the form in and
// sends it; without scripts the reader does.
//
//   app=books  call=<the tool call's id>  output=<the result, as text>
//
// The result is stored on the tool part, and the page this redirects to
// carries the turn on, so the model reads it like any other tool's output.
import { answerToolCall } from "@bascik/genui";
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
  const output = form.get("output");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const conversation = await loadConversation(session);
  if (
    !conversation ||
    typeof call !== "string" ||
    typeof output !== "string" ||
    !output.trim() ||
    !answerToolCall(conversation.messages, call, output.trim())
  ) {
    return new Response("No tool call is waiting for that result.", {
      status: 400,
    });
  }
  await saveConversation(session, conversation);
  return backToChat(session, conversation.id);
};
