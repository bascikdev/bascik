/**
 * A Microsoft Entra token from the Azure CLI (`az login`), kept until five
 * minutes before it runs out. For a developer's machine: a deployed server
 * uses a managed identity or a key.
 */
const tokens = new Map<string, { value: string; until: number }>();

export async function azureCliToken(scope: string): Promise<string> {
  const kept = tokens.get(scope);
  if (kept && kept.until > Date.now()) return kept.value;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(
    "az",
    [
      "account",
      "get-access-token",
      "--scope",
      scope,
      "--query",
      "{value: accessToken, expires: expires_on}",
      "-o",
      "json",
    ],
    { timeout: 20_000 },
  );
  const { value, expires } = JSON.parse(stdout) as {
    value: string;
    expires: number;
  };
  tokens.set(scope, { value, until: expires * 1000 - 300_000 });
  return value;
}
