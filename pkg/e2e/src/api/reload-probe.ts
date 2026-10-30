// Only the dev lane's API module reload test (dev-server-reload.test.ts)
// requests and rewrites this route. Production servers import API handlers
// from the source tree on the first request, so the edit target is kept apart
// from routes the other lanes call (such as health.ts).
export const GET = async (): Promise<Response> => {
  return Response.json({ ok: true, status: "healthy" });
};
