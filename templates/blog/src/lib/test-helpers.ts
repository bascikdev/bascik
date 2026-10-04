import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { afterEach, beforeEach, vi } from 'vitest';

// Test support: a throwaway project directory that `process.cwd()` points at, because the
// pipeline reads content/ relative to the working directory like a real build does.

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A valid solid-color PNG of the given size. */
export function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface Project {
  root: string;
  /** Write a file under the project root, creating folders. */
  write(path: string, content: string | Buffer): void;
  /** Write content/blog/<name> with front matter built from `fields`. */
  post(name: string, fields: Record<string, unknown>, body?: string): void;
}

const yaml = (value: unknown): string => (Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]` : JSON.stringify(value));

/** Call inside `describe`. Creates a fresh project per test, points cwd at it, and cleans up. */
export function useProject(env: Record<string, string | undefined> = {}): Project {
  const project = { root: '' } as Project;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    project.root = mkdtempSync(join(tmpdir(), 'blog-template-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(project.root);
    for (const [key, value] of Object.entries({ BASCIK_BUILD: '1', BASCIK_SITE_URL: undefined, ...env })) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(project.root, { recursive: true, force: true });
  });

  project.write = (path, content) => {
    const target = join(project.root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  project.post = (name, fields, body = 'Body text.') => {
    const lines = Object.entries(fields).map(([key, value]) => `${key}: ${yaml(value)}`);
    project.write(`content/blog/${name}`, `---\n${lines.join('\n')}\n---\n${body}\n`);
  };
  return project;
}
