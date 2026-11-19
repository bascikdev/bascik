---
name: bascik-ux
description: Design and review Bascik interaction flows, including forms, charts, tables, demo actions, feedback, motion, and keyboard and touch behavior.
---

# Bascik UX

Read [Visual Design and Interaction](https://bascik.dev/how-to/visual-design). Use `bascik-components` for native controls and `bascik-ui` for visual hierarchy.

- Start with semantic HTML and CSS. Default to real links, buttons, forms, disclosures, and dialogs. Enhance with scoped TypeScript only where native behavior stops short. Support keyboard navigation and a visible focus state.
- Make the essential action work without requiring hover. Keep loading, empty, error, and success states useful. Label simulated actions and never imply that they saved data, placed an order, or sent a message.
- For a navigable table row, keep one real link, expand its pointer target without adding duplicate tab stops, and preserve the table semantics. Give a chart a readable text or table equivalent.
- Start entrances at opacity `0` and scale `0.97`, with the origin near the trigger. Buttons press to scale `0.97` over `150ms ease-out`. Animate movement with `transform`, not positional offsets. Slide steppers in the direction of travel.
- Where supported, enable `interpolate-size: allow-keywords` at the root for auto-height accordions. Suspend descendant transitions during theme switches. Delay only the first tooltip in a group.
- For an incorrect password, keep the textual error and red treatment; add the `0, -10, 10, -6, 6, -3, 0px` shake over `360ms`. Under reduced motion, keep the text and omit the shake.
- Track a drag directly and carry release velocity into a non-bouncing spring. If a custom carousel overscrolls, progressively resist the pull and spring back; prefer native scrolling when it meets the need.
- Verify the built page with keyboard, touch, reduced motion, and JavaScript disabled where the core task can work without it.
