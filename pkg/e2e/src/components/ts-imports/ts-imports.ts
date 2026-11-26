// Module companion for <ts-imports>: imports a helper beside it, which imports
// another, and a helper under scripts.importRoot through @/.
import { formatRating } from "./ts-imports-format.ts";
import { featuredBook } from "@/lib/ts-imports-books.ts";

const moduleOut = document.getElementById("module-out") as HTMLOutputElement;
const book = featuredBook();
moduleOut.textContent = `${formatRating(book.title, book.rating)} by ${book.author}`;
