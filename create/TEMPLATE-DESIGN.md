# Template Design Contract

This is the visual contract for the templates shipped by `create-bascik`. Read it before changing `src/scaffold.ts` or `src/templates/`. The templates share accessible foundations, not one visual skin. Each should look designed for its job rather than like a recolored admin theme.

Use the repository-only [UI guidance](../.github/skills/bascik-ui/SKILL.md) to set the visual direction and [UX guidance](../.github/skills/bascik-ux/SKILL.md) to review interactions. These internal skills are not installed in generated sites.

## Shared principles

- Use semantic HTML and CSS first. Keep native links, buttons, forms, tables, figures, and disclosure elements. Add JavaScript only where HTML and CSS do not provide the needed behavior.
- Pages read like a list of purposeful component tags. Keep components at a useful size, and do not pass props through components that do not use them.
- Set global tokens in `src/pages/css/styles.css`; read them from components. Do not copy a single palette into every template or declare private `:root` tokens in component styles.
- Give each template its own typography, palette, rhythm, and surface treatment. Share accessible behavior, not a generic card-and-gradient aesthetic.
- Prefer quiet, layered contrast and intentional whitespace over repeated bordered cards, gratuitous gradients, glass, gloss, bevels, pills, or Bootstrap-like grids.
- Preserve routes, form behavior, data, keyboard access, test hooks, and useful no-JavaScript fallbacks.
- Use data that is clearly illustrative. Do not attribute fictional work, products, quotes, or books to real people or companies.
- Use plain template slug names, including `shop`, `reports`, and `dashboard`.
- Use an accessible SVG-only light/dark control with an `aria-label`, no visible button text, and saved preference initialization before paint. At phone width the control is the labeled last row of the menu instead (see "Phone-width navigation"). Preserve the canonical Bascik favicon, not a recolored version.
- A `<select>` stays a native element and draws its own arrow: `appearance: none`, about `3rem` of right padding, an inline SVG chevron as `background-image` at `right 1rem center` with `background-size: 1rem`, and `text-overflow: ellipsis`, with `min-width: 0` when its parent is a flex or grid item so a long option truncates. The browser's arrow ignores padding and sits against the border. Keep the chevron in a `--select-chevron` token in `styles.css`, stroked in the template's text color, with one value per theme because a data URI cannot read a custom property or `light-dark()`.
- Inline `src/pages/css/styles.css` with Bascik's `assets.inlineStyles` and omit its stylesheet link. Navigation has no resting underline; keep prose links identifiable.

## Phone-width navigation

Every template uses the Bascik docs site's phone navigation, unchanged from one template to the next. Do not redesign it per template; a template only supplies its own colors, type, and breakpoint.

- The header bar holds the brand at the left and one menu button at the far top right. A template with search puts an icon-only magnifying glass immediately left of the menu button.
- The menu button is a 44px target holding `<span class="toggle-icon"></span>`: three bars that become a cross while the menu is open. Animate it with `translate` and `rotate`, only when motion is allowed.
- State lives in the button's `aria-expanded`, which the CSS reads. Do not add an open class or a `data-state` for the phone menu.
- The open menu covers the screen below the header bar and scrolls on its own; the page behind it does not scroll. It lists the links one per row, then a rule, then the theme switch as the last row.
- The theme switch in the menu is a full-width row with a sun or moon icon and the name of the theme it switches to (`Light` or `Dark`). The icon-only theme button in the bar is not displayed at phone width. Both call the same code and stay in sync.
- Escape closes the menu and returns focus to the menu button. Leaving phone width closes it.
- Without JavaScript there is no menu button or theme switch, and the links stay visible as ordinary links.
- A template whose links live in a sidebar component (docs, dashboard) prints the same links into the header's menu at build time and does not display the sidebar at phone width once its script has run.

## Template directions

| Template  | Visual direction                                                                                        | Emphasis                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Default   | Warm paper, ink, and moss                                                                               | A calm, current starting point that demonstrates Bascik without looking like a product landing page                              |
| Docs      | The Bascik docs site: restrained neutrals, crisp navigation, readable code, and a compact search dialog | Search, current-page sidebar state, scroll-aware table of contents, keyboard navigation                                          |
| Landing   | Product-led SaaS, with Apple-like restraint rather than copied assets                                   | Oversized headline, focused value proposition, a convincing product preview, and generous space                                  |
| Shop      | Purposeful performance retail                                                                           | Product-specific illustrations, strong product information, useful filters, and clear price and cart actions                     |
| Portfolio | Expressive creator portfolio                                                                            | Large project imagery, editorial typography, asymmetry, and the creator's work before the chrome                                 |
| Blog      | Author-led editorial publication                                                                        | A responsive author sidebar beside an unboxed reading column, plain slug brand, calm canvas, and rule-led post entries           |
| Corporate | Mature institutional identity                                                                           | Trustworthy typography, restrained navy/stone/copper, and quiet authority while preserving the existing information architecture |
| Dashboard | Focused operator workspace                                                                              | Dense but legible data, neutral surfaces, one accent, clear hierarchy, and no playful rainbow cards                              |
| Reports   | Editorial analytics                                                                                     | A strong narrative hierarchy, accessible data tables, restrained chart color, and a single neutral card treatment in dark mode   |

These are different design systems, not a checklist to force onto every branch. Mimic.style references and the Bascik docs site inform the direction; they are inspiration, not layouts or assets to reproduce.

## Motion and interaction

- Never animate above-fold content on initial load, including root view-transition snapshots. Initial content is immediately opaque and static. User-triggered entrances may start at `scale: 0.97` with `opacity: 0`, never zero scale. Keep triggered and appropriate below-fold motion brief and opt out under `prefers-reduced-motion: reduce`.
- Pressable buttons use `button:active { scale: 0.97; }` with `transition: scale 150ms ease-out`. Apply the same behavior to button-styled links when appropriate.
- A rejected password shakes horizontally through `0, -10, 10, -6, 6, -3, 0px` over 360ms and also changes to an error state.
- Steppers slide the next step from the direction of travel instead of crossfading.
- For intrinsic-size accordions, progressively enhance with `@supports (interpolate-size: allow-keywords)` and `:root { interpolate-size: allow-keywords; }`. Keep the disclosure useful when interpolation is unsupported.
- Animate movement with `transform` or individual transform properties, never `top` or `left`.
- During theme changes, add `.theme-switching` to the root and apply `.theme-switching * { transition: none !important; }` for the change.
- Delay only the first tooltip; show subsequent tooltips immediately while one is already open.
- Drag and flick interactions hand their release velocity to a spring rather than snapping with a fixed-duration transition. Carousels resist pulls past either end, then spring back.
- Do not add motion just to satisfy a rule. Respect reduced motion, avoid flashes, and provide pause controls for persistent automatically moving content.

## Default-template feedback

- Keep warm paper, ink, and moss styling. Use the project slug consistently and greet the visitor with `Welcome to <name>` rather than a landing-page slogan.
- Provide an icon-only 44px theme control with an accessible name, pressed state, pre-paint restoration of both saved themes, and a useful system-color fallback.
- Inline global CSS with `assets.inlineStyles: ["src/pages/css/styles.css"]`; compiled pages must have no stylesheet link or request for this file.
- Keep the canonical Bascik favicon geometry and colors. Navigation links have deliberate resting styles without list-link underlines.
- The two counter instances demonstrate ID, script, and CSS scoping. Initialize `data-value="0"` and reflect `String(count)` in `data-value` on every update. CSS alone monitors the raw numeric string through `.value[data-value^='-']` to make negatives red; zero and positive values retain the neutral accent color. Do not classify the sign in JavaScript or assign styling classes, semantic sign state, or colors.
- Fresh production browser tests cover computed initial animation names, icon-only text, persistence, CSS requests, both themes, narrow layouts, and independent counters on port 9411.
- Browser configs export dynamic verification paths. Keep generated sources, builds, and browser output in `mkdtemp` directories under the OS `tmpdir`, never packaged `create/dist/`; remove fixtures on setup failure, validation failure, and Playwright teardown.
- Integration fixtures must resolve the generated config's `@bascik/bascik` import through local workspace dependency links, using junctions on Windows and directory symlinks elsewhere. Plain builds must not silently install adapters; negative controls must fail for their injected error, not missing dependencies.
- The public visual-design URL returned HTTP 404 during this work. Repository-only UI/UX guidance is the reference until that page is available.

## Blog-template behavior

- Use the project slug as a plain text brand. Keep the canonical Bascik favicon assets unchanged.
- Place author identity and navigation in an editorial sidebar beside the article on desktop, stacked above it at 900px and below. Navigation stays visible without JavaScript and has no default underline; prose links retain their underline.
- Use an icon-only light/dark toggle with a stable accessible name, `aria-pressed`, visible focus, and a 44px target. Hide it without JavaScript. Apply saved theme state in the head before paint, tolerate unavailable storage, and retain CSS press feedback and reduced-motion behavior.
- Inline `src/pages/css/styles.css` and `src/pages/css/blog.css` through `assets.inlineStyles`, with no duplicate stylesheet links in the head. Never hide above-the-fold content for an entrance.
- Include author bio/context with each article. The starter's John Doe byline is explicitly a placeholder, and sample racing guides are illustrative, not invented biographies, endorsements, or reports of actual track tests. Real reporting requires factual sources.
- Verify a fresh scaffold with the local production compiler, both themes at desktop and phone widths, keyboard navigation, saved theme reload, first-paint visibility, and JavaScript disabled.

## Landing-template details

- Keep source and browser verification fixtures in `mkdtemp` directories under the OS `tmpdir`, with cleanup on setup failure, validation failure, and Playwright teardown. The browser config exports dynamic paths and uses port 9412; never retain generated projects in packaged `create/dist/` or repository `test-results/`.

- Retain the landing-specific editorial layout, workspace preview, and blue-accent light/dark tokens. Do not replace them with another template's styling.
- Use the project slug as the brand through `src/lib/site.ts`, including the preview and product questions. Keep illustrative project data separate from the brand.
- Provide a 44px icon-only theme button with an accessible name, pressed state, keyboard activation, and saved light/dark preference. Apply the preference in the head before paint; fall back to the system scheme when storage is unavailable. Hide the button without JavaScript.
- Inline the global stylesheet with Bascik's `assets.inlineStyles: ["src/pages/css/styles.css"]` and omit the redundant stylesheet link. Keep menu links deliberately styled without default list-link underlines.
- Ship the canonical Bascik SVG, ICO, PNG favicon, and touch icon bytes with their original geometry and colors, not a landing-palette recoloring. Leave other templates unchanged.
- Warning: the design skills' reference URL, `https://bascik.dev/how-to/visual-design`, currently returns 404. Use the local UI/UX guidance and this contract without claiming the unavailable page was verified.

## Portfolio contract

- Use an inset editorial masthead with a typographic slug signature, a small practice/index label, and numbered section links. Do not reuse the generic full-width sticky navigation skin. Keep the brand plain `portfolio` when scaffolded with that slug; custom project names still come from `src/lib/site.ts`.
- Preserve the canonical shared Bascik favicon assets unchanged. Inline `src/pages/css/styles.css` through Bascik `assets.inlineStyles: true`, not a custom build step.
- Use an icon-only theme button with no visible text, the accessible name "Dark theme", and `aria-pressed` for its state. Apply saved light/dark preference in the head before paint, fall back to the system scheme, and tolerate unavailable storage.
- Keep above-fold content fully visible from first paint. No opacity gates, page flashes, or automatic entrance animation. Retain press/hover feedback and theme-transition suppression; honor reduced motion.
- Navigation links are not underlined by default. Keep visible focus, 44px controls, an Escape-dismissable mobile menu with focus returned to its toggle, and visible mobile links without JavaScript.
- Explicitly label the project collection, detail pages, and biography as samples. Do not imply fictional commissions, real-person authorship, or endorsements. Preserve real routes and the contact form's validation-only behavior.

## Docs-template behavior

- Open directly in the first Markdown guide at `/`, not a separate landing page. Keep the useful template-explaining content; the remaining guides use `/docs/<slug>`. Sidebar, search results, and pagination all link to the root for the introductory guide.
- Search is a native `<dialog>` with a visible close control, an accessible name, a build-time index, and a `Ctrl+K` / `Cmd+K` shortcut. The index searches page titles, descriptions, and headings. Results remain ordinary links.
- The table of contents links to preserved Markdown heading IDs. The highlight follows the reading position, selects the last section at the bottom, and respects a fragment when the browser cannot scroll its heading any further. Fragment links work without JavaScript.
- The sidebar marks the current page and remains usable without JavaScript. At small widths the header's menu lists the same pages and the sidebar is not displayed; the search control is an icon-only magnifying glass beside the menu button.
- Use native `<dialog>` behavior for focus, Escape, and the top layer. Do not rebuild those browser features with a custom overlay or focus trap.

## Corporate-template feedback

- Keep its institutional navy, stone, and copper palette, editorial serif headings, and bookshelf illustration. The scaffold folder slug is the brand; the verification project is named `corporate`.
- Use an icon-only light/dark button with an accessible name and pressed state. Restore the saved choice synchronously in the head and suspend transitions while changing themes.
- Initial above-the-fold content must be immediately visible and static on every route. Do not add opacity, flash, scale entrances, or cross-document view transitions. This overrides the general entrance guidance above for corporate initial content. Keep useful interaction feedback and any intentional below-fold motion, with reduced-motion alternatives.
- Keep the original Bascik favicon geometry and colors, not a copper or navy recoloring. Inline the global stylesheet through `assets.inlineStyles`, not a blocking stylesheet link or a second inline copy.
- Style navigation explicitly. The Services link and its borderless, adjacent 44px disclosure share one cohesive surface. Fine-pointer hover opens it across a transparent bridge; keyboard and touch activation work without hover. Escape dismisses the submenu and restores its button's focus without reopening it; a subsequent Escape closes mobile navigation and restores the mobile toggle.
- Warning: `https://bascik.dev/how-to/visual-design` returned HTTP 404 during feedback verification on November 19, 2026. The local UI and UX guidance was read, but the missing page is not evidence of live documentation coverage.
- Focused source regressions and fresh production Playwright checks live in `src/templates/corporate-feedback.test.ts` and `e2e/corporate-feedback.spec.ts`. Verification sources, builds, and browser output live in `mkdtemp` directories under the OS `tmpdir`, never packaged `create/dist/`. Setup failures, validation failures, and Playwright teardown remove their fixtures. The config exports its dynamic verification paths; the browser server uses only `127.0.0.1:9413` and is stopped after testing.

## Shop-template behavior

- The root `/` is the all-products catalog, not a landing page. Product URLs use `/products/<slug>`; there is no `/books/` catalog.
- A non-streamed server script reads SQLite or Cloudflare D1 and returns the sorted, filtered cards before the response starts. Native GET controls are visible and usable without JavaScript; never reorder cards on initial load.
- Reserve theme-button and cart-badge footprints before paint. Render a visible neutral `0` cart pill, not an empty or hidden badge. Product actions keep their final geometry before scripts load: disable Add to cart until ready and always show the View cart link. Critical theme/menu initialization must not depend on browser cart-module downloads. Product SVGs stay inline with explicit aspect ratios.
- The demo seed runs before builds and dev startup and is the only catalog writer. Production uses `bascik --server` or an adapter, not a plain static host. For Cloudflare, bind a dedicated D1 database as `DB` and seed it with `node scripts/seed-database.ts --sql`; never point the demo seed at an application's database.
- Use the plain slug `shop` for default branding. Keep the canonical create-template Bascik favicon files unmodified.
- Inline the global `src/pages/css/styles.css` through `assets.inlineStyles`; omit its external stylesheet link from the shop head component.
- Provide a 44 px icon-only light/dark button with an action-specific accessible label. Restore a valid saved theme in the head before paint, default to the system preference, and tolerate blocked storage.
- Navigation links have no underline at rest, with deliberate hover and visible keyboard focus treatments.
- Product detail uses a generous two-column, viewport-height desktop panel and a natural-height single column on phones. Give the product illustration meaningful space, not a thumbnail beside a short paragraph.
- Keep composition, fit/dimensions, contents/care/intended use and demo availability in the typed catalog. Label specifications, ratings and stock as illustrative; never imply real customer reviews, vehicle safety certification, live inventory or shipping. Custom entries may omit the detail fields and get explicit fallbacks.

## Reports-template behavior

- Retain SQLite/D1 request-time report rendering and the static Netlify variant.
- A navigable month table row has one real link whose pointer target fills the row. It navigates to the monthly report and never pins a chart selection.
- Clicking a chart month pins inspection; Escape clears it. Hover and keyboard focus can temporarily highlight linked chart/table data without replacing navigation.
- Keep the reports brand typographic, without a decorative square glyph.

## Dashboard feedback contract

- Keep the canonical create-template Bascik favicon byte-for-byte, including its original colors and cursor animation. It is a brand asset, not a palette token.
- Inline `src/pages/css/styles.css` with the existing `assets.inlineStyles` compiler option. Keep theme initialization in the head and pause transitions during theme switches.
- Use a 44px icon-only theme button with decorative sun/moon SVGs, a stable accessible name of "Dark theme", and `aria-pressed` for the state. Hide it without JavaScript.
- Keep main content immediately visible on every route, with reduced-motion-aware pressed feedback. Do not introduce decorative initial entrances.
- Preserve deliberate non-underlined resting brand/sidebar links, visible focus, and current-page cues.
- Use the scaffold's plain slug for header and page-title branding, with `dashboard` as the settings demo default. Keep race-car examples illustrative, with "Demo inventory" and numbered "Demo customer" labels, never invented work or orders attributed to real people.
- Run `create/src/templates/dashboard-feedback.test.ts` for red-first source and fresh-scaffold production-browser regressions on the reserved port 43932. It cleans up its scaffold and server after verification.

## Verification

1. Consult Modern Web Guidance for the actual UI pattern and check browser support separately from Bascik scoping.
2. Run focused template source tests and the `create-bascik` typecheck. Format touched files before the final test run.
3. Scaffold a real project, build it with the local compiler, run `bascik --check`, and inspect compiled output.
4. Inspect representative pages at desktop, tablet, and narrow-phone widths, in light and dark mode. Check text wrapping, navigation, focus, overflow, and contrast.
5. Exercise existing interactions in production output. Verify the page still works when optional JavaScript or newer CSS features are unavailable.
   Check actual compiled pages for no `styles.css` link or request, empty theme-button text with an SVG and accessible name, both saved themes after reload, and no fresh-load above-fold computed animations.
6. Keep shared foundation changes separate from template-specific work. Apply and verify template changes on each template's own branch; do not overwrite unrelated work or add runtime dependencies for styling.
