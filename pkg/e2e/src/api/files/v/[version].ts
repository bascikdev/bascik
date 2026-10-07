/** `[param]` route that must win over the sibling catch-all for exactly `/api/files/v/<one>`. */
export const GET = async (
  _request: Request,
  context: { params: Record<string, string | string[]> }
): Promise<Response> => Response.json({ route: 'param', version: context.params.version });
