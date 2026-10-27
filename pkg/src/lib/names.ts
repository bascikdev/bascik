import { createHash, randomBytes } from "node:crypto";
import { BascikConfig } from "./config.ts";
import { nameHashFromDigest, toBase62 } from "./name-hash.ts";

export { toBase62 };

const hashCache = new Map<string, string>();

export const clearHashCache = (): void => {
  hashCache.clear();
};

export const getAttributeNameHash = (attributeName: string): string => {
  const cached = hashCache.get(attributeName);
  if (cached !== undefined) return cached;
  // The algorithm lives in the portable name-hash.ts (prompt 157), so a
  // Worker computes the same names from its own sha256.
  const digest = createHash("sha256").update(attributeName).digest();
  const hash = nameHashFromDigest(
    typeof digest === "string" ? Buffer.from(digest) : digest,
  );
  hashCache.set(attributeName, hash);
  return hash;
};

// Observer for every generated scoped name, set only while scoping-template.ts
// records one synchronous scoping run. Never set on any other path.
let attributeNameObserver: ((input: string, output: string) => void) | null =
  null;

export const minifyAttributeName = (attributeName: string): string => {
  const output = BascikConfig.minify.identifiers
    ? getAttributeNameHash(attributeName)
    : attributeName;
  attributeNameObserver?.(attributeName, output);
  return output;
};

/**
 * Run `run` synchronously while reporting every `minifyAttributeName` call to
 * `observer`, in call order. The previous observer is restored afterwards.
 */
export const observeAttributeNames = <T>(
  observer: (input: string, output: string) => void,
  run: () => T,
): T => {
  const previous = attributeNameObserver;
  attributeNameObserver = observer;
  try {
    return run();
  } finally {
    attributeNameObserver = previous;
  }
};

export const getUniqueId = (length: number): string => {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
};

/**
 * Derive an 8-hex-character component instance ID deterministically from
 * (page path, component name, ordinal occurrence index on that page).
 * On collision with an already issued ID on the same page, salts deterministically
 * to guarantee uniqueness without randomness.
 */
export const deriveInstanceId = (
  pagePath: string,
  componentName: string,
  ordinal: number,
  issuedIds: Set<string> = new Set<string>(),
): string => {
  let attempt = 0;
  while (true) {
    const input =
      attempt === 0
        ? `${pagePath}::${componentName}::${ordinal}`
        : `${pagePath}::${componentName}::${ordinal}::salt:${attempt}`;
    const id = createHash("sha256").update(input).digest("hex").slice(0, 8);
    if (!issuedIds.has(id)) {
      issuedIds.add(id);
      return id;
    }
    attempt++;
  }
};

export const makeEtag = (buf: Buffer): string =>
  `"${createHash("sha256").update(buf).digest("base64url").slice(0, 27)}"`;
