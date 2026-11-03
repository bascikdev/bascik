import type { ApiHandlerContext } from "@bascik/bascik/runtime";

export const GET = (request: Request, { params }: ApiHandlerContext) => {
  const rawPath = new URL(request.url).pathname;
  const segments = Array.isArray(params.path)
    ? params.path
    : params.path.split("/");
  if (
    rawPath.includes("//") ||
    segments.some((segment) => !segment || /[\/\\\0]/.test(segment))
  ) {
    return Response.json({ error: "Invalid path" }, { status: 400 });
  }

  return Response.json({ route: "catch-all", segments });
};
