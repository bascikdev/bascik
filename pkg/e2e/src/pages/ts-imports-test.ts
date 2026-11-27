// The page's own module script: its @/ import is bundled into it, and the
// tag stays type="module".
import { featuredBook } from "@/lib/ts-imports-books.ts";

const pageModuleOut = document.getElementById("page-module-out") as HTMLElement;
pageModuleOut.textContent = `module: ${featuredBook().author}`;
