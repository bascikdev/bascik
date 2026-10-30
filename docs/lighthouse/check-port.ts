/**
 * Fails an audit run before it builds anything when the Lighthouse port is already taken. Lighthouse CI only warns
 * when the server it starts never prints its ready line, then audits whatever answers on the port, such as a server
 * left over from an earlier run. Checking first turns that into a located error.
 *
 * Run with (cwd docs/):
 *   node lighthouse/check-port.ts
 */
import { connect } from "node:net";
import { LIGHTHOUSE_PORT } from "./site.ts";

/** Whether something accepts connections on `host`:`port`. Any connect error (refused, no IPv6) counts as free. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Resolves when nothing answers on `port` over IPv4 or IPv6 loopback; rejects with an error naming the port and what
 * to do otherwise. It connects rather than binds, because a wildcard bind can succeed beside a server on localhost.
 */
export async function assertPortFree(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new RangeError(
      `The Lighthouse port must be a port number from 1 to 65535 (received ${JSON.stringify(port)}).`,
    );
  const taken = await Promise.all(
    ["127.0.0.1", "::1"].map((host) => answers(host, port)),
  );
  if (taken.some(Boolean))
    throw new Error(
      `Port ${port} is already in use, and the Lighthouse audits serve the docs there (docs/lighthouse/site.ts). ` +
        `Stop the process on that port (often a server left from an earlier \`yarn lighthouse\`) and run again.`,
    );
}

const isMain = process.argv[1]?.endsWith("check-port.ts");

if (isMain) {
  try {
    await assertPortFree(LIGHTHOUSE_PORT);
  } catch (error) {
    console.error(`[lighthouse] ${(error as Error).message}`);
    process.exit(1);
  }
}
