/**
 * Catch-all example: `/api/files/<one or more segments>`.
 * `context.params.path` is a decoded string[] with segment boundaries preserved.
 */
export const GET = async (
  request: Request,
  context: { params: Record<string, string | string[]> }
): Promise<Response> => {
  return Response.json({
    route: 'catch-all',
    segments: context.params.path,
    path: new URL(request.url).pathname,
  });
};

export const POST = async (
  request: Request,
  context: { params: Record<string, string | string[]> }
): Promise<Response> => {
  return Response.json({
    route: 'catch-all',
    segments: context.params.path,
    echoed: await request.text(),
  }, { status: 201 });
};
