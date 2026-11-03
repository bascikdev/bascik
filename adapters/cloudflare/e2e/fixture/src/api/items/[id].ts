import type { ApiHandlerContext } from "@bascik/bascik/runtime";

export const GET = (_request: Request, { params }: ApiHandlerContext) =>
  Response.json({ id: params.id });
