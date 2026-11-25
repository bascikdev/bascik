// Stands in for the Worker Bascik generates (the `bascik-worker` alias) in
// tests/wrapper.workers.test.ts: it answers 200 and records what reached it,
// so a test can tell a request the wrapper refused from one it passed on.
export const reached: string[] = [];

export default {
  async fetch(request: Request): Promise<Response> {
    reached.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response("from the Bascik worker");
  },
};
