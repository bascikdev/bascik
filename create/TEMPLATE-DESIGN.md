# Template Design Contract

This is the visual contract for the templates shipped by `create-bascik`. Read it before changing `src/scaffold.ts` or `src/templates/`. The templates share accessible foundations, not one visual skin. Each should look designed for its job rather than like a recolored admin theme.

## Shared principles

Use the repository-only [UI guidance](../.github/skills/bascik-ui/SKILL.md) and [UX guidance](../.github/skills/bascik-ux/SKILL.md), not public or generated-site skills.

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
| Blog      | Contemporary editorial publication                                                                      | A readable article measure, a distinct masthead, calm page background, and deliberate spacing between posts                      |
| Corporate | Mature institutional identity                                                                           | Trustworthy typography, restrained navy/stone/copper, and quiet authority while preserving the existing information architecture |
| Dashboard | Focused operator workspace                                                                              | Dense but legible data, neutral surfaces, one accent, clear hierarchy, and no playful rainbow cards                              |
| Reports   | Editorial analytics                                                                                     | A strong narrative hierarchy, accessible data tables, restrained chart color, and a single neutral card treatment in dark mode   |

These are different design systems, not a checklist to force onto every branch. Mimic.style references and the Bascik docs site inform the direction; they are inspiration, not layouts or assets to reproduce.

## Motion and interaction

- Initial above-fold content never animates, including view transitions. For user-triggered entrances elsewhere, start at `scale: 0.97` with `opacity: 0` and opt out under `prefers-reduced-motion: reduce`.
- Pressable buttons use `button:active { scale: 0.97; }` with `transition: scale 150ms ease-out`. Apply the same behavior to button-styled links when appropriate.
- A rejected password shakes horizontally through `0, -10, 10, -6, 6, -3, 0px` over 360ms and also changes to an error state.
- Steppers slide the next step from the direction of travel instead of crossfading.
- For intrinsic-size accordions, progressively enhance with `@supports (interpolate-size: allow-keywords)` and `:root { interpolate-size: allow-keywords; }`. Keep the disclosure useful when interpolation is unsupported.
- Animate movement with `transform` or individual transform properties, never `top` or `left`.
- During theme changes, add `.theme-switching` to the root and apply `.theme-switching * { transition: none !important; }` for the change.
- Delay only the first tooltip; show subsequent tooltips immediately while one is already open.
- Drag and flick interactions hand their release velocity to a spring rather than snapping with a fixed-duration transition. Carousels resist pulls past either end, then spring back.
- Do not add motion just to satisfy a rule. Respect reduced motion, avoid flashes, and provide pause controls for persistent automatically moving content.

## Docs-template behavior

- Search is a native `<dialog>` with a visible close control, an accessible name, a build-time index, and a `Ctrl+K` / `Cmd+K` shortcut. The index searches page titles, descriptions, and headings. Results remain ordinary links.
- The table of contents links to preserved Markdown heading IDs. `IntersectionObserver` updates the visible current link and its `aria-current`; fragment links work without JavaScript.
- The sidebar marks the current page and remains usable without JavaScript. At small widths, a labeled button progressively enhances it into a collapsible navigation.
- Use native `<dialog>` behavior for focus, Escape, and the top layer. Do not rebuild those browser features with a custom overlay or focus trap.

## Corporate-template feedback

- Keep its institutional navy, stone, and copper palette, editorial serif headings, and bookshelf illustration. The scaffold folder slug is the brand; the verification project is named `corporate`.
- Use an icon-only light/dark button with an accessible name and pressed state. Restore the saved choice synchronously in the head and suspend transitions while changing themes.
- Initial above-the-fold content must be immediately visible and static on every route. Do not add opacity, flash, scale entrances, or cross-document view transitions. This overrides the general entrance guidance above for corporate initial content. Keep useful interaction feedback and any intentional below-fold motion, with reduced-motion alternatives.
- Keep the original Bascik favicon geometry and colors, not a copper or navy recoloring. Inline the global stylesheet through `assets.inlineStyles`, not a blocking stylesheet link or a second inline copy.
- Style navigation explicitly. The Services link and its borderless, adjacent 44px disclosure share one cohesive surface. Fine-pointer hover opens it across a transparent bridge; keyboard and touch activation work without hover. Escape dismisses the submenu and restores its button's focus without reopening it; a subsequent Escape closes mobile navigation and restores the mobile toggle.
- Warning: `https://bascik.dev/how-to/visual-design` returned HTTP 404 during feedback verification on November 19, 2026. The local UI and UX guidance was read, but the missing page is not evidence of live documentation coverage.
- Focused source regressions and fresh production Playwright checks live in `src/templates/corporate-feedback.test.ts` and `e2e/corporate-feedback.spec.ts`. Verification sources, builds, and browser output live in `mkdtemp` directories under the OS `tmpdir`, never packaged `create/dist/`. Setup failures, validation failures, and Playwright teardown remove their fixtures. The config exports its dynamic verification paths; the browser server uses only `127.0.0.1:9413` and is stopped after testing.

## Verification

1. Consult Modern Web Guidance for the actual UI pattern and check browser support separately from Bascik scoping.
2. Run focused template source tests and the `create-bascik` typecheck. Format touched files before the final test run.
3. Scaffold a real project, build it with the local compiler, run `bascik --check`, and inspect compiled output.
4. Inspect representative pages at desktop, tablet, and narrow-phone widths, in light and dark mode. Check text wrapping, navigation, focus, overflow, and contrast.
5. Exercise existing interactions in production output. Verify the page still works when optional JavaScript or newer CSS features are unavailable.
6. Keep shared foundation changes separate from template-specific work. Apply and verify template changes on each template's own branch; do not overwrite unrelated work or add runtime dependencies for styling.
