// Node strips types without resolving modules for them, so a type-only import needs
// `import type` and an explicit `.ts` extension.
import type { Author } from "./author.ts";

export type Post = {
  slug: string;
  title: string;
  date: string;
  coverImage: string;
  author: Author;
  excerpt: string;
  ogImage: {
    url: string;
  };
  content: string;
};
