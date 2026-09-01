import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { BascikConfig } from "./config.ts";

export interface ManifestEntry {
  hash: string;
  size: number;
}

export interface BuildManifest {
  version: string;
  files: Record<string, ManifestEntry>;
}

class ManifestCollector {
  private files = new Map<string, ManifestEntry>();

  recordFile(outputPath: string, content: Buffer | string): void {
    const normalizedOutputPath = outputPath.replace(/\\/g, "/");
    const outDir = resolve(process.cwd(), BascikConfig.directory.out);
    const resolvedPath = resolve(process.cwd(), normalizedOutputPath);
    const rel = relative(outDir, resolvedPath).replace(/\\/g, "/");

    // Do not record files outside dist/ or the manifest file itself
    if (rel.startsWith("..") || rel === ".bascik/manifest.json") {
      return;
    }

    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const hash = createHash("sha256").update(buf).digest("hex");
    this.files.set(rel, {
      hash,
      size: buf.length,
    });
  }

  async recordFileFromDisk(outputPath: string): Promise<void> {
    try {
      const resolvedPath = resolve(process.cwd(), outputPath);
      const buf = await readFile(resolvedPath);
      this.recordFile(outputPath, buf);
    } catch {
      // File could not be read, skip
    }
  }

  getFiles(): Record<string, ManifestEntry> {
    const sortedKeys = Array.from(this.files.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const result: Record<string, ManifestEntry> = {};
    for (const key of sortedKeys) {
      result[key] = this.files.get(key)!;
    }
    return result;
  }

  clear(): void {
    this.files.clear();
  }

  async writeManifest(version: string = "unknown"): Promise<void> {
    if (!BascikConfig.generate?.manifest) {
      return;
    }

    const outDir = resolve(process.cwd(), BascikConfig.directory.out);
    const manifestPath = join(outDir, ".bascik", "manifest.json");
    await mkdir(dirname(manifestPath), { recursive: true });

    const manifest: BuildManifest = {
      version,
      files: this.getFiles(),
    };

    const content = JSON.stringify(manifest, null, 2);
    await writeFile(manifestPath, content, "utf8");
  }
}

export const manifestCollector = new ManifestCollector();
