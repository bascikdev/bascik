// POST /api/send: add the visitor's message, then go back to the app's page,
// which streams the reply. Every form posts here, including the forms the
// model generates.
//
// During a voice call the reader's message goes to the speech model, not to a
// typed reply. A form posted with voice=1 is answered with what it says,
// { "say": "..." }, and nothing is added here: the call stores its own turns.
import {
  abandonApprovals,
  backToChat,
  loadConversation,
  newConversation,
  saveConversation,
  sessionFor,
} from "../lib/chat.ts";

const MAX_LENGTH = 4000;

/** A form with a `text` field sends that; any other form sends `Label: value` lines. */
function messageFrom(form: FormData): string {
  const text = form.get("text");
  if (typeof text === "string") return text.trim();
  const lines: string[] = [];
  for (const [name, value] of form) {
    if (
      name !== "app" &&
      name !== "voice" &&
      typeof value === "string" &&
      value.trim()
    ) {
      lines.push(`${name}: ${value.trim()}`);
    }
  }
  return lines.join("\n");
}

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const named = form.get("app");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const text = messageFrom(form).slice(0, MAX_LENGTH);
  if (form.get("voice") === "1") {
    return Response.json(
      { say: text },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const conversation = (await loadConversation(session)) ?? newConversation();
  if (text) {
    if (conversation.messages.length === 0) {
      conversation.title = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    }
    abandonApprovals(conversation);
    conversation.messages.push({ role: "user", content: text });
    await saveConversation(session, conversation);
  }
  return backToChat(session, conversation.id);
};
