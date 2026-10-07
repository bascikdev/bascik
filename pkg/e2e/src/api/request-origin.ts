export const GET = async (
  request: Request,
  context: { params: Record<string, string>; remoteIp: string }
): Promise<Response> => {
  const url = new URL(request.url);
  return Response.json({
    ok: true,
    url: request.url,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    remoteIp: context.remoteIp,
  });
};
