import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";

// vi.hoisted() runs before vi.mock() factories so the same vi.fn() references
// are used in both the factory (which is hoisted) and the test file.
const { _mockAccess, _mockExec, _mockExecFile, _mockRm } = vi.hoisted(() => ({
  _mockAccess: vi.fn(),
  _mockExec: vi.fn(),
  _mockExecFile: vi.fn(),
  _mockRm: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  access: _mockAccess,
  rm: _mockRm,
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
    mockAccess.mockImplementation(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
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

    vi.spyOn(console, "log").mockImplementation(() => { });
    await createSelfSignedCert();

    const opensslCall = mockExecFile.mock.calls.find((c: any[]) => c[0] === "openssl");
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

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });
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
    mockAccess.mockImplementation(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
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
      ensureCertificates({ keyFile: "custom-key.pem", certFile: "custom-cert.pem" })
    ).rejects.toThrow("Custom TLS certificate files are configured but could not be found.");
  });

  it("uses custom certificate paths if they exist", async () => {
    mockAccess.mockResolvedValue(undefined);
    const paths = await ensureCertificates({ keyFile: "custom-key.pem", certFile: "custom-cert.pem" });
    expect(paths.keyPath).toContain("custom-key.pem");
    expect(paths.certPath).toContain("custom-cert.pem");
  });

  it("uses mkcert if available when default certs are missing", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockExecFile.mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") cb(null, { stdout: "mkcert output", stderr: "" });
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    const paths = await ensureCertificates();
    expect(paths.keyPath).toContain("bascik-privkey.pem");
    expect(consoleSpy).toHaveBeenCalledWith("SSL: generated trusted certs via mkcert");
  });
});

