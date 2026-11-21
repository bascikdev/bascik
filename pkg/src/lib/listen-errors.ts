/**
 * The error a server prints when it cannot listen on its address.
 *
 * Node's own message (`listen EACCES: permission denied ::1:80`, `listen
 * EADDRNOTAVAIL: address not available 192.0.2.1:8080`) names the syscall
 * and stops there. These say which setting chose the address and what to
 * use instead. Any other error is returned unchanged.
 */

/** Ports below this need privileges on Linux, and on macOS for some addresses. */
const FIRST_UNPRIVILEGED_PORT = 1024;

const PORT_SETTINGS = "--port, BASCIK_SERVER_PORT, PORT or http.port";
const HOST_SETTINGS = "--host, BASCIK_SERVER_HOST or http.hostname";

export const listenError = (
  error: NodeJS.ErrnoException,
  port: number,
  hostname: string,
): Error => {
  const address = hostname.includes(":")
    ? `[${hostname}]:${port}`
    : `${hostname}:${port}`;
  if (error.code === "EACCES") {
    const hint =
      port < FIRST_UNPRIVILEGED_PORT
        ? `Ports below ${FIRST_UNPRIVILEGED_PORT} need administrator privileges. ` +
          `Use port ${FIRST_UNPRIVILEGED_PORT} or higher (${PORT_SETTINGS}), ` +
          `and put a reverse proxy or your host's port mapping in front of it to serve port ${port}.`
        : `The system does not let this user listen on port ${port} (it may be reserved). ` +
          `Use another port (${PORT_SETTINGS}).`;
    return Object.assign(
      new Error(
        `[bascik] error: permission denied to listen on ${address} (EACCES). ${hint}`,
        { cause: error },
      ),
      { code: error.code },
    );
  }
  if (error.code === "EADDRNOTAVAIL") {
    return Object.assign(
      new Error(
        `[bascik] error: cannot listen on ${address} (EADDRNOTAVAIL): "${hostname}" is not an address of this computer. ` +
          `Use localhost, 0.0.0.0 (every network interface), or an address one of this computer's ` +
          `network interfaces has (${HOST_SETTINGS}).`,
        { cause: error },
      ),
      { code: error.code },
    );
  }
  return error;
};
