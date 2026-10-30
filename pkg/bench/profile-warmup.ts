/**
 * Warm the process-wide state that a CPU sampler must not interrupt while it initializes.
 *
 * On Node 24/macOS a thread that is being sampled (SIGPROF from native `--cpu-prof` or the inspector Profiler)
 * while it takes a process-wide pthread rwlock for the first time can block on that lock forever, with no other
 * thread holding it. The lock-heavy first uses are OpenSSL's provider and method store (`crypto.getCiphers`,
 * which `import "node:http"` reaches through undici, http2 and tls; the first fetch of each digest; parsing the
 * default and system CA stores) and the builtin loader. About 5% of 200 concurrent `import "node:http"` processes
 * under native `--cpu-prof` stalled; with this warm-up done unsampled and the profiler started after it, none of
 * 600 did, TLS http2 traffic included. A loaded test suite turned that 5% into "capture deadline exceeded".
 *
 * Everything here is idempotent and cached by Node afterwards, so the profiled work behaves as before; the
 * profile only loses the warm-up itself, which is no part of any measured phase.
 */
const BUILTINS = [
  "node:assert",
  "node:child_process",
  "node:crypto",
  "node:dns",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:http2",
  "node:https",
  "node:inspector",
  "node:module",
  "node:net",
  "node:os",
  "node:path",
  "node:perf_hooks",
  "node:stream",
  "node:stream/web",
  "node:tls",
  "node:url",
  "node:util",
  "node:worker_threads",
  "node:zlib",
];

// MD5 and SHA-1 are listed on purpose: each digest's first use takes the OpenSSL lock, so every digest the profiled
// work may reach is fetched once here. Nothing is hashed for integrity or secrecy; the input is the empty string.
const DIGESTS = ["md5", "sha1", "sha256", "sha384", "sha512"];

export async function warmProcessWideState(): Promise<void> {
  for (const specifier of BUILTINS) await import(specifier);
  const crypto = await import("node:crypto");
  const tls = await import("node:tls");
  crypto.getCiphers();
  crypto.getHashes();
  crypto.getCurves();
  tls.getCiphers();
  for (const algorithm of DIGESTS) {
    // Hashes the empty string to warm the digest; protects nothing.
    crypto.createHash(algorithm).update("").digest(); // nosemgrep: javascript.node-stdlib.cryptography.crypto-weak-algorithm.crypto-weak-algorithm
    // A fixed key on purpose: the HMAC warms OpenSSL's MAC tables; no secret, nothing is authenticated.
    crypto.createHmac(algorithm, "warm").update("").digest(); // nosemgrep: javascript.node-stdlib.cryptography.crypto-weak-algorithm.crypto-weak-algorithm, javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
  }
  crypto.randomBytes(16);
  crypto.randomUUID();
  // The default store, and with NODE_USE_SYSTEM_CA=1 the system store a
  // background thread parses at startup: both are X509 work on the same lock.
  tls.getCACertificates?.("default");
  tls.getCACertificates?.("system");
  tls.createSecureContext();
}
