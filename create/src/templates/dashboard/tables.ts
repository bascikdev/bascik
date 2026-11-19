/**
 * The dashboard template's orders table (sorted, filtered and paged by a
 * scoped client script, every row printed at build time), its stock table,
 * and the detail a title's page shows.
 *
 * Each entry is one file of the generated project, as it is written: its
 * path from the project root, then its content.
 */

import type { TemplateFile } from "../../scaffold.js";

export const TABLE_FILES: TemplateFile[] = [
  [
    "src/components/orders-table/orders-table.html",
    `<!-- @bascik
The orders of the reporting period in a table that sorts, filters and pages. The build prints the heading row (head.ts) and every order row, so the whole table is there without JavaScript; orders-table.ts then enables the column headings, shows the filter and the pager, and moves and hides rows. Its styles are in orders-table.css.
-->
<section class="card" aria-labelledby="heading" data-testid="orders-table">
  <h2 id="heading" class="visually-hidden">All orders</h2>
  <!-- <search> is the element HTML defines for filtering controls; the results stay outside it. -->
  <search
    class="controls"
    id="controls"
    data-testid="orders-table-search"
    hidden
  >
    <label class="control" for="query">
      Filter orders
      <input
        class="field query"
        id="query"
        type="search"
        autocomplete="off"
        placeholder="Order, customer, or title"
        data-testid="orders-table-query"
      />
    </label>
    <label class="control" for="status">
      Status
      <select class="field" id="status" data-testid="orders-table-status">
        <option value="">All statuses</option>
        <option>Paid</option>
        <option>Processing</option>
        <option>Shipped</option>
        <option>Refunded</option>
      </select>
    </label>
  </search>
  <div class="table-scroll">
    <table class="data-table data-table-wide" data-testid="orders-table-table">
      <caption>
        Orders from the last 30 days
      </caption>
      <thead id="head">
        <script data-bascik-build-once type="text/typescript">
          import { sortableHead } from "./head.ts";
          export default () => sortableHead();
        </script>
      </thead>
      <tbody id="rows" data-testid="orders-table-rows">
        <script data-bascik-build-once type="text/typescript">
          import { orderRows } from "@/lib/order-table.ts";
          import { currentOrders } from "@/lib/shop.ts";
          export default () => orderRows(currentOrders());
        </script>
      </tbody>
    </table>
  </div>
  <div class="empty" id="empty" data-testid="orders-table-empty" hidden>
    <p>No orders match these filters.</p>
    <button
      class="button"
      id="clear"
      type="button"
      data-testid="orders-table-clear"
    >
      Clear filters
    </button>
  </div>
  <div class="pager" id="pager" data-testid="orders-table-pager" hidden>
    <p
      class="summary"
      id="summary"
      role="status"
      data-testid="orders-table-summary"
    ></p>
    <p class="steps">
      <button
        class="button"
        id="previous"
        type="button"
        data-testid="orders-table-previous"
      >
        Previous
      </button>
      <span id="page" data-testid="orders-table-page">Page 1 of 1</span>
      <button
        class="button"
        id="next"
        type="button"
        data-testid="orders-table-next"
      >
        Next
      </button>
    </p>
  </div>
</section>
<script type="module" src="orders-table.ts"></script>
`,
  ],

  [
    "src/components/orders-table/orders-table.css",
    `.controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: end;
}

/* An author display value beats the hidden attribute, so restate it: the controls stay hidden until their script runs. */
.controls[hidden],
.pager[hidden] {
  display: none;
}

.control {
  display: grid;
  gap: var(--space-1);
  font-size: 0.875rem;
  font-weight: 600;
}

/* Wide enough for its placeholder, and never wider than a phone. */
.query {
  width: 16rem;
  max-width: 100%;
}

.sort {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

/* Without its script a heading is not a control, so it looks like plain text. */
.sort:disabled {
  cursor: default;
}

/* The sort direction is an arrow in the heading, and aria-sort says it to a screen reader. */
.sort::after {
  content: " ↕";
}

.sort:disabled::after {
  content: "";
}

.column[aria-sort="ascending"] .sort::after {
  content: " ▲";
}

.column[aria-sort="descending"] .sort::after {
  content: " ▼";
}

.column[aria-sort="ascending"] .sort,
.column[aria-sort="descending"] .sort {
  color: var(--color-text);
}

.empty {
  display: grid;
  gap: var(--space-2);
  justify-items: center;
  padding: var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius);
  color: var(--color-muted);
  text-align: center;
}

.empty[hidden] {
  display: none;
}

.pager {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  justify-content: space-between;
}

.summary {
  color: var(--color-muted);
  font-size: 0.875rem;
}

.steps {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  font-size: 0.875rem;
}
`,
  ],

  [
    "src/components/orders-table/orders-table.ts",
    `/**
 * Sorting, filtering and paging for <orders-table>.
 *
 * The component loads this file as a module (<script type="module">), so the
 * functions that decide what to show can be exported and unit tested in
 * orders-table.test.ts with no browser. \`mount()\` at the bottom is the only
 * part that touches the page. It moves and hides the rows the build printed;
 * it never builds markup.
 */

export type SortKey = "order" | "date" | "customer" | "total" | "status";
export type SortDirection = "ascending" | "descending";

/** What a script needs to know about one row, read from its data-* attributes. */
export interface RowData {
  order: string;
  date: string;
  customer: string;
  total: number;
  status: string;
  /** Everything the row says, lowercased, for the text filter. */
  text: string;
}

export interface TableState {
  key: SortKey;
  direction: SortDirection;
  query: string;
  /** A status to show, or "" for all. */
  status: string;
  /** The page shown, starting at 1. */
  page: number;
}

export const PAGE_SIZE = 10;

/** How the build orders the rows: newest first. head.ts marks that column, and the script starts from it. */
export const INITIAL_SORT = { key: "date", direction: "descending" } as const;

const byText = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** Orders rows by one column. Rows that tie go by order number, so sorting is repeatable. */
export function compareRows(
  a: RowData,
  b: RowData,
  key: SortKey,
  direction: SortDirection,
): number {
  const difference =
    key === "total"
      ? (Number.isFinite(a.total) ? a.total : 0) -
        (Number.isFinite(b.total) ? b.total : 0)
      : byText(a[key], b[key]);
  const result = difference !== 0 ? difference : byText(a.order, b.order);
  return direction === "ascending" ? result : -result;
}

/** A second click on the sorted column reverses it; a new column starts ascending. */
export const nextDirection = (
  state: Pick<TableState, "key" | "direction">,
  key: SortKey,
): SortDirection =>
  state.key === key && state.direction === "ascending"
    ? "descending"
    : "ascending";

/** Whether a row passes the text filter and the status filter. */
export const matches = (row: RowData, query: string, status: string): boolean =>
  (status === "" || row.status === status) &&
  row.text.includes(query.trim().toLowerCase());

/** The number of pages for \`count\` rows: an empty table still has page 1. */
export const pageCount = (count: number, size = PAGE_SIZE): number =>
  Math.max(1, Math.ceil(Math.max(0, count) / Math.max(1, size)));

export interface TableView {
  /** Indexes into the rows, filtered and sorted. */
  order: number[];
  /** The indexes on the page shown. */
  shown: number[];
  page: number;
  pages: number;
}

/** What the table shows for a state. A page past the end becomes the last page. */
export function viewOf(
  rows: readonly RowData[],
  state: TableState,
  size = PAGE_SIZE,
): TableView {
  const order = rows
    .map((_, index) => index)
    .filter((index) => matches(rows[index], state.query, state.status))
    .sort((a, b) => compareRows(rows[a], rows[b], state.key, state.direction));
  const pages = pageCount(order.length, size);
  const wanted = Number.isFinite(state.page) ? Math.floor(state.page) : 1;
  const page = Math.min(Math.max(1, wanted), pages);
  return {
    order,
    shown: order.slice((page - 1) * size, page * size),
    page,
    pages,
  };
}

/** The line under the table: which rows are shown, out of how many. */
export function summaryOf(
  view: TableView,
  total: number,
  size = PAGE_SIZE,
): string {
  if (view.order.length === 0) return \`No orders shown, of \${total}\`;
  const first = (view.page - 1) * size + 1;
  const last = first + view.shown.length - 1;
  const filtered =
    view.order.length === total ? "" : \` (filtered from \${total})\`;
  return \`Showing \${first} to \${last} of \${view.order.length} orders\${filtered}\`;
}

function mount(): void {
  const body = document.getElementById("rows") as HTMLTableSectionElement;
  const head = document.getElementById("head") as HTMLTableSectionElement;
  const query = document.getElementById("query") as HTMLInputElement;
  const status = document.getElementById("status") as HTMLSelectElement;
  const summary = document.getElementById("summary") as HTMLElement;
  const empty = document.getElementById("empty") as HTMLElement;
  const previous = document.getElementById("previous") as HTMLButtonElement;
  const next = document.getElementById("next") as HTMLButtonElement;
  const pageLabel = document.getElementById("page") as HTMLElement;

  const elements = [...body.rows];
  const rows: RowData[] = elements.map((row) => ({
    order: row.dataset.order ?? "",
    date: row.dataset.date ?? "",
    customer: row.dataset.customer ?? "",
    total: Number(row.dataset.total),
    status: row.dataset.status ?? "",
    text: (row.textContent ?? "").toLowerCase(),
  }));
  const sortButtons = [...head.querySelectorAll("button")];

  const state: TableState = {
    ...INITIAL_SORT,
    query: "",
    status: "",
    page: 1,
  };

  // The one function that applies the state to the page.
  const render = (): void => {
    const view = viewOf(rows, state);
    state.page = view.page;
    const shown = new Set(view.shown);
    // append() moves a row that is already in the table, so this reorders them.
    for (const index of view.order) body.append(elements[index]);
    elements.forEach((row, index) => {
      row.hidden = !shown.has(index);
    });
    for (const button of sortButtons)
      button
        .closest("th")!
        .setAttribute(
          "aria-sort",
          button.dataset.key === state.key ? state.direction : "none",
        );
    summary.textContent = summaryOf(view, rows.length);
    empty.hidden = view.order.length > 0;
    pageLabel.textContent = \`Page \${view.page} of \${view.pages}\`;
    previous.disabled = view.page <= 1;
    next.disabled = view.page >= view.pages;
  };

  const readFilters = (): void => {
    state.query = query.value;
    state.status = status.value;
  };

  for (const button of sortButtons) {
    button.disabled = false;
    button.addEventListener("click", () => {
      const key = button.dataset.key as SortKey;
      state.direction = nextDirection(state, key);
      state.key = key;
      state.page = 1;
      render();
    });
  }
  for (const control of [query, status])
    control.addEventListener("input", () => {
      readFilters();
      state.page = 1;
      render();
    });
  previous.addEventListener("click", () => {
    state.page -= 1;
    render();
  });
  next.addEventListener("click", () => {
    state.page += 1;
    render();
  });
  document.getElementById("clear")!.addEventListener("click", () => {
    query.value = "";
    status.value = "";
    readFilters();
    state.page = 1;
    render();
    query.focus();
  });

  // /orders?status=Paid opens with that filter. A query parameter is untrusted:
  // it is only ever compared with the options the page already has.
  const wanted = new URLSearchParams(location.search).get("status");
  if ([...status.options].some((option) => option.value === wanted))
    status.value = wanted!;

  // The browser may restore typed values on Back or reload without firing input.
  window.addEventListener("pageshow", () => {
    readFilters();
    render();
  });

  document.getElementById("controls")!.hidden = false;
  document.getElementById("pager")!.hidden = false;
  readFilters();
  render();
}

// Vitest imports this file in Node, where there is no page to mount on.
if (typeof document !== "undefined") mount();
`,
  ],

  [
    "src/components/orders-table/head.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";
import { INITIAL_SORT, type SortKey } from "./orders-table.ts";

interface Column {
  label: string;
  /** The row value the column sorts by. A column without one is not sortable. */
  key?: SortKey;
  /** Numbers are aligned to the end of the cell. */
  number?: boolean;
}

/** The table's columns, in order. They match the cells src/lib/order-table.ts prints. */
export const COLUMNS: readonly Column[] = [
  { label: "Order", key: "order" },
  { label: "Date", key: "date" },
  { label: "Customer", key: "customer" },
  { label: "Titles" },
  { label: "Total", key: "total", number: true },
  { label: "Status", key: "status" },
];

/**
 * The heading row. A sortable column's heading is a button, disabled until the
 * script runs, and its \`aria-sort\` says how the rows the build printed are
 * ordered.
 */
export const sortableHead = (columns: readonly Column[] = COLUMNS): SafeHtml =>
  html\`<tr>
    \${columns.map((column) =>
      column.key === undefined
        ? html\`<th scope="col">\${column.label}</th>\`
        : html\`<th
            scope="col"
            class="\${column.number ? "column number" : "column"}"
            aria-sort="\${
              column.key === INITIAL_SORT.key ? INITIAL_SORT.direction : "none"
            }"
          >
            <button
              class="sort"
              type="button"
              data-key="\${column.key}"
              data-testid="orders-table-sort-\${column.key}"
              disabled
            >
              \${column.label}
            </button>
          </th>\`,
    )}
  </tr>\`;
`,
  ],

  [
    "src/components/orders-table/orders-table.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLUMNS, sortableHead } from "./head.ts";
import {
  INITIAL_SORT,
  PAGE_SIZE,
  compareRows,
  matches,
  nextDirection,
  pageCount,
  summaryOf,
  viewOf,
  type RowData,
  type TableState,
} from "./orders-table.ts";

const row = (
  order: string,
  date: string,
  customer: string,
  total: number,
  status: string,
): RowData => ({
  order,
  date,
  customer,
  total,
  status,
  text: \`\${order} \${date} \${customer} \${status}\`.toLowerCase(),
});

const ROWS: RowData[] = [
  row("IMSA-1002", "2026-10-02", "Hurley Haywood", 4200, "Shipped"),
  row("IMSA-1010", "2026-10-09", "jordan taylor", 1650, "Paid"),
  row("IMSA-1001", "2026-10-02", "Paul Newman", 990, "Refunded"),
  row("IMSA-1003", "2026-10-05", "Ross Bentley", 10000, "Shipped"),
];

const state = (changes: Partial<TableState> = {}): TableState => ({
  key: "date",
  direction: "descending",
  query: "",
  status: "",
  page: 1,
  ...changes,
});

const ordersOf = (changes: Partial<TableState>): string[] =>
  viewOf(ROWS, state(changes)).order.map((index) => ROWS[index].order);

describe("orders-table component", () => {
  const source = (): Promise<string> =>
    readFile(
      join(process.cwd(), "src/components/orders-table/orders-table.html"),
      "utf8",
    );

  it("is a table with a caption, whose heading row and order rows are printed at build time", async () => {
    const html = await source();
    expect(html).toContain("<caption>");
    expect(html.match(/<script data-bascik-build-once/g)).toHaveLength(2);
    expect(html).toContain("sortableHead()");
    expect(html).toContain("orderRows(currentOrders())");
  });

  it("keeps its filter and pager hidden until the script runs", async () => {
    const html = await source();
    expect(html).toMatch(/<search[^>]*\\bhidden\\b/);
    expect(html).toMatch(/<div[^>]*id="pager"[^>]*\\bhidden\\b/);
    expect(html).toContain('<script type="module" src="orders-table.ts">');
  });

  it("never builds markup in the browser", async () => {
    const script = await readFile(
      join(process.cwd(), "src/components/orders-table/orders-table.ts"),
      "utf8",
    );
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|document\\.write/);
  });
});

describe("sortableHead", () => {
  const head = String(sortableHead());

  it("gives every column a heading with a scope, and every sortable one aria-sort", () => {
    expect(head.match(/<th\\b/g)).toHaveLength(COLUMNS.length);
    expect(head.match(/<th\\s+scope="col"/g)).toHaveLength(COLUMNS.length);
    expect(head.match(/aria-sort="/g)).toHaveLength(5);
  });

  it("says how the build ordered the rows: newest first, and no other column sorted", () => {
    expect(INITIAL_SORT).toEqual({ key: "date", direction: "descending" });
    expect(head.match(/aria-sort="descending"/g)).toHaveLength(1);
    expect(head.match(/aria-sort="none"/g)).toHaveLength(4);
    expect(head).not.toContain('aria-sort="ascending"');
  });

  it("makes each sortable heading a real button, off until the script runs, with a test id", () => {
    const buttons = head.match(/<button\\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      expect(button).toContain('type="button"');
      expect(button).toMatch(
        /data-key="([a-z]+)"[^>]*data-testid="orders-table-sort-\\1"/,
      );
      expect(button).toMatch(/\\bdisabled\\b/);
    }
  });

  it("escapes a column label that holds markup", () => {
    const markup = String(sortableHead([{ label: "<b>Tom & Ann</b>" }]));
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("Tom &amp; Ann");
  });
});

describe("compareRows", () => {
  it("sorts each column both ways", () => {
    expect(ordersOf({ key: "total", direction: "ascending" })).toEqual([
      "IMSA-1001",
      "IMSA-1010",
      "IMSA-1002",
      "IMSA-1003",
    ]);
    expect(ordersOf({ key: "total", direction: "descending" })).toEqual([
      "IMSA-1003",
      "IMSA-1002",
      "IMSA-1010",
      "IMSA-1001",
    ]);
    expect(ordersOf({ key: "order", direction: "ascending" })).toEqual([
      "IMSA-1001",
      "IMSA-1002",
      "IMSA-1003",
      "IMSA-1010",
    ]);
    expect(ordersOf({ key: "status", direction: "ascending" })[0]).toBe(
      "IMSA-1010",
    );
  });

  it("sorts a total as a number, not as text", () => {
    // As text "10000" would come before "990".
    expect(ordersOf({ key: "total", direction: "ascending" })[0]).toBe(
      "IMSA-1001",
    );
  });

  it("breaks a tie by order number, in the direction of the sort", () => {
    expect(
      ordersOf({ key: "date", direction: "ascending" }).slice(0, 2),
    ).toEqual(["IMSA-1001", "IMSA-1002"]);
    expect(
      ordersOf({ key: "date", direction: "descending" }).slice(-2),
    ).toEqual(["IMSA-1002", "IMSA-1001"]);
  });

  it("ignores letter case in names", () => {
    expect(
      ordersOf({ key: "customer", direction: "ascending" }).slice(0, 2),
    ).toEqual(["IMSA-1003", "IMSA-1010"]);
  });

  it("misuse: a total that is not a number sorts as zero and never breaks the order", () => {
    const rows = [row("IMSA-2", "2026-10-01", "A", Number.NaN, "Paid"), ROWS[0]];
    expect(compareRows(rows[0], rows[1], "total", "ascending")).toBeLessThan(0);
    expect(
      Number.isNaN(compareRows(rows[0], rows[0], "total", "ascending")),
    ).toBe(false);
  });
});

describe("nextDirection", () => {
  it("reverses the sorted column and starts a new column ascending", () => {
    const sorted = { key: "total", direction: "ascending" } as const;
    expect(nextDirection(sorted, "total")).toBe("descending");
    expect(nextDirection({ ...sorted, direction: "descending" }, "total")).toBe(
      "ascending",
    );
    expect(nextDirection(sorted, "customer")).toBe("ascending");
  });
});

describe("matches", () => {
  it("filters by text without regard to case or surrounding spaces, and by status", () => {
    expect(ordersOf({ query: "  JORDAN " })).toEqual(["IMSA-1010"]);
    expect(ordersOf({ status: "Shipped" })).toEqual(["IMSA-1003", "IMSA-1002"]);
    expect(ordersOf({ query: "ross", status: "Shipped" })).toEqual([
      "IMSA-1003",
    ]);
    expect(matches(ROWS[0], "", "")).toBe(true);
  });

  it("misuse: text that matches nothing, or a status no row has, shows no rows", () => {
    expect(ordersOf({ query: "<script>" })).toEqual([]);
    expect(ordersOf({ status: "Lost" })).toEqual([]);
  });
});

describe("paging", () => {
  const many = Array.from({ length: 23 }, (_, index) =>
    row(\`IMSA-\${2000 + index}\`, "2026-10-01", "Jordan Taylor", index, "Paid"),
  );

  it("counts pages, with one page for an empty table", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(PAGE_SIZE)).toBe(1);
    expect(pageCount(PAGE_SIZE + 1)).toBe(2);
    expect(pageCount(-4)).toBe(1);
    expect(pageCount(5, 0)).toBe(5);
  });

  it("shows one page of rows at a time, the last page with what is left", () => {
    const first = viewOf(many, state({ key: "total", direction: "ascending" }));
    expect(first.pages).toBe(3);
    expect(first.shown).toHaveLength(PAGE_SIZE);
    const last = viewOf(
      many,
      state({ key: "total", direction: "ascending", page: 3 }),
    );
    expect(last.shown).toEqual([20, 21, 22]);
  });

  it("misuse: a page before the first, past the last, or not a number becomes a real page", () => {
    expect(viewOf(many, state({ page: 0 })).page).toBe(1);
    expect(viewOf(many, state({ page: -2 })).page).toBe(1);
    expect(viewOf(many, state({ page: 99 })).page).toBe(3);
    expect(viewOf(many, state({ page: Number.NaN })).page).toBe(1);
    // Filtering down to fewer pages brings the page back in range.
    expect(viewOf(many, state({ page: 3, query: "imsa-2001" })).page).toBe(1);
  });

  it("says which rows are shown, and that a filter is on", () => {
    expect(summaryOf(viewOf(many, state()), many.length)).toBe(
      "Showing 1 to 10 of 23 orders",
    );
    expect(summaryOf(viewOf(many, state({ page: 3 })), many.length)).toBe(
      "Showing 21 to 23 of 23 orders",
    );
    expect(
      summaryOf(viewOf(many, state({ query: "imsa-200" })), many.length),
    ).toBe("Showing 1 to 10 of 10 orders (filtered from 23)");
    expect(
      summaryOf(viewOf(many, state({ query: "nothing" })), many.length),
    ).toBe("No orders shown, of 23");
  });
});
`,
  ],

  [
    "src/components/stock-table/stock-table.html",
    `<!-- @bascik
Every title with its price, stock and sales, in a table built at build time. Each title links to its own page.
-->
<section class="card" aria-labelledby="heading" data-testid="stock-table">
  <h2 id="heading" class="visually-hidden">All titles</h2>
  <div class="table-scroll">
    <table class="data-table data-table-wide">
      <caption>
        Titles, with units sold over the last 30 days
      </caption>
      <thead>
        <tr>
          <th scope="col">Title</th>
          <th scope="col">Author</th>
          <th scope="col" class="number">Price</th>
          <th scope="col" class="number">In stock</th>
          <th scope="col" class="number">Units sold</th>
          <th scope="col">Stock status</th>
        </tr>
      </thead>
      <tbody>
        <script data-bascik-build-once type="text/typescript">
          import { stockRows } from "./stock.ts";
          export default () => stockRows();
        </script>
      </tbody>
    </table>
  </div>
</section>
`,
  ],

  [
    "src/components/stock-table/stock.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";
import {
  currentOrders,
  formatMoney,
  stockStatus,
  unitsOf,
  TITLES,
  type Order,
  type Title,
} from "../../lib/shop.ts";

/** One row per title, or one row that says there are none. */
export function stockRows(
  titles: readonly Title[] = TITLES,
  orders: readonly Order[] = currentOrders(),
): SafeHtml {
  if (titles.length === 0)
    return html\`<tr class="empty-row">
      <td colspan="6">No titles yet. Add one to src/lib/shop.ts.</td>
    </tr>\`;
  return html\`\${titles.map(
    (title) =>
      html\`<tr>
        <td><a href="/titles/\${title.slug}">\${title.title}</a></td>
        <td>\${title.author}</td>
        <td class="number">\${formatMoney(title.priceCents)}</td>
        <td class="number">\${title.stock}</td>
        <td class="number">\${unitsOf(orders, title.slug)}</td>
        <td>
          <status-badge
            data-bascik-prop-status="\${stockStatus(title)}"
          ></status-badge>
        </td>
      </tr>\`,
  )}\`;
}
`,
  ],

  [
    "src/components/stock-table/stock-table.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TITLES } from "../../lib/shop.ts";
import { stockRows } from "./stock.ts";

describe("stock-table component", () => {
  it("is a table with a caption and a scope on every column heading", async () => {
    const html = await readFile(
      join(process.cwd(), "src/components/stock-table/stock-table.html"),
      "utf8",
    );
    expect(html).toContain("<caption>");
    expect(html.match(/<th\\b/g)).toHaveLength(6);
    expect(html.match(/<th scope="col"/g)).toHaveLength(6);
    expect(html).toContain("<script data-bascik-build-once");
  });
});

describe("stockRows", () => {
  it("prints one row per title, linked to its page, with its stock status", () => {
    const markup = String(stockRows());
    expect(markup.match(/<tr\\b/g)).toHaveLength(TITLES.length);
    for (const title of TITLES)
      expect(markup).toContain(\`href="/titles/\${title.slug}"\`);
    for (const status of ["In stock", "Low stock", "Preorder"])
      expect(markup).toContain(\`data-bascik-prop-status="\${status}"\`);
  });

  it("counts no units for any title when there are no orders", () => {
    const markup = String(stockRows(TITLES.slice(0, 1), []));
    expect(markup).toContain('<td class="number">0</td>');
  });

  it("misuse: with no titles it says so in one row across every column", () => {
    const markup = String(stockRows([]));
    expect(markup.match(/<tr\\b/g)).toHaveLength(1);
    expect(markup).toContain('colspan="6"');
  });

  it("escapes a title that holds markup", () => {
    const markup = String(
      stockRows([{ ...TITLES[0], title: "<i>Tom & Ann</i>" }], []),
    );
    expect(markup).not.toContain("<i>");
    expect(markup).toContain("Tom &amp; Ann");
  });
});
`,
  ],

  [
    "src/components/title-detail/title-detail.html",
    `<!-- @bascik
One title's page: its facts, its weekly sales as a bar chart, and the orders that include it. The build script reads the route (BASCIK_ROUTE) that src/pages/titles/[slug].html is being built for, so the same component prints every title.
-->
<style>
  .detail {
    display: grid;
    gap: var(--space-4);
  }

  .byline {
    color: var(--color-muted);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
    gap: var(--space-3);
    margin: 0;
  }

  .fact {
    padding: var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface);
  }

  .term {
    color: var(--color-muted);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .figure {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
</style>
<article class="detail" data-testid="title-detail">
  <script data-bascik-build type="text/typescript">
    import { titleDetail } from "./detail.ts";
    export default () => {
      const route = JSON.parse(process.env.BASCIK_ROUTE || "{}");
      // Bascik also runs this script once with no page, to learn whether the
      // component could be rendered per request. There is no title to print then.
      const slug: string | undefined = route.params?.slug;
      return slug === undefined ? "" : titleDetail(slug);
    };
  </script>
</article>
`,
  ],

  [
    "src/components/title-detail/detail.ts",
    `import { html, type SafeHtml } from "@bascik/bascik/html";
import { barChart, chartTable } from "../../lib/charts.ts";
import { orderTable } from "../../lib/order-table.ts";
import {
  currentOrders,
  formatMoney,
  formatShortDate,
  ordersWithTitle,
  stockStatus,
  titleNamed,
  unitsOf,
  weeklyUnits,
  ORDERS,
  type Order,
} from "../../lib/shop.ts";

/**
 * Everything inside one title's <article>. An unknown slug throws, which fails
 * the build with the slug in the message instead of printing an empty page.
 */
export function titleDetail(
  slug: string,
  orders: readonly Order[] = ORDERS,
): SafeHtml {
  const title = titleNamed(slug);
  const weeks = weeklyUnits(slug, orders).map((week) => ({
    label: \`Week of \${formatShortDate(week.weekOf)}\`,
    value: week.units,
  }));
  const sold = weeks.some((week) => week.value > 0);
  const withTitle = ordersWithTitle(slug, orders);
  return html\`<header>
      <p><a href="/titles">All titles</a></p>
      <h1>\${title.title}</h1>
      <p class="byline">by \${title.author}</p>
    </header>
    <dl class="facts">
      <div class="fact">
        <dt class="term">Price</dt>
        <dd class="figure">\${formatMoney(title.priceCents)}</dd>
      </div>
      <div class="fact">
        <dt class="term">In stock</dt>
        <dd class="figure">\${title.stock}</dd>
      </div>
      <div class="fact">
        <dt class="term">Sold in the last 30 days</dt>
        <dd class="figure">\${unitsOf(currentOrders(orders), slug)}</dd>
      </div>
      <div class="fact">
        <dt class="term">Stock status</dt>
        <dd class="figure">
          <status-badge
            data-bascik-prop-status="\${stockStatus(title)}"
          ></status-badge>
        </dd>
      </div>
    </dl>
    <section class="card">
      <h2>Weekly sales</h2>
      <chart-figure
        data-bascik-prop-caption="Units sold per week over the last \${weeks.length} weeks."
      >
        \${barChart(sold ? weeks : [], {
          label: \`Units of \${title.title} sold in each of the last \${weeks.length} weeks. The table below has each figure.\`,
          emptyText: \`No copies sold in the last \${weeks.length} weeks.\`,
        })}
        <div data-bascik-slot="table">
          \${chartTable(weeks, {
            caption: "Units sold per week",
            labelHeading: "Week",
            valueHeading: "Units sold",
          })}
        </div>
      </chart-figure>
    </section>
    <section class="card">
      <h2>Orders with this title</h2>
      <div class="table-scroll">
        \${orderTable(withTitle.slice(0, 10), {
          caption:
            withTitle.length > 10
              ? \`The 10 newest of \${withTitle.length} orders in the last 60 days\`
              : "Orders in the last 60 days",
          emptyText: "No orders include this title yet.",
        })}
      </div>
    </section>\`;
}
`,
  ],

  [
    "src/components/title-detail/title-detail.test.ts",
    `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TITLES, ordersWithTitle } from "../../lib/shop.ts";
import { titleDetail } from "./detail.ts";

describe("title-detail component", () => {
  const source = (): Promise<string> =>
    readFile(
      join(process.cwd(), "src/components/title-detail/title-detail.html"),
      "utf8",
    );

  it("is an <article> built per page from the route's slug", async () => {
    const html = await source();
    expect(html).toMatch(/<article[^>]*data-testid="title-detail"/);
    expect(html).toContain("<script data-bascik-build ");
    expect(html).toContain("process.env.BASCIK_ROUTE");
  });

  it("prints nothing when it is built with no route", async () => {
    expect(await source()).toContain(
      'slug === undefined ? "" : titleDetail(slug)',
    );
  });
});

describe("titleDetail", () => {
  it("prints every title: one heading, its facts, a chart figure, and its orders", () => {
    for (const title of TITLES) {
      const markup = String(titleDetail(title.slug));
      expect(markup.match(/<h1\\b/g), title.slug).toHaveLength(1);
      expect(markup).toContain(\`by \${title.author}\`);
      expect(markup).toContain("<chart-figure");
      expect(markup.match(/<h2\\b/g)).toHaveLength(2);
      expect(markup).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it("draws a title's weekly sales and lists at most ten of its orders", () => {
    const { slug } = TITLES[0];
    const markup = String(titleDetail(slug));
    expect(markup).toContain("<svg");
    expect(ordersWithTitle(slug).length).toBeGreaterThan(10);
    expect(markup.match(/<tr\\s+data-order=/g)).toHaveLength(10);
    expect(markup).toContain(
      \`The 10 newest of \${ordersWithTitle(slug).length} orders\`,
    );
  });

  it("shows written empty states for a title nobody has ordered", () => {
    const markup = String(titleDetail("harbor-songs-for-late-arrivals"));
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("No copies sold in the last 8 weeks.");
    expect(markup).toContain("No orders include this title yet.");
    expect(markup).toContain('data-bascik-prop-status="Preorder"');
  });

  it("misuse: a slug that names no title throws, so the build fails instead of printing an empty page", () => {
    expect(() => titleDetail("no-such-book")).toThrow(/"no-such-book"/);
  });
});
`,
  ],
];
