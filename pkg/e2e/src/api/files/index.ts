/** The bare `/api/files` path: a required catch-all does not match zero segments. */
export const GET = async (): Promise<Response> => Response.json({ route: 'index' });
