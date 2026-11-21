import { describe, expect, it } from "vitest";
import { listenError } from "./listen-errors.ts";

const nodeError = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code, syscall: "listen" });

describe("listenError", () => {
  it("explains a privileged port and keeps the code and cause", () => {
    const cause = nodeError(
      "EACCES",
      "listen EACCES: permission denied ::1:80",
    );
    const error = listenError(cause, 80, "localhost");
    expect(error.message).toMatch(
      /^\[bascik\] error: permission denied to listen on localhost:80 \(EACCES\)\. Ports below 1024 need administrator privileges\. Use port 1024 or higher/,
    );
    expect(error.message).toMatch(/reverse proxy/);
    expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
    expect(error.cause).toBe(cause);
  });

  it("does not blame privileges for a high port the system refuses", () => {
    const error = listenError(nodeError("EACCES", "denied"), 5357, "0.0.0.0");
    expect(error.message).toMatch(/may be reserved/);
    expect(error.message).not.toMatch(/below 1024/);
  });

  it("names a host that is not this computer's", () => {
    const error = listenError(
      nodeError("EADDRNOTAVAIL", "address not available"),
      8080,
      "192.0.2.1",
    );
    expect(error.message).toMatch(
      /^\[bascik\] error: cannot listen on 192\.0\.2\.1:8080 \(EADDRNOTAVAIL\): "192\.0\.2\.1" is not an address of this computer\. Use localhost, 0\.0\.0\.0/,
    );
    expect(error.message).toMatch(/--host/);
  });

  it("brackets an IPv6 host in the address", () => {
    const error = listenError(
      nodeError("EADDRNOTAVAIL", "x"),
      8080,
      "fe80::99",
    );
    expect(error.message).toMatch(/cannot listen on \[fe80::99\]:8080/);
  });

  it("returns any other error unchanged", () => {
    const other = nodeError("EINVAL", "listen EINVAL");
    expect(listenError(other, 8080, "localhost")).toBe(other);
  });
});
