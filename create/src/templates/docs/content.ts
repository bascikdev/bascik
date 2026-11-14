/**
 * The docs template's sample pages: the documentation of "Book Catalog", an
 * imaginary library for looking up books and authors. Invented content only.
 * The order and grouping of the pages is `SIDEBAR` in `lib.ts`.
 */

const GETTING_STARTED = `---
title: Getting started
description: Install Book Catalog, create a catalog, and look up your first book.
---

Book Catalog is an imaginary library for looking up books and authors. These pages are sample content: replace them with your own.

## Install

Add the package to your project:

\`\`\`sh
npm install @example/book-catalog
\`\`\`

## Look up a book

Create a catalog and ask it for a book by its ISBN:

\`\`\`ts
import { createCatalog } from "@example/book-catalog";

const catalog = createCatalog();
const book = await catalog.book("9780000000017");

console.log(book.title, "by", book.author.name);
// The Lighthouse Ledger by Mara Ellison
\`\`\`

### What you get back

A book has a title, an author, a year, and a rating from 1 to 5. [Book fields](/docs/book-fields) lists every field.

## Next steps

- [Finding books](/docs/finding-books) shows how to search by title, author, or rating.
- [Reading lists](/docs/reading-lists) shows how to group books and keep them in order.
`;

const FINDING_BOOKS = `---
title: Finding books
description: Search the catalog by title, author, or rating, and sort the results.
---

\`catalog.find()\` returns every book that matches all the filters you pass.

## Search by title

A title search matches any part of the title and ignores case:

\`\`\`ts
const books = await catalog.find({ title: "river" });
// A Field Guide to Quiet Rivers
\`\`\`

## Search by author

Pass the author's name, or an author you already have:

\`\`\`ts
const byName = await catalog.find({ author: "Tomas Okafor" });
const byAuthor = await catalog.find({ author: book.author });
\`\`\`

## Filter by rating

\`minRating\` keeps the books rated at or above a number:

\`\`\`ts
const favorites = await catalog.find({ minRating: 4.5 });
\`\`\`

### Books with no rating

A book nobody has rated yet has no \`rating\`. It is left out whenever \`minRating\` is set.

## Sort the results

Results come back by title. Pass \`sort\` to change that:

| Value      | Order                         |
| :--------- | :---------------------------- |
| \`"title"\`  | A to Z by title (the default) |
| \`"year"\`   | Newest first                  |
| \`"rating"\` | Highest rated first           |
`;

const READING_LISTS = `---
title: Reading lists
description: Group books into a named list, keep them in order, and mark the ones you finished.
---

A reading list is a named, ordered group of books.

## Create a list

\`\`\`ts
const list = catalog.list("Summer reading");

list.add("9780000000017");
list.add("9780000000024");
\`\`\`

## Reorder a list

Books stay in the order you add them. \`move()\` takes a book and its new position, counted from 1:

\`\`\`ts
list.move("9780000000024", 1);
\`\`\`

## Mark a book as read

\`\`\`ts
list.finish("9780000000017");

console.log(list.progress);
// { read: 1, total: 2 }
\`\`\`

> A finished book stays in the list. Call \`list.remove()\` to take it out.
`;

const BOOK_FIELDS = `---
title: Book fields
description: Every field of a book in the catalog, with its type and an example.
---

Every book the catalog returns has the same fields.

## Fields

| Field    | Type     | Example                   |
| :------- | :------- | :------------------------ |
| \`isbn\`   | string   | \`"9780000000017"\`         |
| \`title\`  | string   | \`"The Lighthouse Ledger"\` |
| \`author\` | Author   | See [Author fields](/docs/author-fields) |
| \`year\`   | number   | \`2019\`                    |
| \`rating\` | number   | \`4.6\`                     |

## Optional fields

\`rating\` is missing until a reader rates the book. Check for it before you print it:

\`\`\`ts
const stars = book.rating === undefined ? "Not rated" : book.rating.toFixed(1);
\`\`\`

## Example

\`\`\`json
{
  "isbn": "9780000000017",
  "title": "The Lighthouse Ledger",
  "author": { "id": "mara-ellison", "name": "Mara Ellison" },
  "year": 2019,
  "rating": 4.6
}
\`\`\`
`;

const AUTHOR_FIELDS = `---
title: Author fields
description: Every field of an author in the catalog, and how to list an author's books.
---

An author appears inside each book, and \`catalog.author()\` returns one by id.

## Fields

| Field   | Type   | Example          |
| :------ | :----- | :--------------- |
| \`id\`    | string | \`"mara-ellison"\` |
| \`name\`  | string | \`"Mara Ellison"\` |
| \`books\` | number | \`3\`              |

## List an author's books

\`\`\`ts
const author = await catalog.author("mara-ellison");
const books = await catalog.find({ author });
\`\`\`

## Example

\`\`\`json
{
  "id": "mara-ellison",
  "name": "Mara Ellison",
  "books": 3
}
\`\`\`
`;

/** The sample pages by file name without `.md`, in sidebar order. */
export const DOCS_SAMPLE_PAGES: Record<string, string> = {
  "getting-started": GETTING_STARTED,
  "finding-books": FINDING_BOOKS,
  "reading-lists": READING_LISTS,
  "book-fields": BOOK_FIELDS,
  "author-fields": AUTHOR_FIELDS,
};
