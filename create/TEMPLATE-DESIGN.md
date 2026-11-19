# Template Design System

This is the contributor contract for `create-bascik` templates, including the default starter and its adapter variants. It records the approved reports-template direction so subsequent work does not repeat the rejected designs. Read it before changing `src/scaffold.ts` or `src/templates/`.

The visual reference is [ClyHealth by Fuselab](https://fuselabcreative.com/our-projects/clyhealth-dashboard-design/): restrained color, clear hierarchy, and depth between surfaces, not a copy of its assets or layout. Each template keeps its own content, information architecture, and purpose.

## Principles

- Semantic HTML and CSS first. Keep native links, buttons, forms, tables, figures, and disclosure elements. JavaScript progressively enhances behavior that HTML and CSS cannot provide.
- Pages read like a list of purposeful components. Do not replace them with a page-sized wrapper or create tiny components solely for decoration.
- A plain canvas supports raised content surfaces and, where useful, a subtly recessed chart or input area. Depth belongs to the container, not every piece of its contents.
- Use restrained highlights and soft, layered shadows. Avoid flat outlines as the only separation, but also avoid heavy bevels, shiny extruded controls, glass everywhere, and excessive nesting.
- Retain the template's character. A minimal starter remains minimal; a blog remains readable long-form content; a shop keeps useful product imagery; dashboards remain dense enough to scan.
- Preserve existing routes, forms, data, keyboard behavior, test hooks, and no-JavaScript fallbacks.

## Palette and Tokens

Use semantic custom properties on the global `:root`, with light and dark values supplied through `light-dark()`. Declare `color-scheme: light dark`. A template may retain its established token names, but equivalent roles must have equivalent treatment.

| Role                | Light     | Dark      |
| ------------------- | --------- | --------- |
| Canvas              | `#e9edf3` | `#11151c` |
| Surface             | `#f8fafd` | `#222833` |
| Highlighted surface | `#ffffff` | `#363e4c` |
| Subtle surface      | `#f0f3f8` | `#282f3b` |
| Main text           | `#293247` | `#edf0f7` |
| Secondary text      | `#616c80` | `#b3bbcb` |
| Border              | `#d6deea` | `#404957` |
| Link/accent         | `#475cbd` | `#b1bfff` |
| Subtle accent wash  | `#edf0fc` | `#30394f` |
| Text on accent      | `#ffffff` | `#202b4a` |

These are starting values, not permission to reduce contrast. Verify text and controls against their actual backgrounds in both themes. Brand assets and content imagery need not be recolored.

Use one neutral treatment for dark metric cards. Do not put differently colored boxes on a gradient page background. Light-mode metric cards may use very faint mint, pink, blue, or lavender tints.

## Surfaces and Spacing

- Main content width: approximately `1140px` to `1280px`, with fluid gutters. Keep prose narrower, around `65ch` to `76ch`.
- Use a small spacing scale, usually `4`, `8`, `12`, `16`, `20`, `24`, `32`, `48`, and `72` pixels. Dense dashboard elements use the smaller steps; marketing sections use the larger ones.
- Main card radius: around `20px` to `22px`. Nested surfaces: `12px` to `16px`. Controls: `8px` to `10px`. Avoid rounding every object into a pill.
- Combine an opaque surface color with a restrained surface gradient, a thin border, an inset top highlight, and a soft multi-layer shadow. Do not replace shadows with a hard dark outline.
- If a gradient is removed on hover, retain an opaque base color throughout the transition. A transparent-black starting color produced the rejected button flash.
- Optional gradient interpolation uses `in oklab` behind `@supports`, with a valid gradient preamble remaining in the fallback.
- Reduce card padding on phones. Do not retain desktop chart minimum heights when they create empty mobile panels.

## Typography

Use the system sans-serif stack rather than downloading a decorative font. Favor clear weights around `500` to `650`, restrained heading tracking, and fluid heading sizes. Avoid both oversized editorial headlines everywhere and the old dense, generic admin-panel treatment.

Numbers use `font-variant-numeric: tabular-nums`. Give primary metrics clear prominence without clipping long values. Secondary text remains readable, not merely low-opacity.

## Charts and Tables

- Use build-time inline SVG plus a real, captioned data table. Every figure has a useful caption, and values are available without color or JavaScript.
- Bars are flat, solid, muted colors. No bevel, bright edge stroke, gloss band, gradient fill, or drop shadow on the bars themselves. Selection may add a clear outline.
- Color is supplemental. Write values and labels, preserve a meaningful reading order, and keep print output readable in monochrome.
- Avoid duplicate visible chart/table titles; a table caption may be visually hidden on screen while remaining accessible, then restored for print.
- Use actual table headers and cells. Long tables may scroll in their own labeled, keyboard-reachable region without making the whole page overflow.
- Table period links are plain text links, not padded button-shaped pills.
- In the reports chart explorer, the whole data row is an inspection target, not a navigation link. Its native overlay button preserves keyboard/touch access, and period links remain above it and still navigate. Do not nest controls or silently change row inspection into navigation.

## Interaction

- Links navigate; buttons perform actions. Do not simulate either with clickable generic elements.
- Make the intended hit area usable, rather than requiring a click on a small text fragment. Preserve visible focus, native activation, and existing independent links.
- Use CSS for hover, focus, selected, and expanded states when possible. Keep enhancements local to each component instance.
- Respect `prefers-reduced-motion`. Keep optional transitions short, around `150ms` to `200ms`, and avoid unnecessary motion, blanket opacity fades, or `transition: all`.
- Hover and keyboard feedback must be visible in both themes. Do not remove focus outlines without an equally visible replacement.

## Verification

Before calling a template finished:

1. Consult the installed Modern Web Guidance skill for the actual UI patterns being changed. Check browser support and Bascik scoping separately.
2. Run the template's focused source tests and the create workspace typecheck. Format touched files before final validation.
3. Scaffold or materialize a real site, build it with the local compiler, and run `bascik --check`. Inspect compiled output, not only template strings.
4. Inspect representative pages at desktop, tablet, and narrow-phone widths, in light and dark mode. Check actual text wrapping, navigation, focus, overflow, and control contrast.
5. Exercise the template's existing interactions with browser tests. Where appropriate, verify no-JavaScript and print output.
6. Test regressions where they happen: sample hover transition frames for flashes, test the full row hit area, and inspect production output with identifier minification enabled.
7. Keep optional CSS markup diagnostics development-only and global. They supplement semantic validation, accessibility checks, and browser tests rather than replacing them.

Apply changes on each template's own branch. Keep shared foundation changes separate from template-specific changes so siblings do not acquire one another's features. Do not overwrite unrelated work or add runtime dependencies for styling.
