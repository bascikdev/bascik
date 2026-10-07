/** Static route that must win over the sibling catch-all for `/api/files/latest`. */
export const GET = async (): Promise<Response> => Response.json({ route: 'static', name: 'latest' });
