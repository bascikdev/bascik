export const GET = async (
  request: Request,
  context: { params: Record<string, string> }
): Promise<Response> => {
  return Response.json({
    userId: context.params.id,
    path: new URL(request.url).pathname,
  });
};
