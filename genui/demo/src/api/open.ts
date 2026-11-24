// POST /api/open: switch to another conversation of the app, or start a new
// one when the form names none.
import {
  backToChat,
  loadConversation,
  newConversation,
  sessionFor,
} from "../lib/chat.ts";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const named = form.get("app");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const id = form.get("id");
  const conversation =
    (await loadConversation(session, typeof id === "string" ? id : "")) ??
    newConversation();
  return backToChat(session, conversation.id);
};
