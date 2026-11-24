// POST /api/open: switch to another conversation, or start a new one when the
// form names none.
import { backToChat, loadConversation, newConversation } from "../lib/chat.ts";

export const POST = async (request: Request): Promise<Response> => {
  const id = (await request.formData()).get("id");
  const conversation =
    (await loadConversation(typeof id === "string" ? id : undefined)) ??
    newConversation();
  return backToChat(request, conversation.id);
};
