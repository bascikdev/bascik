/**
 * @module name-hash
 *
 * The scoped-name hash `minify.identifiers` emits, from a sha256 digest the
 * host computes (prompt 157). Portable: no `node:*` import, no `Buffer`, no
 * config, so a Worker renders request-time components with exactly the
 * names the build wrote. names.ts feeds it `node:crypto` on Node; the
 * Cloudflare runtime feeds it `node:crypto` under `nodejs_compat`. One
 * implementation, so the two hosts cannot drift.
 */

const BASE62_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Convert a 64-bit unsigned integer to an N-character Base62 string.
 */
export const toBase62 = (num: bigint, length = 11): string => {
  if (num === 0n) return "0".repeat(length);
  let str = "";
  let current = num;
  while (current > 0n) {
    const remainder = Number(current % 62n);
    str = BASE62_ALPHABET[remainder] + str;
    current = current / 62n;
  }
  return str.padStart(length, "0");
};

/**
 * The 12-character scoped name for a sha256 digest of the source name: its
 * first 8 bytes as a big-endian unsigned integer, in Base62, after a `b`
 * (for Bascik) so the name always starts with a letter.
 */
export const nameHashFromDigest = (digest: Uint8Array): string => {
  let num = 0n;
  for (let i = 0; i < 8; i++) num = (num << 8n) | BigInt(digest[i]);
  return `b${toBase62(num, 11)}`;
};

/** How many names a request-time hasher keeps before it starts over. */
export const NAME_HASHER_MEMO_LIMIT = 4096;

/**
 * A memoized `nameHashFromDigest` over the host's own sha256, for a
 * request-time renderer. The memo is bounded: the names a template replays
 * embed the request instance id, so they vary with the request, and an
 * unbounded memo would grow with every route spelling or 404 a client sends.
 * Starting over at `limit` keeps a component library's fixed names hot
 * without ever holding more than `limit` of them.
 */
export const createNameHasher = (
  digest: (input: string) => Uint8Array,
  limit: number = NAME_HASHER_MEMO_LIMIT,
): ((input: string) => string) => {
  const memo = new Map<string, string>();
  return (input) => {
    let name = memo.get(input);
    if (name === undefined) {
      name = nameHashFromDigest(digest(input));
      if (memo.size >= limit) memo.clear();
      if (limit > 0) memo.set(input, name);
    }
    return name;
  };
};
