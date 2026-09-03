export const GET = async (
  request: Request,
  context: { params: Record<string, string>; remoteIp: string }
): Promise<Response> => {
  return Response.json({
    ok: true,
    status: "healthy",
    remoteIp: context.remoteIp,
  });
};
