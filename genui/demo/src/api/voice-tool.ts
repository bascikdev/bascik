// POST /api/voice-tool: run a tool call a voice model made. The browser holds
// the connection to the model, so the call arrives there; it is sent here to
// be checked, run, and drawn, and the browser passes the result back.
//
//   app=books  id=<the call's id>  name=place_hold  input={"title":"..."}
//   decision=approve|deny   (only to answer a call that waits for approval)
//
// Answers { state, output?, view }. `output` is what to tell the model, and
// is absent while the call waits for the reader. `view` is true when the call
// has something to put on screen, which the page reads from /voice-view.
import { runVoiceTool } from "@bascik/genui/voice";
import {
  loadCatalog,
  loadConversation,
  renderOptions,
  sessionFor,
  voiceState,
} from "../lib/chat.ts";

const MAX_INPUT = 64_000;

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const named = form.get("app");
  const id = form.get("id");
  const name = form.get("name");
  const raw = form.get("input");
  const decision = form.get("decision");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const conversation = await loadConversation(session);
  if (
    !conversation ||
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof raw !== "string" ||
    raw.length > MAX_INPUT ||
    (decision !== null && decision !== "approve" && decision !== "deny")
  ) {
    return new Response("Not a tool call.", { status: 400 });
  }
  let input: unknown;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    // Passed on as it is: the call is refused, and the model is told.
    input = raw;
  }
  const state = voiceState(conversation.id);
  const result = await runVoiceTool(
    state.turn,
    { id, name, input, ...(decision ? { decision } : {}) },
    session.app.tools,
    await loadCatalog(),
    renderOptions(session.app),
  );
  if (result.html) state.views.set(id, result.html);
  return Response.json(
    { state: result.state, output: result.output, view: result.html !== "" },
    { headers: { "cache-control": "no-store" } },
  );
};
