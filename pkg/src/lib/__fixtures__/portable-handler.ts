// Positive control for serverless-contract.test.ts: a handler that uses only
// Web platform APIs. It must bundle for `platform: "browser"` with no errors.
export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  return Response.json({ path: url.pathname });
};
