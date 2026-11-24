// POST /api/model: remember which model the visitor picked, then go back to
// the page they were on. The form sends one field, `model`, holding an id
// from the server's own list; anything else is ignored.
import { sessionFor } from "../lib/chat.ts";
import { listModels, modelCookie, pickModel } from "../lib/models.ts";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const named = form.get("app");
  const wanted = form.get("model");
  const session = sessionFor(
    request,
    typeof named === "string" ? named : undefined,
  );
  const choice = pickModel(
    await listModels(),
    typeof wanted === "string" ? wanted : undefined,
  );
  return new Response(null, {
    status: 303,
    headers: {
      location: session.app.path,
      "set-cookie": modelCookie(choice.id),
    },
  });
};
