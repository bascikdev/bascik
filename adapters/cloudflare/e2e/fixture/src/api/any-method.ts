// A general handler: `export default` answers every allowed method the file has no named export for.
// GET stays a named export, so it wins over the default.
export const GET = (): Response => Response.json({ handledBy: "GET" });

export default async (
  request: Request,
  context: { platform?: { name: string } },
): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "https://books.example",
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
      },
    });
  }
  const body = request.body ? await request.text() : "";
  return Response.json({
    handledBy: "default",
    method: request.method,
    body,
    platform: context.platform?.name ?? "unknown",
  });
};
