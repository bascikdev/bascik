import { createHash } from "node:crypto";

export function originalImagePath(handle: string, source: URL): string {
  const sourceHash = createHash("sha256").update(source.href).digest("hex");
  return `image-originals/${handle}-${sourceHash}.original`;
}
