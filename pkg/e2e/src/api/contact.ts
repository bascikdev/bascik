export const POST = async (request: Request): Promise<Response> => {
  const data = await request.json().catch(() => ({}));
  if (!data.name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }
  return Response.json({ ok: true, received: data }, { status: 201 });
};
