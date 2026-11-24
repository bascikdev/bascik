// POST /api/send: add the visitor's message, then go back to the chat page,
// which streams the reply. Every form in the app posts here, including the
// forms the model generates.
import {
  backToChat,
  currentId,
  loadConversation,
  newConversation,
  saveConversation,
} from "../lib/chat.ts";

const MAX_LENGTH = 4000;

/** A form with a `text` field sends that; any other form sends `Label: value` lines. */
function messageFrom(form: FormData): string {
  const text = form.get("text");
  if (typeof text === "string") return text.trim();
  const lines: string[] = [];
  for (const [name, value] of form) {
    if (typeof value === "string" && value.trim()) {
      lines.push(`${name}: ${value.trim()}`);
    }
  }
  return lines.join("\n");
}

export const POST = async (request: Request): Promise<Response> => {
  const text = messageFrom(await request.formData()).slice(0, MAX_LENGTH);
  const conversation =
    (await loadConversation(currentId(request))) ?? newConversation();
  if (text) {
    if (conversation.messages.length === 0) {
      conversation.title = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    }
    conversation.messages.push({ role: "user", content: text });
    await saveConversation(conversation);
  }
  return backToChat(request, conversation.id);
};
