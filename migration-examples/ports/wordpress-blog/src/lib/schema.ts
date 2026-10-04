import { z } from 'zod';
import type { Snapshot } from './model.ts';

// Validates the snapshot once, when scripts/sync-wordpress.ts writes it. Pages only read the
// validated file, so they never load zod (every build script runs in its own Node process).

const term = z.strictObject({ slug: z.string().regex(/^[a-z0-9-]+$/), name: z.string().min(1) });

const image = z.strictObject({
  src: z.string().min(1),
  srcset: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: z.string(),
});

const post = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
  excerpt: z.string(),
  html: z.string(),
  author: z.string(),
  categories: z.array(term),
  tags: z.array(term),
  featured: image.optional(),
});

const page = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  parent: z.string().regex(/^[a-z0-9-]+$/).optional(),
  title: z.string().min(1),
  excerpt: z.string(),
  html: z.string(),
  order: z.number().int(),
});

export const snapshotSchema = z.strictObject({
  source: z.enum(['rest', 'markdown']),
  site: z.strictObject({ name: z.string().min(1), description: z.string() }),
  posts: z.array(post),
  pages: z.array(page),
});

export function validateSnapshot(value: unknown): Snapshot {
  return snapshotSchema.parse(value);
}
