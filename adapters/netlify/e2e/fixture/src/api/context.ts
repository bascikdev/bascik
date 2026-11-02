import type { NetlifyFixtureContext } from "../lib/context.ts";

export const GET = (_request: Request, { platform }: NetlifyFixtureContext) =>
  Response.json({
    platform: platform.name,
    hasCookies: typeof platform.context.cookies.get === "function",
    hasWaitUntil: typeof platform.waitUntil === "function",
    nodeMajor: Number(process.versions.node.split(".")[0]),
  });
