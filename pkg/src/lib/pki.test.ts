import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";

// vi.hoisted() runs before vi.mock() factories so the same vi.fn() references
// are used in both the factory (which is hoisted) and the test file.
const {
  _mockAccess,
  _mockExec,
  _mockExecFile,
  _mockRm,
  _mockReadFile,
  certState,
} = vi.hoisted(() => ({
  _mockAccess: vi.fn(),
  _mockExec: vi.fn(),
  _mockExecFile: vi.fn(),
  _mockRm: vi.fn().mockResolvedValue(undefined),
  _mockReadFile: vi.fn(),
  /** What the stand-in X509Certificate parses; `null` means not a certificate. */
  certState: {
    dates: null as null | { validFrom: string; validTo: string },
  },
}));

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  access: _mockAccess,
  rm: _mockRm,
  readFile: _mockReadFile,
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  X509Certificate: class {
    validFrom: string;
    validTo: string;
    constructor() {
      if (!certState.dates) throw new Error("error:0680007B:asn1 header");
      this.validFrom = certState.dates.validFrom;
      this.validTo = certState.dates.validTo;
    }
  },
}));

vi.mock("node:child_process", () => ({
  exec: _mockExec,
  execFile: _mockExecFile,
}));

vi.mock("node:os", () => ({
  default: { platform: vi.fn().mockReturnValue("linux") },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { createSelfSignedCert, ensureCertificates } from "./pki.ts";

const mockAccess = _mockAccess;
const mockExec = _mockExec;
const mockExecFile = _mockExecFile;
const mockRm = _mockRm;
const mockPlatform = (os as any).platform as ReturnType<typeof vi.fn>;

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockAccess.mockReset();
  mockExec.mockReset();
  mockExecFile.mockReset();
  mockRm.mockReset();
  mockRm.mockResolvedValue(undefined);
  mockPlatform.mockReturnValue("linux");
  mockAccess.mockResolvedValue(undefined); // default: certs exist → early return
  _mockReadFile.mockReset();
  _mockReadFile.mockResolvedValue(Buffer.from("-----BEGIN CERTIFICATE-----"));
  certState.dates = {
    validFrom: "Jan  1 00:00:00 2020 GMT",
    validTo: "Jan  1 00:00:00 2999 GMT",
  };
  mockExecFile.mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(new Error("mkcert not found"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Certs already exist
// ─────────────────────────────────────────────────────────────────────────────

describe("createSelfSignedCert – certs already exist", () => {
  it("returns early without calling exec when both cert and key exist", async () => {
    mockAccess.mockResolvedValue(undefined); // both access calls succeed
    await createSelfSignedCert();
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cert generation – Unix / Windows / OpenSSL
// ─────────────────────────────────────────────────────────────────────────────

describe("createSelfSignedCert – OpenSSL SAN cert generation", () => {
  beforeEach(() => {
    mockAccess.mockReset();
    mockAccess.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockPlatform.mockReturnValue("linux");
  });

  it("calls execFile with openssl req and SubjectAltName extension", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], cb: any) => {
      const callback = typeof args === "function" ? args : cb;
      if (cmd === "openssl") {
        callback(null, { stdout: "", stderr: "" });
      } else {
        callback(new Error("mkcert not found"));
      }
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    await createSelfSignedCert();

    const opensslCall = mockExecFile.mock.calls.find(
      (c: any[]) => c[0] === "openssl",
    );
    expect(opensslCall).toBeDefined();
    const args = opensslCall![1] as string[];
    expect(args).toContain("req");
    expect(args).toContain("-addext");
    expect(args.some((a) => a.includes("subjectAltName="))).toBe(true);
    expect(args.some((a) => a.includes("DNS:localhost"))).toBe(true);
    expect(args.some((a) => a.includes("IP:127.0.0.1"))).toBe(true);
  });

  it("logs success after generating the cert", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], cb: any) => {
      const callback = typeof args === "function" ? args : cb;
      if (cmd === "openssl") {
        callback(null, { stdout: "", stderr: "" });
      } else {
        callback(new Error("mkcert not found"));
      }
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createSelfSignedCert();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Generated self-signed certificate"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure handling
// ─────────────────────────────────────────────────────────────────────────────

describe("createSelfSignedCert – exec failure", () => {
  beforeEach(() => {
    mockAccess.mockReset();
    mockAccess.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("throws with clear message when openssl fails", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: any, cb: any) => {
      const callback = typeof _args === "function" ? _args : cb;
      callback(new Error("openssl missing"));
    });
    await expect(createSelfSignedCert()).rejects.toThrow(
      /Failed to generate self-signed certificate/,
    );
  });
});

describe("ensureCertificates", () => {
  beforeEach(() => {
    mockAccess.mockReset();
    mockExec.mockReset();
    mockExecFile.mockReset();
    mockExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") cb(new Error("mkcert not found"));
    });
  });

  it("throws if custom certificate files are specified but missing", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    await expect(
      ensureCertificates({
        keyFile: "custom-key.pem",
        certFile: "custom-cert.pem",
      }),
    ).rejects.toThrow(
      "Custom TLS certificate files are configured but could not be found.",
    );
  });

  it("uses custom certificate paths if they exist", async () => {
    mockAccess.mockResolvedValue(undefined);
    const paths = await ensureCertificates({
      keyFile: "custom-key.pem",
      certFile: "custom-cert.pem",
    });
    expect(paths.keyPath).toContain("custom-key.pem");
    expect(paths.certPath).toContain("custom-cert.pem");
  });

  it("uses mkcert if available when default certs are missing", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function")
        cb(null, { stdout: "mkcert output", stderr: "" });
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const paths = await ensureCertificates();
    expect(paths.keyPath).toContain("bascik-privkey.pem");
    expect(consoleSpy).toHaveBeenCalledWith(
      "SSL: generated trusted certs via mkcert",
    );
  });
});

// F077: the openssl fallback issues a 365-day certificate, and the default
// files were reused forever, so a year later every browser refused the
// server with nothing in the console pointing at the expired file.
describe("ensureCertificates – reused certificate dates", () => {
  const mkcertSucceeds = () =>
    mockExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") cb(null, { stdout: "", stderr: "" });
    });

  it("regenerates an expired default certificate and says why", async () => {
    certState.dates = {
      validFrom: "Jan  1 00:00:00 2020 GMT",
      validTo: "Jan  1 00:00:00 2021 GMT",
    };
    mkcertSucceeds();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const paths = await ensureCertificates();
    expect(paths.certPath).toContain("bascik-cert.pem");
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("bascik-cert.pem");
    expect(message).toMatch(/expired on Jan {1,2}1 00:00:00 2021 GMT/);
    expect(message).toMatch(/generating a new one/);
    expect(mockExecFile).toHaveBeenCalledWith(
      "mkcert",
      expect.arrayContaining([paths.certPath]),
      expect.any(Function),
    );
  });

  it("regenerates a default certificate that is not valid yet", async () => {
    certState.dates = {
      validFrom: "Jan  1 00:00:00 2998 GMT",
      validTo: "Jan  1 00:00:00 2999 GMT",
    };
    mkcertSucceeds();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await ensureCertificates();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/not valid until/);
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("reuses a current default certificate without generating or warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await ensureCertificates();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("never replaces an expired custom certificate, but warns naming it", async () => {
    certState.dates = {
      validFrom: "Jan  1 00:00:00 2020 GMT",
      validTo: "Jan  1 00:00:00 2021 GMT",
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paths = await ensureCertificates({
      keyFile: "custom-key.pem",
      certFile: "custom-cert.pem",
    });
    expect(paths.certPath).toContain("custom-cert.pem");
    expect(mockExecFile).not.toHaveBeenCalled();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("custom-cert.pem");
    expect(message).toMatch(/expired/);
    expect(message).toMatch(/http\.tls\.certFile/);
  });

  it("leaves a file it cannot parse to the TLS server, which reports it", async () => {
    certState.dates = null;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paths = await ensureCertificates();
    expect(paths.certPath).toContain("bascik-cert.pem");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
