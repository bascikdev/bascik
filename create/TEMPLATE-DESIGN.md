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

## Docs-template behavior

- Search is a native `<dialog>` with a visible close control, an accessible name, a build-time index, and a `Ctrl+K` / `Cmd+K` shortcut. The index searches page titles, descriptions, and headings. Results remain ordinary links.
- The table of contents links to preserved Markdown heading IDs. `IntersectionObserver` updates the visible current link and its `aria-current`; fragment links work without JavaScript.
- The sidebar marks the current page and remains usable without JavaScript. At small widths, a labeled button progressively enhances it into a collapsible navigation.
- Use native `<dialog>` behavior for focus, Escape, and the top layer. Do not rebuild those browser features with a custom overlay or focus trap.

## Verification

1. Consult Modern Web Guidance for the actual UI pattern and check browser support separately from Bascik scoping.
2. Run focused template source tests and the `create-bascik` typecheck. Format touched files before the final test run.
3. Scaffold a real project, build it with the local compiler, run `bascik --check`, and inspect compiled output.
4. Inspect representative pages at desktop, tablet, and narrow-phone widths, in light and dark mode. Check text wrapping, navigation, focus, overflow, and contrast.
5. Exercise existing interactions in production output. Verify the page still works when optional JavaScript or newer CSS features are unavailable.
6. Keep shared foundation changes separate from template-specific work. Apply and verify template changes on each template's own branch; do not overwrite unrelated work or add runtime dependencies for styling.
