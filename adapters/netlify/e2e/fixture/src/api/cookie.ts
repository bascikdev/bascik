import type { NetlifyFixtureContext } from "../lib/context.ts";

export const GET = (_request: Request, { platform }: NetlifyFixtureContext) =>
  Response.json(
    { value: platform.context.cookies.get("bascik_fixture") ?? null },
    { headers: { "cache-control": "private, no-store" } },
  );

export const POST = (request: Request, { platform }: NetlifyFixtureContext) => {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) {
    return Response.json({ error: "Origin rejected" }, { status: 403 });
  }
  platform.context.cookies.set({
    name: "bascik_fixture",
    value: "milk-frother",
    path: "/",
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax",
    maxAge: 60,
  });
  return Response.json(
    { ok: true },
    { headers: { "cache-control": "private, no-store" } },
  );
};
