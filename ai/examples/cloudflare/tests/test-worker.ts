// The Worker the Durable Object tests run against (tests/wrangler.test.jsonc):
// the example's three classes, without the built Bascik worker in front.
export { Budget } from "../do/budget.ts";
export { ConversationLive } from "../do/conversation-live.ts";
export { ReaderData } from "../do/reader-data.ts";

export default {
  async fetch(): Promise<Response> {
    return new Response("The Durable Object test worker.", { status: 404 });
  },
};
