/**
 * The docs template's sample guides: real instructions for making the
 * generated documentation site your own. The order and grouping live in
 * `lib.ts`.
 */

const GETTING_STARTED = `---
title: Getting started
description: Run the documentation site locally, build it, and replace the sample content.
---

This starter opens directly in documentation, with Markdown pages, generated routes, a sidebar, a table of contents, and search. This introductory guide is served at \`/\`; the remaining guides use \`/docs/<file-name>\`. Most content changes happen in \`content/docs/\`.

## Start the dev server

Install the project dependencies, then run the development script:

\`\`\`sh
npm install
npm run dev
\`\`\`

The site rebuilds when you edit a Markdown file or a watched helper in \`src/lib/\`.

## Build for production

Build a static site with a canonical URL for its metadata:

\`\`\`sh
BASCIK_SITE_URL=https://example.com npm run build
\`\`\`

### Set a site URL

For local builds, set \`BASCIK_SITE_URL\` in \`.env\`. The build uses it for canonical links and the generated sitemap.

## Make it yours

Replace the sample guides, choose their order in \`src/lib/sidebar.ts\`, and update the site name in \`src/lib/site.ts\`. Continue with [Writing pages](/docs/writing-pages) and [Navigation and search](/docs/navigation-and-search).
`;

const WRITING_PAGES = `---
title: Writing pages
description: Add Markdown guides with page metadata, useful headings, and working links.
---

Each Markdown file in \`content/docs/\` becomes one page. The first sidebar entry is the root guide at \`/\`; the remaining files use \`/docs/<file-name>\`. Use lowercase file names joined by hyphens.

## Add a page

Start with front matter containing a title and a one-sentence description:

\`\`\`md
---
title: Account setup
description: Configure an account and invite its first team member.
---

## Create an account

Write the guide here.
\`\`\`

### Choose headings

The front-matter title is the page's only \`h1\`. Begin the body at \`##\`, then use \`###\` for subsections. Heading IDs are generated from their text and listed in the table of contents.

## Add a sidebar entry

Add the file name without \`.md\` to a group in \`src/lib/sidebar.ts\`. The build reports a clear error if a page is missing from the sidebar, an entry has no file, or a page is listed twice.

## Link between pages

Use the route in an ordinary Markdown link, such as [Navigation and search](/docs/navigation-and-search). Keep links within the pages that exist in the sidebar.
`;

const NAVIGATION_AND_SEARCH = `---
title: Navigation and search
description: Help readers move through the docs with a current sidebar, table of contents, and keyboard-accessible search.
---

The navigation is generated from the page list, so readers can move between topics without losing their place.

## Sidebar

Groups and their order come from \`SIDEBAR\` in \`src/lib/sidebar.ts\`. The current page is marked with \`aria-current="page"\`. On a small screen, a button collapses the list; without JavaScript, the links remain visible.

## Search

The search index is built from page titles, descriptions, and headings. Results link directly to a page or a section, and are ordinary anchors that work with a keyboard.

### Open search

Choose **Search docs** in the header or press \`Ctrl+K\` on Windows and Linux, or \`Cmd+K\` on macOS. The native dialog provides focus handling and closes with Escape.

## Table of contents

The on-page list links to each \`##\` and \`###\` heading. As a heading enters the reading area, the corresponding link receives \`aria-current="location"\`; every fragment link still works if JavaScript is unavailable.
`;

const COMPONENTS_AND_DESIGN = `---
title: Components and design
description: Change the documentation shell and its design tokens without rewriting page content.
---

The pages are composed from components in \`src/components/\`. The shared header, sidebar, article, table of contents, and pagination each have a focused job.

## Change the shell

Edit \`site-header\` and \`site-footer\` for shared navigation and site information. Keep a skip link before the navigation and preserve the page's single \`main\` landmark.

## Adjust the visual system

The global tokens and documentation layout live in \`src/pages/css/styles.css\`. Bascik inlines this file through \`assets.inlineStyles\` in \`bascik.config.ts\`, so the compiled pages need no separate stylesheet request. Components keep their own styles beside their markup. Change the tokens first, then tune the Markdown styles under \`.prose\`. The icon-only theme control saves the reader's preference, which the head initializes before paint.

### Keep content readable

Use a narrow measure for long paragraphs, clear heading spacing, and horizontally scrollable code and tables. Check both color schemes and a narrow viewport after changing the layout.

## Add a reusable component

Use a component when a section has a clear job or markup repeats. Keep ordinary links and buttons semantic, and add \`data-testid\` hooks to the component root and interactive controls that tests need.
`;

const BUILD_AND_CHECK = `---
title: Build and check
description: Validate routes, Markdown, generated output, and browser behavior before publishing.
---

Use the project's scripts to catch content and template mistakes before deployment.

## Check structure

\`\`\`sh
npx bascik --check
npm test
\`\`\`

The docs helper validates front matter, heading levels, duplicate heading IDs, and agreement between Markdown files and the sidebar.

## Build and inspect

\`\`\`sh
BASCIK_SITE_URL=https://example.com npx bascik --build
\`\`\`

Inspect \`dist/\` to confirm that the routes, titles, code blocks, and navigation were generated as expected.

## Exercise navigation

Run the browser tests after changing the sidebar, search, or table of contents:

\`\`\`sh
npx playwright test
\`\`\`

Test keyboard operation, small-screen layout, and links to headings as well as the initial page view.
`;

const DEPLOYMENT = `---
title: Deployment
description: Publish the generated static documentation or add an adapter for request-time features.
---

The docs pages are static HTML by default. Choose a deployment path based on the capabilities the site needs.

## Publish a static site

Run \`npm run build\` with \`BASCIK_SITE_URL\` set, then deploy the generated \`dist/\` directory to your static host.

## Add a deployment adapter

Create the project with \`--adapter cloudflare\` or \`--adapter netlify\` to include the matching adapter setup. The docs pages remain static, while the starter's API route demonstrates request-time code.

## Verify the published site

Open the deployed site and check a nested docs URL directly, its canonical URL, its sitemap, and its not-found response. Confirm that search and fragment navigation work in the production build.
`;

/** The sample pages by file name without `.md`, in sidebar order. */
export const DOCS_SAMPLE_PAGES: Record<string, string> = {
  "getting-started": GETTING_STARTED,
  "writing-pages": WRITING_PAGES,
  "navigation-and-search": NAVIGATION_AND_SEARCH,
  "components-and-design": COMPONENTS_AND_DESIGN,
  "build-and-check": BUILD_AND_CHECK,
  deployment: DEPLOYMENT,
};
