export const GET = () => Response.json({ fixture: "cloudflare" });

export const POST = async (request: Request) =>
  Response.json(
    { body: await request.text() },
    { status: 201, headers: { "x-fixture": "echo" } },
  );
