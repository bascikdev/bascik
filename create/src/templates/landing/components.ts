/**
 * @module templates/landing/components
 *
 * The landing template's components, their data modules and their tests, as the
 * text of each generated file.
 */

import { SITE_FOOTER_CSS, SITE_HEADER_CSS } from "../../scaffold.js";

/** `src/components/faq-list/faq-list.html` */
export const FAQ_LIST_HTML = `<!-- @bascik
The questions section: a heading and one <details> per entry in faqs.ts, printed at build time. <details> and <summary> open and close without a script.
-->
<style>
.list { max-width: 760px; }

.item { border-bottom: 1px solid var(--border); }
.item:first-child { border-top: 1px solid var(--border); }

.question {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  list-style: none;
}
.question::-webkit-details-marker { display: none; }
.question::after {
  content: "+";
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 1.2rem;
  color: var(--accent);
}
.item[open] .question::after { content: "\\2212"; }

.answer { margin: 0; padding: 0 0 18px; max-width: 640px; }
</style>
<section class="section" data-testid="faq-list">
  <div class="container">
    <section-head
      data-bascik-prop-label="FAQ"
      data-bascik-prop-title="Questions readers ask"
      data-bascik-prop-text="The short answers. Write to us if yours is not here."
    />
    <div class="list">
      <script data-bascik-build-once type="text/typescript">
        import { faqItems, faqs } from "./faqs.ts";
        export default () => faqItems(faqs);
      </script>
    </div>
  </div>
</section>
`;

/** `src/components/faq-list/faq-list.test.ts` */
export const FAQ_LIST_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { faqItems, faqs } from './faqs.ts';

describe('faq-list component', () => {
  const path = join(process.cwd(), 'src/components/faq-list/faq-list.html');

  it('is a section with a heading that prints its questions from faqs.ts, with no browser script', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<section class="section" data-testid="faq-list">');
    expect(html).toContain('<section-head');
    expect(html).toContain('from "./faqs.ts"');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('prints each question as a closed <details> with a <summary>', () => {
    const out = String(faqItems(faqs));
    expect(out.match(/<details /g)).toHaveLength(faqs.length);
    expect(out.match(/<summary /g)).toHaveLength(faqs.length);
    expect(out).not.toMatch(/<details[^>]*\\sopen/);
    expect(out).toContain(faqs[0].question);
    expect(out).toContain(faqs[0].answer);
  });

  it('misuse: markup and replacement patterns in the data are printed as text', () => {
    const out = String(faqItems([{ question: 'Is <summary> safe & sound? $&', answer: '</details><img src=x onerror=alert(1)> $1' }]));
    expect(out).toContain('Is &lt;summary&gt; safe &amp; sound? $&amp;');
    expect(out).toContain('&lt;/details&gt;&lt;img src=x onerror=alert(1)&gt; $1');
    expect(out.match(/<\\/details>/g)).toHaveLength(1);
    expect(out).not.toContain('<img');
  });

  it('misuse: an empty list fails the build and says what to do', () => {
    expect(() => faqItems([])).toThrow(/faqs\\.ts has no questions.*remove <faq-list \\/>/);
  });
});
`;

/** `src/components/faq-list/faqs.ts` */
export const FAQS_TS = `// The questions <faq-list> shows. The component prints one <details> per
// entry at build time.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Faq {
  question: string;
  answer: string;
}

export const faqs: readonly Faq[] = [
  {
    question: "When does my box ship?",
    answer:
      "Boxes go out on the 1st of each month and arrive by the 5th in most places.",
  },
  {
    question: "Can I skip a month or cancel?",
    answer:
      "Yes. Skip or cancel from your account before the 25th and you are not charged for the next box.",
  },
  {
    question: "What if I have already read the book?",
    answer:
      "Tell us within a week and we will send a different pick at no charge. Keep the first one or pass it on.",
  },
  {
    question: "Do you ship outside the United States?",
    answer:
      "Not yet. Join the waitlist and we will write to you when that changes.",
  },
  {
    question: "Can I give a subscription as a gift?",
    answer:
      "Yes. Choose three, six, or twelve months and we include a card with your message in the first box.",
  },
];

/** One <details> per question. html escapes every value, so the data is always printed as text. */
export function faqItems(items: readonly Faq[]): SafeHtml {
  if (items.length === 0) {
    throw new Error(
      "faq-list: faqs.ts has no questions. Add one, or remove <faq-list /> from src/pages/index.html and its link from site-header.html.",
    );
  }
  return html\`\${items.map(
    (faq) =>
      html\`<details class="item" data-testid="faq-list-item">
        <summary class="question" data-testid="faq-list-question">
          \${faq.question}
        </summary>
        <p class="answer" data-testid="faq-list-answer">\${faq.answer}</p>
      </details>\`,
  )}\`;
}
`;

/** `src/components/feature-list/feature-list.html` */
export const FEATURE_LIST_HTML = `<!-- @bascik
The features section: a heading and a grid with one card per entry in features.ts, printed at build time.
-->
<style>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
  gap: 20px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.feature {
  background: var(--surface) var(--panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 24px;
  box-shadow: var(--sheen), var(--shadow);
}
.title { font-size: 1rem; color: var(--text); margin-bottom: 6px; }
.text  { font-size: 0.9rem; margin-bottom: 0; }
</style>
<section class="section" data-testid="feature-list">
  <div class="container">
    <section-head
      data-bascik-prop-label="Features"
      data-bascik-prop-title="A book box that respects your time"
      data-bascik-prop-text="Everything in the box is there to help you read one good book, not to fill a shelf."
    />
    <ul class="grid" role="list">
      <script data-bascik-build-once type="text/typescript">
        import { featureCards, features } from "./features.ts";
        export default () => featureCards(features);
      </script>
    </ul>
  </div>
</section>
`;

/** `src/components/feature-list/feature-list.test.ts` */
export const FEATURE_LIST_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { featureCards, features } from './features.ts';

describe('feature-list component', () => {
  const path = join(process.cwd(), 'src/components/feature-list/feature-list.html');

  it('is a section with a heading that prints its cards from features.ts at build time', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<section class="section" data-testid="feature-list">');
    expect(html).toContain('<section-head');
    expect(html).toContain('data-bascik-build-once');
    expect(html).toContain('from "./features.ts"');
  });

  it('prints one card per feature, in order', () => {
    const out = String(featureCards(features));
    expect(out.match(/<li class="feature">/g)).toHaveLength(features.length);
    expect(out.indexOf(features[0].title)).toBeLessThan(out.indexOf(features[1].title));
  });

  it('misuse: markup and replacement patterns in the data are printed as text', () => {
    const out = String(featureCards([{ title: '<b>$& & $1</b>', text: '"quoted" $\` <script>x</script>' }]));
    expect(out).toContain('&lt;b&gt;$&amp; &amp; $1&lt;/b&gt;');
    expect(out).toContain('$\` &lt;script&gt;x&lt;/script&gt;');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('<script>');
  });

  it('misuse: an empty list fails the build and says what to do', () => {
    expect(() => featureCards([])).toThrow(/features\\.ts has no features.*remove <feature-list \\/>/);
  });
});
`;

/** `src/components/feature-list/features.ts` */
export const FEATURES_TS = `// The features <feature-list> shows. Add, remove, or reorder entries here:
// the component prints one card per entry at build time.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Feature {
  title: string;
  text: string;
}

export const features: readonly Feature[] = [
  {
    title: "Chosen by a bookseller",
    text: "Every pick is read cover to cover by someone at the shop before it goes in a box. No algorithm, no bestseller list.",
  },
  {
    title: "A letter with every book",
    text: "One page on why this book, what to notice, and what to read next if you love it.",
  },
  {
    title: "A reading group that fits your month",
    text: "Join the online discussion on the last Sunday, or read at your own pace and catch the notes.",
  },
  {
    title: "Skip a month anytime",
    text: "Going away, or behind on your pile? Skip a box in two clicks and pay nothing for it.",
  },
  {
    title: "Signed when we can",
    text: "About one box in four comes with a bookplate signed by the author.",
  },
  {
    title: "Plastic-free packing",
    text: "Boxes are recycled card and paper tape, sized to fit a mailbox.",
  },
];

/** One card per feature. html escapes every value, so the data is always printed as text. */
export function featureCards(items: readonly Feature[]): SafeHtml {
  if (items.length === 0) {
    throw new Error(
      "feature-list: features.ts has no features. Add one, or remove <feature-list /> from src/pages/index.html and its link from site-header.html.",
    );
  }
  return html\`\${items.map(
    (feature) =>
      html\`<li class="feature">
        <h3 class="title">\${feature.title}</h3>
        <p class="text">\${feature.text}</p>
      </li>\`,
  )}\`;
}
`;

/** `src/components/home-hero/home-hero.html` */
export const HOME_HERO_HTML = `<!-- @bascik
The top of the home page: the page's one h1, the pitch, the primary call to action, and a drawing of a stack of books. The drawing is inline SVG, colored from the design tokens in src/pages/css/styles.css.
-->
<style>
figure { margin: 44px 0 0; }
figcaption { margin-top: 16px; font-size: 0.95rem; color: var(--text-muted); }
cite { color: var(--text); }

.art { display: block; width: min(260px, 70%); height: auto; margin: 0 auto; }
.book-low  { fill: var(--elevated); stroke: var(--border-hover); }
.book-mid  { fill: var(--accent); }
.book-top  { fill: var(--surface); stroke: var(--accent); }
.page-edge { fill: var(--text); opacity: 0.85; }
.ribbon    { fill: var(--accent); }
</style>
<section class="hero" data-testid="home-hero">
  <div class="container">
    <h1>One good book a month, <span>chosen by a bookseller</span></h1>
    <p>A real person at an independent bookshop reads widely, picks one book for you, and writes you a letter about why. You just read.</p>
    <div class="hero-actions">
      <a href="#signup" class="btn btn-primary" data-testid="home-hero-cta">Join the waitlist</a>
      <a href="#how-it-works" class="btn btn-ghost" data-testid="home-hero-how">See how it works</a>
    </div>
    <figure>
      <svg class="art" viewBox="0 0 240 120" role="img" aria-label="A stack of three books with a ribbon bookmark hanging from the middle one">
        <rect class="book-low" x="20" y="80" width="200" height="30" rx="4" />
        <rect class="page-edge" x="196" y="85" width="18" height="20" rx="2" />
        <rect class="book-mid" x="36" y="46" width="176" height="30" rx="4" />
        <rect class="page-edge" x="42" y="51" width="18" height="20" rx="2" />
        <path class="ribbon" d="M150 76v24l-7-6-7 6V76z" />
        <rect class="book-top" x="28" y="12" width="184" height="30" rx="4" />
        <rect class="page-edge" x="188" y="17" width="18" height="20" rx="2" />
      </svg>
      <figcaption>In the first box: <cite>The Salt Orchard</cite> by Marta Varga.</figcaption>
    </figure>
  </div>
</section>
`;

/** `src/components/home-hero/home-hero.test.ts` */
export const HOME_HERO_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('home-hero component', () => {
  const path = join(process.cwd(), 'src/components/home-hero/home-hero.html');

  it("holds the page's one h1 and a call to action that points at the sign-up section", async () => {
    const html = await readFile(path, 'utf8');
    expect(html.match(/<h1[\\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<a href="#signup"[^>]*data-testid="home-hero-cta"/);
  });

  it('gives its drawing a text alternative and loads no image file', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="[^"]+"/);
    expect(html).not.toContain('<img');
  });
});
`;

/** `src/components/how-it-works/how-it-works.html` */
export const HOW_IT_WORKS_HTML = `<!-- @bascik
The "how it works" section: a heading and an ordered list with one step per entry in steps.ts, printed at build time. The numbers are drawn with a CSS counter; the <ol> carries the order.
-->
<style>
.steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 20px;
  list-style: none;
  margin: 0;
  padding: 0;
  counter-reset: step;
}

.step { counter-increment: step; padding-top: 4px; }
.step::before {
  content: counter(step);
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-bottom: 14px;
  border-radius: 50%;
  background: var(--accent-dim);
  color: var(--accent);
  font-family: var(--mono);
  font-weight: 700;
}
.title { font-size: 1rem; color: var(--text); margin-bottom: 6px; }
.text  { font-size: 0.9rem; margin-bottom: 0; }
</style>
<section class="section" data-testid="how-it-works">
  <div class="container">
    <section-head
      data-bascik-prop-label="How it works"
      data-bascik-prop-title="From our shelves to your door"
      data-bascik-prop-text="Four steps, and only the first one asks anything of you."
    />
    <ol class="steps" role="list">
      <script data-bascik-build-once type="text/typescript">
        import { stepItems, steps } from "./steps.ts";
        export default () => stepItems(steps);
      </script>
    </ol>
  </div>
</section>
`;

/** `src/components/how-it-works/how-it-works.test.ts` */
export const HOW_IT_WORKS_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stepItems, steps } from './steps.ts';

describe('how-it-works component', () => {
  const path = join(process.cwd(), 'src/components/how-it-works/how-it-works.html');

  it('is a section with a heading that prints an ordered list from steps.ts at build time', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<section class="section" data-testid="how-it-works">');
    expect(html).toContain('<section-head');
    expect(html).toMatch(/<ol class="steps"/);
    expect(html).toContain('from "./steps.ts"');
  });

  it('prints one item per step, in order', () => {
    const out = String(stepItems(steps));
    expect(out.match(/<li class="step">/g)).toHaveLength(steps.length);
    expect(out.indexOf(steps[0].title)).toBeLessThan(out.indexOf(steps[1].title));
  });

  it('misuse: markup and replacement patterns in the data are printed as text', () => {
    const out = String(stepItems([{ title: '<i>$1</i>', text: 'Tom & Jerry $& </li>' }]));
    expect(out).toContain('&lt;i&gt;$1&lt;/i&gt;');
    expect(out).toContain('Tom &amp; Jerry $&amp; &lt;/li&gt;');
    expect(out).not.toContain('<i>');
  });

  it('misuse: an empty list fails the build and says what to do', () => {
    expect(() => stepItems([])).toThrow(/steps\\.ts has no steps.*remove <how-it-works \\/>/);
  });
});
`;

/** `src/components/how-it-works/steps.ts` */
export const STEPS_TS = `// The steps <how-it-works> shows, in order. The component prints one list
// item per entry at build time and numbers them with CSS.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Step {
  title: string;
  text: string;
}

export const steps: readonly Step[] = [
  {
    title: "Tell us what you read",
    text: "Pick the genres you love and the ones you avoid. It takes about a minute.",
  },
  {
    title: "We choose your book",
    text: "A bookseller matches you with one new release or overlooked gem each month.",
  },
  {
    title: "It arrives by the 5th",
    text: "Your box lands in the first week of the month, with the letter tucked inside the cover.",
  },
  {
    title: "Talk it over",
    text: "Meet the other readers online at the end of the month, or just enjoy the book.",
  },
];

/** One list item per step. html escapes every value, so the data is always printed as text. */
export function stepItems(items: readonly Step[]): SafeHtml {
  if (items.length === 0) {
    throw new Error(
      "how-it-works: steps.ts has no steps. Add one, or remove <how-it-works /> from src/pages/index.html and its link from site-header.html.",
    );
  }
  return html\`\${items.map(
    (step) =>
      html\`<li class="step">
        <h3 class="title">\${step.title}</h3>
        <p class="text">\${step.text}</p>
      </li>\`,
  )}\`;
}
`;

/** `src/components/pricing-plans/plans.ts` */
export const PLANS_TS = `// The plans <pricing-plans> shows. The component prints one card per entry at
// build time. Each price is written once, here.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Plan {
  name: string;
  /** The price with its currency sign, such as "$18". */
  price: string;
  /** What the price buys, such as "per month". */
  period: string;
  /** One sentence on who the plan is for. */
  blurb: string;
  /** What is in the box, one line each. */
  includes: readonly string[];
  /** Marks the plan to draw the eye to. Give it to one plan. */
  featured?: boolean;
}

export const plans: readonly Plan[] = [
  {
    name: "Paperback",
    price: "$18",
    period: "per month",
    blurb: "For readers who like a book that fits in a coat pocket.",
    includes: [
      "One paperback each month",
      "The bookseller's letter",
      "Skip any month",
    ],
  },
  {
    name: "Hardcover",
    price: "$29",
    period: "per month",
    blurb: "New releases in their first printing, plus the reading group.",
    includes: [
      "One hardcover each month",
      "The bookseller's letter",
      "The monthly reading group",
      "Skip any month",
    ],
    featured: true,
  },
  {
    name: "Book Club",
    price: "$120",
    period: "per month",
    blurb: "Five copies of the same book, for a group that reads together.",
    includes: [
      "Five copies of one book",
      "Questions to start the conversation",
      "A video hello from the bookseller",
      "Skip any month",
    ],
  },
];

/** One card per plan. html escapes every value, so the data is always printed as text. */
export function planCards(items: readonly Plan[]): SafeHtml {
  if (items.length === 0) {
    throw new Error(
      "pricing-plans: plans.ts has no plans. Add one, or remove <pricing-plans /> from src/pages/index.html and its link from site-header.html.",
    );
  }
  return html\`\${items.map(
    (plan) =>
      html\`<article
        class="plan"
        data-featured="\${String(plan.featured === true)}"
        data-testid="pricing-plans-plan"
      >
        \${plan.featured && html\`<p class="badge">Most popular</p>\`}
        <h3 class="name">\${plan.name}</h3>
        <p class="price">
          <span class="amount">\${plan.price}</span> \${plan.period}
        </p>
        <p class="blurb">\${plan.blurb}</p>
        <ul class="includes">
          \${plan.includes.map((line) => html\`<li>\${line}</li>\`)}
        </ul>
        <a
          href="#signup"
          class="btn btn-primary choose"
          data-testid="pricing-plans-choose"
          >Choose \${plan.name}</a
        >
      </article>\`,
  )}\`;
}
`;

/** `src/components/pricing-plans/pricing-plans.html` */
export const PRICING_PLANS_HTML = `<!-- @bascik
The pricing section: a heading and one card per entry in plans.ts, printed at build time. The plan marked featured gets a badge and an accent border. Each card's link goes to the sign-up form.
-->
<style>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 20px;
  align-items: stretch;
}

.plan {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 28px 24px;
  background: var(--surface) var(--panel);
  border: 1px solid var(--border);
  border-radius: 20px;
  box-shadow: var(--sheen), var(--shadow);
}
.plan[data-featured="true"] {
  border-color: var(--accent);
  box-shadow: var(--sheen), 0 0 0 1px var(--accent-dim), var(--shadow);
}

.badge {
  align-self: flex-start;
  margin: 0;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .08em;
}
.name  { font-size: 1.1rem; margin: 0; }
.price { margin: 0; color: var(--text-muted); }
.amount { font-size: 2.25rem; font-weight: 800; line-height: 1; color: var(--text); }
.blurb { margin: 0; font-size: 0.9rem; }
.includes {
  flex: 1;
  margin: 4px 0 8px;
  padding: 0 0 0 1.1em;
  font-size: 0.9rem;
  color: var(--text-muted);
}
.includes li::marker { color: var(--accent); }
.choose { justify-content: center; }
</style>
<section class="section" data-testid="pricing-plans">
  <div class="container">
    <section-head
      data-bascik-prop-label="Pricing"
      data-bascik-prop-title="Pick the box that fits your shelf"
      data-bascik-prop-text="Every plan includes shipping. Skip a month or cancel whenever you like."
    />
    <div class="grid">
      <script data-bascik-build-once type="text/typescript">
        import { planCards, plans } from "./plans.ts";
        export default () => planCards(plans);
      </script>
    </div>
  </div>
</section>
`;

/** `src/components/pricing-plans/pricing-plans.test.ts` */
export const PRICING_PLANS_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { planCards, plans } from './plans.ts';

describe('pricing-plans component', () => {
  const path = join(process.cwd(), 'src/components/pricing-plans/pricing-plans.html');

  it('is a section with a heading that prints its cards from plans.ts at build time', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<section class="section" data-testid="pricing-plans">');
    expect(html).toContain('<section-head');
    expect(html).toContain('from "./plans.ts"');
  });

  it('prints one card per plan with its price, its list, and a link to the sign-up form', () => {
    const out = String(planCards(plans));
    expect(out.match(/<article/g)).toHaveLength(plans.length);
    expect(out.match(/href="#signup"/g)).toHaveLength(plans.length);
    for (const plan of plans) {
      expect(out).toContain(\`<span class="amount">\${plan.price}</span>\`);
      expect(out).toContain(\`Choose \${plan.name}\`);
    }
  });

  it('marks exactly one plan as featured', () => {
    expect(plans.filter((plan) => plan.featured)).toHaveLength(1);
    const out = String(planCards(plans));
    expect(out.match(/data-featured="true"/g)).toHaveLength(1);
    expect(out.match(/Most popular/g)).toHaveLength(1);
  });

  it('misuse: markup and replacement patterns in the data are printed as text', () => {
    const out = String(
      planCards([{ name: '<b>Pro</b>', price: '$1', period: '$& " onload="x', blurb: 'A & B', includes: ['<li>$\`</li>'] }]),
    );
    expect(out).toContain('&lt;b&gt;Pro&lt;/b&gt;');
    expect(out).toContain('<span class="amount">$1</span> $&amp; ');
    expect(out).toContain('A &amp; B');
    expect(out).toContain('<li>&lt;li&gt;$\`&lt;/li&gt;</li>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('data-featured="false"');
  });

  it('misuse: a plan with nothing in its list still prints, with an empty list', () => {
    const out = String(planCards([{ name: 'Bare', price: '$0', period: 'forever', blurb: 'Nothing.', includes: [] }]));
    expect(out).toContain('Choose Bare');
    expect(out).not.toContain('<li>');
  });

  it('misuse: an empty list fails the build and says what to do', () => {
    expect(() => planCards([])).toThrow(/plans\\.ts has no plans.*remove <pricing-plans \\/>/);
  });
});
`;

/** `src/components/reader-quotes/quotes.ts` */
export const QUOTES_TS = `// The testimonials <reader-quotes> shows. The component prints one figure per
// entry at build time. Write the words without quotation marks: CSS adds them.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Quote {
  /** What the reader said. */
  words: string;
  /** Who said it. */
  name: string;
  /** A few words about the reader, shown under the name. */
  about: string;
}

export const quotes: readonly Quote[] = [
  {
    words:
      "I had stopped finishing books. Four boxes in, I have finished four.",
    name: "Odalys Brenner",
    about: "Reads on the 7:40 train",
  },
  {
    words:
      "The letter is the best part. It is like a friend pressing a book into your hands.",
    name: "Tobias Ekwueme",
    about: "Has kept every letter",
  },
  {
    words:
      "Our whole book club switched over. We argue less about what to read and more about the book.",
    name: "Marguerite Solano",
    about: "Runs a book club of nine",
  },
];

/** One figure per quote. html escapes every value, so the data is always printed as text. */
export function quoteFigures(items: readonly Quote[]): SafeHtml {
  if (items.length === 0) {
    throw new Error(
      "reader-quotes: quotes.ts has no quotes. Add one, or remove <reader-quotes /> from src/pages/index.html.",
    );
  }
  return html\`\${items.map(
    (quote) =>
      html\`<figure class="quote">
        <blockquote class="words"><p>\${quote.words}</p></blockquote>
        <figcaption class="reader">
          <span class="name">\${quote.name}</span> \${quote.about}
        </figcaption>
      </figure>\`,
  )}\`;
}
`;

/** `src/components/reader-quotes/reader-quotes.html` */
export const READER_QUOTES_HTML = `<!-- @bascik
The testimonials section: a heading and one figure per entry in quotes.ts, printed at build time. Each quote is a <blockquote> with the reader named in the <figcaption>.
-->
<style>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 20px;
}

.quote {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0;
  padding: 24px;
  background: var(--surface) var(--panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: var(--sheen), var(--shadow);
}
.words { margin: 0; flex: 1; }
.words p { margin: 0; color: var(--text); }
.words p::before { content: "\\201C"; }
.words p::after  { content: "\\201D"; }
.reader { font-size: 0.88rem; color: var(--text-muted); }
.name { display: block; color: var(--text); font-weight: 600; }
</style>
<section class="section" data-testid="reader-quotes">
  <div class="container">
    <section-head
      data-bascik-prop-label="Readers"
      data-bascik-prop-title="What early readers say"
      data-bascik-prop-text="Forty readers tried the box over the winter. Here is what three of them wrote back."
    />
    <div class="grid">
      <script data-bascik-build-once type="text/typescript">
        import { quoteFigures, quotes } from "./quotes.ts";
        export default () => quoteFigures(quotes);
      </script>
    </div>
  </div>
</section>
`;

/** `src/components/reader-quotes/reader-quotes.test.ts` */
export const READER_QUOTES_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { quoteFigures, quotes } from './quotes.ts';

describe('reader-quotes component', () => {
  const path = join(process.cwd(), 'src/components/reader-quotes/reader-quotes.html');

  it('is a section with a heading that prints its quotes from quotes.ts at build time', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<section class="section" data-testid="reader-quotes">');
    expect(html).toContain('<section-head');
    expect(html).toContain('from "./quotes.ts"');
  });

  it('prints each quote as a figure with a blockquote and a caption naming the reader', () => {
    const out = String(quoteFigures(quotes));
    expect(out.match(/<figure class="quote">/g)).toHaveLength(quotes.length);
    expect(out.match(/<blockquote/g)).toHaveLength(quotes.length);
    expect(out.match(/<figcaption/g)).toHaveLength(quotes.length);
    expect(out).toContain(quotes[0].name);
  });

  it('misuse: markup and replacement patterns in the data are printed as text', () => {
    const out = String(quoteFigures([{ words: '</blockquote><script>$&</script>', name: 'A & B <x>', about: '$1 "club"' }]));
    expect(out).toContain('&lt;/blockquote&gt;&lt;script&gt;$&amp;&lt;/script&gt;');
    expect(out).toContain('A &amp; B &lt;x&gt;');
    expect(out).toContain('$1 ');
    expect(out.match(/<\\/blockquote>/g)).toHaveLength(1);
    expect(out).not.toContain('<script>');
  });

  it('misuse: an empty list fails the build and says what to do', () => {
    expect(() => quoteFigures([])).toThrow(/quotes\\.ts has no quotes.*remove <reader-quotes \\/>/);
  });
});
`;

/** `src/components/section-head/section-head.html` */
export const SECTION_HEAD_HTML = `<!-- @bascik
The heading group that opens each section of the home page: a short label, the section's heading, and one line of introduction.
@prop label - A word or two above the heading, such as "Pricing"
@prop title - The section's heading
@prop text - One sentence under the heading
-->
<style>
hgroup { max-width: 640px; margin-bottom: 32px; }
.text { font-size: 1.05rem; margin-bottom: 0; }
</style>
<hgroup data-testid="section-head">
  <p class="section-label" data-bascik-prop-label>Section</p>
  <h2 data-bascik-prop-title>Section heading</h2>
  <p class="text" data-bascik-prop-text></p>
</hgroup>
`;

/** `src/components/section-head/section-head.test.ts` */
export const SECTION_HEAD_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('section-head component', () => {
  const path = join(process.cwd(), 'src/components/section-head/section-head.html');

  it('groups a label, an h2, and an intro, each filled by a prop', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<hgroup data-testid="section-head">');
    expect(html).toContain('data-bascik-prop-label');
    expect(html).toMatch(/<h2 data-bascik-prop-title>/);
    expect(html).toContain('data-bascik-prop-text');
  });
});
`;

/** `src/components/site-footer/site-footer.html` */
export const SITE_FOOTER_HTML = `<!-- @bascik
The footer: the copyright line from src/lib/site.ts, with the year of the build, and the links that do not belong in the header.
-->
<style>
${SITE_FOOTER_CSS}</style>
<footer data-testid="site-footer">
  <div class="container">
    <div class="inner">
      <span class="copy">
        <script data-bascik-build-once type="text/typescript">
          import { copyright } from "@/lib/site.ts";
          export default () => copyright();
        </script>
      </span>
      <nav aria-label="Footer" data-testid="site-footer-nav">
        <a href="/" data-testid="site-footer-home">Home</a>
        <a href="/privacy" data-testid="site-footer-privacy">Privacy</a>
      </nav>
    </div>
  </div>
</footer>
`;

/** `src/components/site-footer/site-footer.test.ts` */
export const SITE_FOOTER_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-footer component', () => {
  const path = join(process.cwd(), 'src/components/site-footer/site-footer.html');

  it('prints the copyright line once per build and links to the privacy page', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('data-bascik-build-once');
    expect(html).toContain('import { copyright } from "@/lib/site.ts"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('data-testid="site-footer"');
  });
});
`;

/** `src/components/site-head/site-head.html` */
export const SITE_HEAD_HTML = `<!-- @bascik
The head tags every page shares: charset, viewport, icons, and the global stylesheet. Put it first in <head>. Each page then writes its own title, description, and social tags with seo() from src/lib/seo.ts.
-->
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#e9edf3" />
<meta name="theme-color" content="#11151c" media="(prefers-color-scheme: dark)" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png" />
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
<link rel="stylesheet" href="/css/styles.css" />
`;

/** `src/components/site-head/site-head.test.ts` */
export const SITE_HEAD_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-head component', () => {
  const path = join(process.cwd(), 'src/components/site-head/site-head.html');

  it('contains charset, viewport, favicon, and stylesheet link tags', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('favicon.ico');
    expect(html).toContain('favicon-32x32.png');
    expect(html).toContain('favicon.svg');
    expect(html).toContain('apple-touch-icon.png');
    expect(html).toContain('styles.css');
  });

  it('leaves the title and description to each page, so no two pages share them', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).not.toContain('<title');
    expect(html).not.toContain('name="description"');
  });
});
`;

/** `src/components/site-header/site-header.html` */
export const SITE_HEADER_HTML = `<!-- @bascik
The sticky header: a skip link, the site name from src/lib/site.ts, and links to the home page's sections. Each link names an id that src/pages/index.html puts on a section tag, so add or rename the two together. Every page needs <main id="main"> for the skip link.
-->
<style>
${SITE_HEADER_CSS}
/* The global stylesheet underlines links in lists; a menu needs no underline. */
.menu a { text-decoration: none; }

/* The last link is the page's call to action. */
.menu .cta { color: var(--accent); font-weight: 600; }

/* Without JavaScript the toggle stays hidden and the menu stays open: at phone
   width it wraps under the logo instead of dropping down. The script below
   removes "static" and shows the toggle. */
.toggle[hidden] { display: none; }

@media (max-width: 640px) {
  nav { height: auto; min-height: 60px; flex-wrap: wrap; row-gap: 0; }

  .menu.static {
    display: flex;
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    width: 100%;
    margin: 0;
    padding: 0 0 8px;
    border: 0;
    background: none;
  }
  .menu.static li { width: auto; }
  .menu.static a { padding: 6px 10px 6px 0; }
}
</style>
<header data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>
  <div class="container">
    <nav aria-label="Main" data-testid="site-header-nav">
      <a href="/" class="logo" data-testid="site-header-logo">
        <script data-bascik-build-once type="text/typescript">
          import { siteName } from "@/lib/site.ts";
          export default siteName;
        </script>
      </a>
      <button id="nav-toggle" type="button" class="toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="site-header-nav-toggle" hidden>
        <span></span><span></span><span></span>
      </button>
      <ul id="nav-menu" class="menu static" data-testid="site-header-nav-menu">
        <li><a href="/#features" data-testid="site-header-features">Features</a></li>
        <li><a href="/#how-it-works" data-testid="site-header-how-it-works">How it works</a></li>
        <li><a href="/#pricing" data-testid="site-header-pricing">Pricing</a></li>
        <li><a href="/#faq" data-testid="site-header-faq">FAQ</a></li>
        <li><a href="/#signup" class="cta" data-testid="site-header-signup">Join the waitlist</a></li>
      </ul>
    </nav>
  </div>
</header>
<script type="text/typescript">
  const toggle = document.getElementById('nav-toggle') as HTMLButtonElement;
  const menu = document.getElementById('nav-menu') as HTMLUListElement;

  // One function applies the state to the page.
  const setOpen = (open: boolean): void => {
    toggle.setAttribute('aria-expanded', String(open));
    menu.classList.toggle('is-open', open);
  };

  // The script is running, so the menu can collapse behind the toggle at phone width.
  menu.classList.remove('static');
  toggle.hidden = false;
  setOpen(false);

  toggle.addEventListener('click', (): void => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });
  // A link to a section of this page does not load a new page, so close the menu on the way there.
  menu.addEventListener('click', (event: MouseEvent): void => {
    if (event.target instanceof HTMLAnchorElement) setOpen(false);
  });
</script>
`;

/** `src/components/site-header/site-header.test.ts` */
export const SITE_HEADER_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('site-header component', () => {
  const path = join(process.cwd(), 'src/components/site-header/site-header.html');
  const homePath = join(process.cwd(), 'src/pages/index.html');

  it('starts with the skip link and reads the site name from src/lib/site.ts', async () => {
    const html = await readFile(path, 'utf8');
    const header = html.slice(html.indexOf('<header'));
    expect(header.indexOf('href="#main"')).toBeLessThan(header.indexOf('<nav'));
    expect(html).toContain('import { siteName } from "@/lib/site.ts"');
    expect(html).toContain('id="nav-toggle"');
  });

  it('links only to sections the home page has', async () => {
    const html = await readFile(path, 'utf8');
    const home = await readFile(homePath, 'utf8');
    const targets = [...html.matchAll(/href="\\/#([^"]+)"/g)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const id of targets) expect(home, \`no section has id="\${id}"\`).toContain(\` id="\${id}"\`);
  });

  it('keeps the menu open until its script runs, so the links work without JavaScript', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toMatch(/<button[^>]*id="nav-toggle"[^>]*\\shidden>/);
    expect(html).toContain('class="menu static"');
    expect(html).toContain("menu.classList.remove('static')");
  });
});
`;

/** What the form's script does with a sign-up when nothing receives it: the starter without an adapter. */
export const WAITLIST_SEND_STATIC = `  const DONE = 'You are on the list. This starter form does not send anything yet.';

  /**
   * Sends the sign-up. Nothing receives it yet: post the form to your own
   * endpoint here, and return what it says is wrong with the fields, or ''.
   */
  const send = async (): Promise<string> => '';`;

/** What the form's script does with a sign-up when an adapter serves `src/api/waitlist.ts`. */
export const WAITLIST_SEND_API = `  const DONE = 'You are on the list.';

  /**
   * Sends the sign-up as JSON to src/api/waitlist.ts, which checks the fields
   * again: the checks above are a convenience, the server's are the rule.
   * Returns what the server says is wrong with the fields, or ''.
   */
  const send = async (): Promise<string> => {
    const response = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    if (response.status === 422) {
      const { errors } = (await response.json()) as { errors: string[] };
      return errors.join(' ');
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return '';
  };`;

/** `src/components/waitlist-signup/waitlist-signup.html`, around one of the two `send` functions above. */
export const waitlistSignupHtml = (send: string): string =>
  `<!-- @bascik
The sign-up section: a heading and the waitlist form. Its script checks the email address before sending and shows one message under the fields; without the script the browser's own validation still runs. Field names ship as written, so the form sends the keys email and name.
-->
<style>
.form { max-width: 520px; }

.field { margin-bottom: 20px; }
.field label {
  display: block;
  margin-bottom: 6px;
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);
}
.optional { font-weight: 400; color: var(--text-muted); }
.field input {
  width: 100%;
  padding: 10px 14px;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text);
  font-family: inherit;
  font-size: 1rem;
}
.field input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.field input[aria-invalid="true"] { border-color: var(--error); }

.error  { margin: 0 0 16px; color: var(--error); }
.status { margin: 16px 0 0; color: var(--accent); }
.status:empty { display: none; }
</style>
<section class="section" data-testid="waitlist-signup">
  <div class="container">
    <section-head
      data-bascik-prop-label="Waitlist"
      data-bascik-prop-title="Be first in line for the first box"
      data-bascik-prop-text="Boxes start shipping this spring. Leave your email and we will write once, when sign-ups open."
    />
    <form id="form" class="form" data-testid="waitlist-signup-form">
      <div class="field">
        <label for="email">Email address</label>
        <input type="email" id="email" name="email" autocomplete="email" required aria-describedby="problem" data-testid="waitlist-signup-email" />
      </div>
      <div class="field">
        <label for="name">First name <span class="optional">(optional)</span></label>
        <input type="text" id="name" name="name" autocomplete="given-name" maxlength="80" data-testid="waitlist-signup-name" />
      </div>
      <p id="problem" class="error" role="alert" data-testid="waitlist-signup-error" hidden></p>
      <button id="submit" type="submit" class="btn btn-primary" data-testid="waitlist-signup-submit">Join the waitlist</button>
      <p id="status" class="status" role="status" data-testid="waitlist-signup-status"></p>
      <noscript><p class="status">This form needs JavaScript to send.</p></noscript>
    </form>
  </div>
</section>
<script type="text/typescript">
  const form = document.getElementById('form') as HTMLFormElement;
  const email = document.getElementById('email') as HTMLInputElement;
  const submit = document.getElementById('submit') as HTMLButtonElement;
  const problem = document.getElementById('problem') as HTMLParagraphElement;
  const status = document.getElementById('status') as HTMLParagraphElement;

  // This script shows its own message, so the browser's validation bubbles are turned off.
  form.noValidate = true;

  /** What is wrong with the email address, or '' when nothing is. */
  const emailProblem = (): string => {
    if (email.validity.valueMissing) return 'Enter your email address.';
    if (email.validity.typeMismatch) return 'Enter an email address like reader@example.com.';
    return '';
  };

  /** Shows the message, or clears it when there is none. Returns whether there was one. */
  const showProblem = (message: string): boolean => {
    problem.textContent = message;
    problem.hidden = message === '';
    email.setAttribute('aria-invalid', String(message !== ''));
    return message !== '';
  };

${send}

  form.addEventListener('submit', async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    status.textContent = '';
    if (showProblem(emailProblem())) {
      email.focus();
      return;
    }
    submit.disabled = true;
    try {
      if (showProblem(await send())) return;
      form.reset();
      status.textContent = DONE;
    } catch {
      status.textContent = 'Sorry, that did not go through. Please try again.';
    } finally {
      submit.disabled = false;
    }
  });

  // Once a message is showing, keep it current while the reader fixes the address.
  email.addEventListener('input', (): void => {
    if (!problem.hidden) showProblem(emailProblem());
  });
</script>
`;

/** `src/components/waitlist-signup/waitlist-signup.test.ts` */
export const WAITLIST_SIGNUP_TEST_TS = `import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('waitlist-signup component', () => {
  const path = join(process.cwd(), 'src/components/waitlist-signup/waitlist-signup.html');

  it('is a section with a heading and a form whose every control has a label', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<section class="section" data-testid="waitlist-signup">');
    expect(html).toContain('<section-head');
    for (const id of ['email', 'name']) {
      expect(html).toContain(\`<label for="\${id}">\`);
      expect(html).toContain(\`id="\${id}" name="\${id}"\`);
    }
    expect(html).toContain('data-testid="waitlist-signup-submit"');
  });

  it('requires an email address in the markup, so the browser checks it when the script does not run', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toMatch(/<input type="email"[^>]*\\srequired\\s/);
    expect(html).not.toMatch(/<form[^>]*novalidate/);
  });

  it('checks the address in a TypeScript script and reports problems in an alert tied to the field', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).toContain('<script type="text/typescript">');
    expect(html).toContain('preventDefault');
    expect(html).toContain('validity.valueMissing');
    expect(html).toContain('validity.typeMismatch');
    expect(html).toContain('aria-describedby="problem"');
    expect(html).toMatch(/<p id="problem"[^>]*role="alert"[^>]*hidden>/);
  });

  it('has no form action: the script sends the form, so no build posts to a route that is not there', async () => {
    const html = await readFile(path, 'utf8');
    expect(html).not.toMatch(/<form[^>]*\\saction=/);
  });
});
`;
