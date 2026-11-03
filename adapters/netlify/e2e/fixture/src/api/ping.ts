import type { NetlifyFixtureContext } from "../lib/context.ts";

export const GET = (_request: Request, { platform }: NetlifyFixtureContext) =>
  Response.json({ pong: true, platform: platform.name });
