// Negative control for serverless-contract.test.ts: free Node globals are not
// imports, so esbuild bundles this for `platform: "browser"` without an error.
// The bundle text scan must still reject it.
export const GET = async (): Promise<Response> =>
  Response.json({
    env: process.env.BASCIK_SITE_URL,
    bytes: Buffer.byteLength("x"),
  });
