// POST /api/decide: record one review decision, then go back to the review
// page, which streams the assistant's next step. Every review component
// (fact-check, decision-fork, code-map, gap-question, plan-review) is a plain
// form that posts here. The body is the form's named fields and nothing else:
//
//   app=review  kind=fact  item=returns-window  verdict=confirmed  note=...
//
// The decision is appended to the visitor's log as one line of JSON, and added
// to the conversation as the reviewer's message, so the model sees it too.
//
// During a voice call (voice=1) the decision is recorded the same way, and
// the answer is { "say": "..." }: the reviewer's message, for the call to say
// to the speech model and store with its own turn.
import {
  abandonApprovals,
  backToChat,
  loadConversation,
  newConversation,
  saveConversation,
  sessionFor,
} from "../lib/chat.ts";
import {
  decisionFrom,
  decisionMessage,
  recordDecision,
} from "../lib/review.ts";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const decision = decisionFrom(form);
  if (!decision) {
    return new Response("Not a review decision.", { status: 400 });
  }
  const session = sessionFor(request, "review");
  const conversation = (await loadConversation(session)) ?? newConversation();
  if (conversation.messages.length === 0) {
    conversation.title = `Review: ${decision.item}`;
  }
  if (form.get("voice") === "1") {
    await saveConversation(session, conversation);
    await recordDecision(session.visitor, conversation.id, decision);
    return Response.json(
      { say: decisionMessage(decision) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  abandonApprovals(conversation);
  conversation.messages.push({
    role: "user",
    content: decisionMessage(decision),
  });
  await saveConversation(session, conversation);
  await recordDecision(session.visitor, conversation.id, decision);
  return backToChat(session, conversation.id);
};
