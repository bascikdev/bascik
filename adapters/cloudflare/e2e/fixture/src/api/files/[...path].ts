export const GET = async (
  _request: Request,
  context: { params: Record<string, string | string[]>; platform?: { name: string } },
): Promise<Response> =>
  Response.json({ route: 'catch-all', segments: context.params.path, platform: context.platform?.name ?? 'unknown' });
