/**
 * The component gallery at /gallery: every component the model may write,
 * each in a section with its name, the description its own `@bascik` comment
 * gives the model (read at build time, so it cannot drift) and live
 * instances with books, authors and real places as sample data.
 *
 * The sections come from the two catalog folders, not from a list here: a
 * component added to either folder shows up as a section, and the gallery
 * test fails until it has a sample below.
 */
import { esc, html, raw, type SafeHtml } from "@bascik/bascik/html";
import { readCatalog, type CatalogEntry } from "@bascik/ai";

const FOLDERS = [
  { title: "Package catalog", path: "../components/catalog" },
  { title: "Demo catalog", path: "src/genui" },
] as const;

/** One component tag, its props passed as `data-bascik-prop-NAME`. */
const tag = (
  name: string,
  props: Record<string, string | number>,
  ...children: string[]
): string => {
  const attributes = Object.entries(props)
    .map(([key, value]) => ` data-bascik-prop-${key}="${esc(String(value))}"`)
    .join("");
  return `<${name}${attributes}>${children.join("")}</${name}>`;
};

const quote = (source: string, text: string): string =>
  tag("source-quote", { source }, text);

const book = (title: string, author: string, rating: string, blurb: string) =>
  tag("book-card", { title, author, rating }, blurb);

const pin = (
  label: string,
  lat: number,
  lng: number,
  description: string,
): string => tag("map-pin", { label, lat, lng }, description);

const swipe = (title: string, text: string): string =>
  tag("swipe-card", { title }, text);

const dune = swipe("Dune", "Frank Herbert's desert epic, 1965.");
const emma = swipe("Emma", "Jane Austen's comedy of matchmaking.");
const beloved = swipe("Beloved", "Toni Morrison's novel of memory and loss.");

const SAMPLES: Record<string, string[]> = {
  // The package catalog.
  "ask-button": [
    tag(
      "ask-button",
      { say: "Recommend another novel by Ursula K. Le Guin" },
      "More Le Guin",
    ),
  ],
  "bar-chart": [
    tag(
      "bar-chart",
      { title: "Pages in each novel" },
      tag("bar-row", { label: "Dune", value: 612, max: 612 }),
      tag("bar-row", { label: "Emma", value: 474, max: 612 }),
      tag("bar-row", { label: "Beloved", value: 324, max: 612 }),
    ),
  ],
  "bar-row": [
    tag(
      "bar-chart",
      { title: "Ratings out of 5" },
      tag("bar-row", { label: "The Dispossessed", value: 4.5, max: 5 }),
      tag("bar-row", { label: "Middlemarch", value: 4.2, max: 5 }),
    ),
  ],
  "card-grid": [
    tag(
      "card-grid",
      {},
      book(
        "Dune",
        "Frank Herbert",
        "4.6",
        "A boy, a desert planet and a spice.",
      ),
      book(
        "Beloved",
        "Toni Morrison",
        "4.4",
        "A house haunted by what it remembers.",
      ),
      tag("stat-tile", { label: "Books read", value: 42 }, "so far this year"),
    ),
  ],
  "choice-form": [
    tag(
      "choice-form",
      { question: "Which Toni Morrison novel should we start with?" },
      tag("choice-option", { value: "Beloved" }, "Beloved"),
      tag("choice-option", { value: "Song of Solomon" }, "Song of Solomon"),
      tag("choice-option", { value: "Sula" }, "Sula"),
    ),
  ],
  "choice-option": [
    tag(
      "choice-form",
      { question: "How should I sort your shelf?" },
      tag("choice-option", { value: "Sort by author" }, "By author"),
      tag("choice-option", { value: "Sort by year" }, "By year"),
    ),
  ],
  "choice-pair": [
    tag(
      "choice-pair",
      { question: "Which edition of Dune do you want?" },
      tag("pair-option", { title: "Hardcover" }, "Sturdy, with a dust jacket."),
      tag("pair-option", { title: "Paperback" }, "Light and cheap."),
    ),
    tag(
      "choice-pair",
      { question: "Which Le Guin should we read next?" },
      tag(
        "pair-option",
        { title: "The Left Hand of Darkness" },
        "A winter planet where nobody has a fixed sex.",
      ),
      tag(
        "pair-option",
        { title: "The Dispossessed" },
        "Two worlds, one a utopia and one a market.",
      ),
    ),
  ],
  "data-table": [
    tag(
      "data-table",
      { caption: "Books and ratings" },
      `<table><thead><tr><th>Title</th><th>Author</th><th>Rating</th></tr></thead><tbody>` +
        `<tr><td>Dune</td><td>Frank Herbert</td><td>4.6</td></tr>` +
        `<tr><td>Emma</td><td>Jane Austen</td><td>4.0</td></tr>` +
        `<tr><td>Beloved</td><td>Toni Morrison</td><td>4.4</td></tr>` +
        `<tr><td>Middlemarch</td><td>George Eliot</td><td>4.2</td></tr>` +
        `</tbody></table>`,
    ),
  ],
  "input-form": [
    tag(
      "input-form",
      { title: "Tell me about your reading", submit: "Send" },
      tag("text-field", { label: "Favorite author", name: "author" }),
      tag("text-field", { label: "Last book you finished", name: "book" }),
    ),
  ],
  "map-pin": [
    tag(
      "map-view",
      { title: "Bookshops of Hay-on-Wye", zoom: 15 },
      pin(
        "Richard Booth's Bookshop",
        52.0747,
        -3.126,
        "The shop that started the book town.",
      ),
      pin(
        "Addyman Books",
        52.0745,
        -3.1259,
        "Floor to ceiling second-hand stock.",
      ),
    ),
  ],
  "map-view": [
    tag(
      "map-view",
      { title: "Bookshops of Charing Cross Road" },
      pin("Foyles", 51.5159, -0.1294, "Flagship store with five floors."),
      pin(
        "Waterstones Piccadilly",
        51.5085,
        -0.1349,
        "The largest bookshop in Europe.",
      ),
      pin(
        "Hatchards",
        51.5083,
        -0.1391,
        "London's oldest bookshop, since 1797.",
      ),
    ),
    tag(
      "map-view",
      { title: "A Paris landmark", zoom: 14 },
      pin(
        "Shakespeare and Company",
        48.853,
        2.3499,
        "English-language bookshop by the Seine.",
      ),
    ),
    tag("map-view", {
      title: "Hay-on-Wye, the town of books",
      lat: 52.0746,
      lng: -3.1263,
      zoom: 13,
    }),
  ],
  "note-box": [
    tag(
      "note-box",
      { title: "Spoilers ahead" },
      "This summary reveals how Beloved ends.",
    ),
  ],
  "pair-option": [
    tag(
      "choice-pair",
      { question: "Which format suits your commute?" },
      tag("pair-option", { title: "Audiobook" }, "Listen on the train."),
      tag("pair-option", { title: "Paperback" }, "Read it on the bus."),
    ),
  ],
  "scene-3d": [
    tag(
      "scene-3d",
      {
        title: "Water molecule",
        caption: "One oxygen atom bonded to two hydrogen atoms.",
      },
      tag("scene-object", {
        shape: "sphere",
        x: 0,
        y: 0,
        z: 0,
        size: 2,
        color: "red",
        label: "Oxygen",
      }),
      tag("scene-object", {
        shape: "sphere",
        x: -1.6,
        y: -1.2,
        z: 0,
        size: 1.2,
        color: "white",
        label: "Hydrogen",
      }),
      tag("scene-object", {
        shape: "sphere",
        x: 1.6,
        y: -1.2,
        z: 0,
        size: 1.2,
        color: "white",
        label: "Hydrogen",
      }),
    ),
    tag(
      "scene-3d",
      {
        title: "Bookshelf",
        caption: "Three books standing on one shelf, tallest on the left.",
      },
      tag("scene-object", {
        shape: "box",
        x: 0,
        y: -1.2,
        z: 0,
        size: 1,
        color: "gray",
        label: "Shelf",
      }),
      tag("scene-object", {
        shape: "box",
        x: -1.2,
        y: 0.4,
        z: 0,
        size: 2.4,
        color: "purple",
        label: "Dune",
      }),
      tag("scene-object", {
        shape: "box",
        x: 0,
        y: 0.1,
        z: 0,
        size: 1.8,
        color: "orange",
        label: "Emma",
      }),
      tag("scene-object", {
        shape: "box",
        x: 1.2,
        y: -0.2,
        z: 0,
        size: 1.2,
        color: "teal",
        label: "Beloved",
      }),
    ),
  ],
  "scene-object": [
    tag(
      "scene-3d",
      { title: "Reading nook", caption: "The lamp stands left of the chair." },
      tag("scene-object", {
        shape: "box",
        x: 0,
        y: 0,
        z: 0,
        size: 3,
        color: "blue",
        label: "Chair",
      }),
      tag("scene-object", {
        shape: "cylinder",
        x: -3,
        y: 0.5,
        z: 0,
        size: 1.5,
        color: "yellow",
        label: "Lamp",
      }),
    ),
  ],
  "stat-tile": [
    tag(
      "stat-tile",
      { label: "Average rating", value: "4.6" },
      "across 212 readers",
    ),
    tag("stat-tile", { label: "Pages", value: 612 }, "in the Ace paperback"),
  ],
  "step-item": [
    tag(
      "step-list",
      {},
      tag(
        "step-item",
        { title: "Pick a book" },
        "Choose something from the shelf.",
      ),
      tag("step-item", { title: "Find a chair" }, "Somewhere with good light."),
    ),
  ],
  "step-list": [
    tag(
      "step-list",
      {},
      tag(
        "step-item",
        { title: "Pick a book" },
        "Choose something from the shelf.",
      ),
      tag(
        "step-item",
        { title: "Read a chapter" },
        "Twenty pages is enough to start.",
      ),
      tag(
        "step-item",
        { title: "Note a quote" },
        "Write down one line you want to keep.",
      ),
    ),
  ],
  "swipe-card": [
    tag(
      "swipe-deck",
      { question: "Read it again?" },
      swipe("Middlemarch", "George Eliot's study of a provincial town."),
      swipe("Ulysses", "James Joyce's single day in Dublin."),
    ),
  ],
  "swipe-deck": [
    tag(
      "swipe-deck",
      {
        question: "Which of these would you keep on your shelf?",
        yes: "Keep",
        no: "Skip",
      },
      dune,
      emma,
      beloved,
    ),
    tag(
      "swipe-deck",
      {},
      swipe("The Hobbit", "Tolkien's there-and-back-again tale."),
      swipe("Persuasion", "Austen's quiet second chance."),
    ),
  ],
  "text-field": [
    tag(
      "input-form",
      { title: "Add a book", submit: "Add" },
      tag("text-field", { label: "Title", name: "title" }),
      tag("text-field", { label: "Author", name: "author" }),
    ),
  ],
  "tool-note": [tag("tool-note", {}, "Looking up books by Ursula K. Le Guin")],

  // The demo's own catalog.
  "book-card": [
    book(
      "Dune",
      "Frank Herbert",
      "4.6",
      "A boy, a desert planet and a spice worth a war.",
    ),
    book(
      "The Dispossessed",
      "Ursula K. Le Guin",
      "4.5",
      "A physicist crosses between a utopia and a market.",
    ),
  ],
  "code-map": [
    tag(
      "code-map",
      { item: "shelf-codes", title: "Shelf codes" },
      tag("code-row", { old: "FIC-A", new: "F-AUS" }, "Fiction by Austen"),
      tag("code-row", { old: "FIC-M", new: "F-MOR" }, "Fiction by Morrison"),
    ),
  ],
  "code-row": [
    tag(
      "code-map",
      { item: "genre-codes", title: "Genre codes" },
      tag("code-row", { old: "SF-1", new: "SFF-1" }, "Science fiction"),
    ),
  ],
  "decision-fork": [
    tag(
      "decision-fork",
      {
        item: "late-return",
        question: "A book comes back a week late. What should the library do?",
      },
      quote(
        "Lending policy, section 4",
        "Overdue items are handled at the librarian's discretion.",
      ),
      tag(
        "fork-branch",
        { value: "fine", when: "the reader returns it late again" },
        "Charge the standard fine.",
      ),
      tag(
        "fork-branch",
        { value: "waive", when: "it is the first time" },
        "Waive the fine and send a reminder.",
      ),
    ),
  ],
  "doc-link": [
    tag(
      "doc-link",
      { href: "https://bascik.dev/components", title: "Components" },
      "How a component declares props and a slot.",
    ),
  ],
  "fact-card": [
    tag(
      "fact-swipe",
      { item: "austen-facts", question: "Are these right?" },
      tag(
        "fact-card",
        { fact: "emma-year", claim: "Emma was first published in 1815." },
        quote("Edition notes", "First published in December 1815."),
      ),
      tag(
        "fact-card",
        { fact: "emma-author", claim: "Emma was written by Charlotte Brontë." },
        quote(
          "Title page",
          "Emma: a novel, by the author of Pride and Prejudice.",
        ),
      ),
    ),
  ],
  "fact-swipe": [
    tag(
      "fact-swipe",
      { item: "dune-facts", question: "Is each fact about Dune right?" },
      tag(
        "fact-card",
        { fact: "dune-author", claim: "Dune was written by Frank Herbert." },
        quote("Title page", "Dune, by Frank Herbert."),
      ),
      tag(
        "fact-card",
        { fact: "dune-pages", claim: "The first edition has 412 pages." },
        quote("Edition notes", "First edition, Chilton Books, 412 pages."),
      ),
      tag(
        "fact-card",
        { fact: "dune-sequel", claim: "Its first sequel is Children of Dune." },
        quote("Series list", "Dune Messiah (1969), Children of Dune (1976)."),
      ),
    ),
  ],
  "fact-check": [
    tag(
      "fact-check",
      { item: "dune-year", claim: "Dune was first published in 1965." },
      quote(
        "Edition notes, copyright page",
        "First published in 1965 by Chilton Books.",
      ),
    ),
  ],
  "flow-diagram": [
    tag(
      "flow-diagram",
      { title: "Lending a book" },
      tag(
        "flow-stage",
        { label: "Request", state: "done" },
        "The reader asks for a title.",
      ),
      tag(
        "flow-stage",
        { label: "Check shelf", state: "current" },
        "A librarian looks for a free copy.",
      ),
      tag(
        "flow-stage",
        { label: "Reserve", state: "unclear" },
        "The handbook does not say how long a hold lasts.",
      ),
      tag(
        "flow-stage",
        { label: "Pick up", state: "todo" },
        "The reader collects it at the desk.",
      ),
    ),
  ],
  "flow-stage": [
    tag(
      "flow-diagram",
      { title: "Returning a book" },
      tag(
        "flow-stage",
        { label: "Drop off", state: "done" },
        "The book goes in the return slot.",
      ),
      tag(
        "flow-stage",
        { label: "Re-shelve", state: "todo" },
        "A volunteer puts it back.",
      ),
    ),
  ],
  "fork-branch": [
    tag(
      "decision-fork",
      {
        item: "lost-book",
        question: "A reader says they lost a book. What now?",
      },
      tag(
        "fork-branch",
        { value: "replace", when: "the book is in print" },
        "Ask the reader to pay for a replacement.",
      ),
      tag(
        "fork-branch",
        { value: "forgive", when: "the book is out of print" },
        "Close the loan with no charge.",
      ),
    ),
  ],
  "gap-question": [
    tag(
      "gap-question",
      {
        item: "loan-length",
        question: "How many weeks can a reader keep a novel?",
      },
      quote("Lending policy, section 2", "Loan periods are set by the branch."),
    ),
  ],
  "plan-review": [
    tag(
      "plan-review",
      { item: "reshelve", title: "Reorganize the fiction shelves" },
      tag(
        "step-item",
        { title: "Sort by author" },
        "Austen, Eliot and Morrison first.",
      ),
      tag("step-item", { title: "Label each shelf" }, "One letter per author."),
    ),
  ],
  "source-quote": [
    quote(
      "Library handbook, section 3",
      "A reader may borrow up to six books at one time.",
    ),
  ],
};

/** The first sentence of a description, and whether more follows it. */
const lead = (text: string): { first: string; more: boolean } => {
  const end = text.search(/[.!?](\s|$)/);
  if (end < 0) return { first: text, more: false };
  const first = text.slice(0, end + 1);
  return { first, more: first.length < text.length };
};

const section = (entry: CatalogEntry): SafeHtml => {
  const description = entry.description.replace(/\s+/g, " ").trim();
  const { first, more } = lead(description);
  const samples = SAMPLES[entry.name] ?? [];
  return html`<section
    class="gallery-section"
    id="${entry.name}"
    aria-labelledby="gallery-${entry.name}"
    data-testid="gallery-section"
  >
    <h3 id="gallery-${entry.name}" class="gallery-name">${entry.name}</h3>
    <p class="gallery-lead" data-testid="gallery-description">${first}</p>
    ${
      more
        ? html`<details class="gallery-more">
            <summary>All of what the model is told</summary>
            <p data-testid="gallery-full-description">${description}</p>
          </details>`
        : ""
    }
    <div class="gallery-samples" data-testid="gallery-samples">
      ${
        samples.length > 0
          ? raw(samples.join("\n"))
          : html`<p class="gallery-missing">No sample yet.</p>`
      }
    </div>
  </section>`;
};

export async function gallery(): Promise<SafeHtml> {
  const groups = [];
  for (const folder of FOLDERS) {
    const catalog = await readCatalog(folder.path);
    groups.push(
      html`<h2 class="gallery-group">${folder.title}</h2>
        ${[...catalog.values()].map(section)}`,
    );
  }
  return html`${groups}`;
}
