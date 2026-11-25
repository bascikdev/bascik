// The Worker `bascik --build --target cloudflare` writes to
// dist/.bascik/cloudflare/worker.js, imported by worker.ts through the
// `bascik-worker` alias in wrangler.wrapper.jsonc.
declare module "bascik-worker" {
  const worker: {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
  export default worker;
}
