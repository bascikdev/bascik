/**
 * @module templates/reports/data
 *
 * The demo data of the `reports` template: four months of an invented
 * bookshop's sales, written to `data/reports/<period>.json`. Each file is what
 * a person would export from a till or a spreadsheet: one line per title,
 * format and channel, with money as whole cents.
 */

interface Book {
  title: string;
  author: string;
  /** Units a typical month sells in store, in the book's first format. */
  pace: number;
  formats: readonly Format[];
  /** The first period the book is on sale, as an index into `PERIODS`. */
  from?: number;
}

type Format = "Hardcover" | "Paperback" | "Ebook" | "Audiobook";
type Channel = "In store" | "Online" | "Events";

/** One line of a period's sales file. */
export interface DemoSale {
  title: string;
  author: string;
  format: Format;
  channel: Channel;
  units: number;
  revenueCents: number;
}

const PRICE_CENTS: Record<Format, number> = {
  Hardcover: 2800,
  Paperback: 1700,
  Ebook: 999,
  Audiobook: 1999,
};

/** Invented titles and authors. One title has an `&` so the starter shows escaping at work. */
const BOOKS: readonly Book[] = [
  {
    title: "The Salt Cartographer",
    author: "Imogen Vale",
    pace: 46,
    formats: ["Hardcover", "Ebook"],
  },
  {
    title: "Night Ferry to Halvard",
    author: "Tobias Renn",
    pace: 38,
    formats: ["Paperback", "Audiobook"],
  },
  {
    title: "A Field Guide to Quiet Rooms",
    author: "Priya Anand-Holt",
    pace: 31,
    formats: ["Hardcover", "Ebook"],
  },
  {
    title: "Bread, Smoke & Ash",
    author: "Marguerite Oyelaran",
    pace: 27,
    formats: ["Hardcover", "Paperback"],
  },
  {
    title: "The Lighthouse Ledger",
    author: "Samuel Okafor-Reyes",
    pace: 22,
    formats: ["Paperback", "Ebook"],
  },
  {
    title: "Small Hours, Large Print",
    author: "Dele Whitcombe",
    pace: 17,
    formats: ["Paperback", "Audiobook"],
  },
  {
    title: "Understory",
    author: "Imogen Vale",
    pace: 14,
    formats: ["Paperback", "Ebook"],
  },
  {
    title: "How to Read a River",
    author: "Hana Bergqvist",
    pace: 34,
    formats: ["Hardcover", "Audiobook"],
    from: 2,
  },
];

/** The demo periods, oldest first, with how busy each month was (percent of a typical month) and its notes. */
const PERIODS: readonly { period: string; busy: number; notes: string[] }[] = [
  {
    period: "2026-07",
    busy: 96,
    notes: [
      "The shop was closed on July 3 and July 4.",
      "An author signing with Imogen Vale on July 18 accounts for most event sales.",
    ],
  },
  {
    period: "2026-08",
    busy: 90,
    notes: ["No events were held in August, so the Events channel is empty."],
  },
  {
    period: "2026-09",
    busy: 101,
    notes: [
      '"How to Read a River" by Hana Bergqvist went on sale on September 8.',
    ],
  },
  {
    period: "2026-10",
    busy: 112,
    notes: [
      "The autumn book fair ran from October 9 to October 11.",
      "Online orders include pre-orders that shipped in October.",
    ],
  },
];

/** A small repeatable generator, so every scaffold writes the same figures. */
const jitter = (seed: number): number => {
  let state = (seed * 2654435761) >>> 0;
  state = (Math.imul(state ^ (state >>> 15), 2246822519) >>> 0) ^ seed;
  state = Math.imul(state ^ (state >>> 13), 3266489917) >>> 0;
  // 85 to 115 percent.
  return 85 + (state % 31);
};

const salesOf = (periodIndex: number): DemoSale[] => {
  const { busy } = PERIODS[periodIndex];
  const sales: DemoSale[] = [];
  BOOKS.forEach((book, bookIndex) => {
    if ((book.from ?? 0) > periodIndex) return;
    const [first, second] = book.formats;
    const lines: [Format, Channel, number][] = [
      [first, "In store", 100],
      [first, "Online", 55],
      // Events sell the printed book, and only in months that had one.
      [first, "Events", periodIndex === 1 ? 0 : bookIndex % 3 === 0 ? 30 : 12],
      [second, "Online", 45],
    ];
    lines.forEach(([format, channel, weight], lineIndex) => {
      const seed = periodIndex * 1000 + bookIndex * 10 + lineIndex + 1;
      const units = Math.round(
        (book.pace * weight * busy * jitter(seed)) / 1_000_000,
      );
      if (units === 0) return;
      sales.push({
        title: book.title,
        author: book.author,
        format,
        channel,
        units,
        revenueCents: units * PRICE_CENTS[format],
      });
    });
  });
  return sales;
};

/** A period's file as text: one sale per line, so the file reads like the table it is. */
const reportJson = (
  period: string,
  notes: readonly string[],
  sales: readonly DemoSale[],
): string =>
  `{
  "period": ${JSON.stringify(period)},
  "notes": [
${notes.map((note) => `    ${JSON.stringify(note)}`).join(",\n")}
  ],
  "sales": [
${sales
  .map(
    (sale) =>
      `    { "title": ${JSON.stringify(sale.title)}, "author": ${JSON.stringify(sale.author)}, "format": ${JSON.stringify(sale.format)}, "channel": ${JSON.stringify(sale.channel)}, "units": ${sale.units}, "revenueCents": ${sale.revenueCents} }`,
  )
  .join(",\n")}
  ]
}
`;

/** The demo periods, oldest first. */
export const DEMO_PERIODS: readonly string[] = PERIODS.map(
  ({ period }) => period,
);

/** The sales lines of one demo period. */
export const demoSales = (period: string): DemoSale[] =>
  salesOf(DEMO_PERIODS.indexOf(period));

/** `data/reports/<period>.json` for every demo period. */
export const DATA_FILES: [path: string, data: string][] = PERIODS.map(
  ({ period, notes }, index) => [
    `data/reports/${period}.json`,
    reportJson(period, notes, salesOf(index)),
  ],
);
