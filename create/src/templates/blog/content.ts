/**
 * @module templates/blog/content
 *
 * The blog template's sample posts: invented books and authors, as the house rules ask of demo data. Each is
 * written to `content/posts/<slug>.md`, and its slug is its URL.
 */

/** The sample posts, newest first, as `[slug, Markdown]`. The generated e2e spec names the same four. */
export const SAMPLE_POSTS: readonly (readonly [
  slug: string,
  markdown: string,
])[] = [
  [
    "the-second-chapter-problem",
    `---
title: The Second Chapter Problem
description: First chapters get all the attention. The second chapter is where a novel quietly decides whether you will finish it.
date: 2026-10-28
author: Maren Okafor
tags: [craft]
---

Everyone polishes a first chapter. Workshops are built around them, agents ask for them, and readers sample them in the shop. The second chapter gets none of that care, and it shows.

## What the second chapter has to do

A first chapter makes a promise. The second has to prove the promise was not a trick:

- It slows down without going slack.
- It introduces the person the first chapter only pointed at.
- It gives you one reason to trust the narrator and one reason not to.

## A test you can run

Open any novel you abandoned and find the page where you stopped. For me it is nearly always between pages 20 and 40, which is second-chapter country.

> A reader forgives a slow start. A reader does not forgive a second start.

Next time you draft, write chapter two first and see what it asks chapter one to set up.
`,
  ],
  [
    "an-afternoon-with-the-salt-road",
    `---
title: An Afternoon with The Salt Road
description: A review of Tomas Lindqvist's short novel about a ferry pilot, her brother, and the one crossing neither of them will talk about.
date: 2026-09-14
author: Idris Vale
tags: [reviews]
---

_The Salt Road_ is 148 pages long and I read it in one sitting, on a bench, getting slowly sunburned. That is the review. The rest is detail.

## What it is about

Tomas Lindqvist's fourth novel follows Runa, who pilots a small car ferry across a strait that is twelve minutes wide. Her brother returns after nine years away and takes the crossing every day for a week without once getting off on the far side.

## What works

Lindqvist writes weather better than most people write dialogue. The strait has moods, and by the third crossing you can read them as well as Runa can.

## What does not

The final chapter explains a little too much. A book this good at silence did not need to break it.

**Rating:** 4.5 out of 5. Read it somewhere you can see water.
`,
  ],
  [
    "how-nora-carrow-outlines-on-index-cards",
    `---
title: How Nora Carrow Outlines a Novel on Index Cards
description: The author of the Harbor Quartet plans each book on 60 index cards and one long table. Here is the method, step by step.
date: 2026-08-02
author: Maren Okafor
tags: [craft, authors]
---

Nora Carrow has written four novels on the same kitchen table, and each one began as a stack of 60 index cards. She walked me through the method over coffee.

## The rules

1. One card is one scene, written as a single sentence.
2. A card that needs a second sentence is two scenes.
3. Cards are laid out in three rows, and no row may be longer than the table.

## Why 60

"Fewer than 50 and I am writing a novella," she said. "More than 70 and I am hiding a second book inside the first."

## The part nobody copies

When the outline is done, Carrow removes every fifth card and puts it in a drawer. If the story still makes sense, the cards stay in the drawer.

| Book               | Cards at the start | Cards kept |
| ------------------ | ------------------ | ---------- |
| _Low Tide_         | 61                 | 49         |
| _The Harbor Clerk_ | 58                 | 47         |
`,
  ],
  [
    "five-short-novels-for-a-long-train-ride",
    `---
title: Five Short Novels for a Long Train Ride
description: Five novels under 200 pages, each one the right length for a single journey, chosen from a year of reading on trains.
date: 2026-06-19
author: Idris Vale
tags: [reading-lists]
---

A long train ride wants a short book: one you can finish before the last station, with time left to look out of the window and think about it.

## The list

1. **_The Salt Road_** by Tomas Lindqvist. A ferry, a strait, and a brother who will not get off the boat.
2. **_Low Tide_** by Nora Carrow. The first of the Harbor Quartet, and still the best place to start.
3. **_A Field Guide to Leaving_** by Odalys Brennan. Twelve chapters, each named after a bird the narrator fails to see.
4. **_The Night Proofreader_** by Kofi Adeyemi-Lund. A comedy about a typo that changes an election.
5. **_Marginalia_** by Petra Solheim. A love story told in the notes two strangers leave in a library book.

## How I chose

Each book is under 200 pages, has chapters short enough to finish between stations, and survived being read in a seat with no table.
`,
  ],
];
