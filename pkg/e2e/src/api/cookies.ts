export const GET = async (): Promise<Response> => {
  const headers = new Headers();
  headers.append("Set-Cookie", "session=abc123; Path=/; HttpOnly");
  headers.append("Set-Cookie", "theme=dark; Path=/; SameSite=Strict");
  return new Response("cookies-set", { headers });
};
