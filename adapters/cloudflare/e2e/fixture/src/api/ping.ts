export const GET = async (
  _request: Request,
  context: { remoteIp: string; platform?: { name: string } },
): Promise<Response> => Response.json({ pong: true, platform: context.platform?.name ?? 'unknown' });
