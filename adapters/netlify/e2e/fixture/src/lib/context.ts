import type { Context } from "@netlify/functions";
import type { ApiHandlerContext } from "@bascik/bascik/runtime";

export type NetlifyFixtureContext = Omit<ApiHandlerContext, "platform"> & {
  platform: {
    name: "netlify";
    context: Context;
    waitUntil: (promise: Promise<unknown>) => void;
  };
};
