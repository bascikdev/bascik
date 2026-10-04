# Notices

This directory is a Bascik port of the Vue "Grid with Sort and Filter" example from the official Vue
documentation. The Vue source is licensed under Creative Commons Attribution 4.0 International
(CC BY 4.0). The notice and the changes are stated here as the license requires.

## Vue documentation example (CC BY 4.0)

- Source: `vuejs/docs`, commit `40aa88af0094f7bab4aaf786e55c748a6a251d88`,
  `src/examples/src/grid/` (the `App` and `Grid` components). Shown at
  <https://vuejs.org/examples/#grid>.
- Copyright (c) 2019-present, Yuxi (Evan) You and Vue documentation contributors.
- License: <https://creativecommons.org/licenses/by/4.0/>. The upstream repository states that its
  contents, except image files, are licensed under CC BY 4.0. No image is used here.

Changes made: the Options API single-file components were rewritten as two Bascik components and
a page, the template was changed from Vue template syntax to HTML with a small script, the data
moved to `src/data/grid.ts`, and the sort control became a `<button>` inside each header cell. The
stylesheet is adapted from `Grid/style.css` with the button rules added. There is no endorsement by
the licensor.

## Original material

The second dataset on the two-grid page (`planetData`), the helpers in `src/lib/grid.ts`, and the
README were written for this port.
