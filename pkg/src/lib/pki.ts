import { access, chmod } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFile = promisify(execFileCb);

export interface EnsureCertificatesOptions {
  keyFile?: string;
  certFile?: string;
}

export const ensureCertificates = async (
  options: EnsureCertificatesOptions = {}
): Promise<{ keyPath: string; certPath: string }> => {
  const usingCustomCerts = !!(options.keyFile || options.certFile);
  const keyPath = resolve(process.cwd(), options.keyFile ?? "bascik-privkey.pem");
  const certPath = resolve(process.cwd(), options.certFile ?? "bascik-cert.pem");

  let certsPresent = false;
  try {
    await Promise.all([access(keyPath), access(certPath)]);
    certsPresent = true;
  } catch {
    certsPresent = false;
  }

  if (certsPresent) {
    return { keyPath, certPath };
  }

  if (usingCustomCerts) {
    throw new Error(
      "Custom TLS certificate files are configured but could not be found.\n" +
      `  keyFile:  ${keyPath}\n` +
      `  certFile: ${certPath}\n` +
      "Ensure both files exist before starting the server."
    );
  }

  // Try mkcert first
  try {
    const { stdout, stderr } = await execFile(
      "mkcert",
      ["-key-file", keyPath, "-cert-file", certPath, "localhost", "127.0.0.1", "::1"],
    );
    if (stdout && stdout.trim()) console.log(stdout.trim());
    if (stderr && stderr.trim()) console.log(stderr.trim());
    console.log("SSL: generated trusted certs via mkcert");
    try { await chmod(keyPath, 0o600); } catch { }
    return { keyPath, certPath };
  } catch (mkcertErr) {
    console.log(`SSL: mkcert not found or failed (${(mkcertErr as Error).message?.split("\n")[0]}), falling back to openssl`);
  }

  try {
    // Standard OpenSSL generation with SubjectAltName covering localhost, 127.0.0.1, ::1
    await execFile("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "365",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);

    try { await chmod(keyPath, 0o600); } catch { }

    console.log("Generated self-signed certificate for the development server");
    return { keyPath, certPath };
  } catch (err) {
    throw new Error(
      "Failed to generate self-signed certificate for the development server: " +
      (err instanceof Error ? err.message : String(err)) +
      "\nEnsure `openssl` or `mkcert` is installed and available in PATH."
    );
  }
};

export const createSelfSignedCert = async (): Promise<void> => {
  await ensureCertificates();
};


