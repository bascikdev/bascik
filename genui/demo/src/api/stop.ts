// POST /api/stop: end the reply that is being written for the visitor's open
// conversation, and answer once what it had written is stored. The client
// runtime's Stop button posts here; the open response then ends by itself.
import { sessionFor, stopTurn } from "../lib/chat.ts";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const named = form.get("app");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const stopped =
    session.conversationId !== undefined &&
    (await stopTurn(session.conversationId));
  return new Response(null, { status: stopped ? 204 : 404 });
};
