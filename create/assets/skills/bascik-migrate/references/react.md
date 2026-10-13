# From React

Full guide: `read-doc.mjs /switch/from-react`.

| React | Bascik |
|---|---|
| Function component | `.html` file in `src/components/<name>/`; the hyphenated file name is the tag |
| `children` | `data-bascik-slot` (no value), fallback inside it |
| Render prop or named children | `<div data-bascik-slot="x">` wrapper at the usage site and in the component |
| `props.x` | `data-bascik-prop-x` (text only; booleans and numbers arrive as strings) |
| Prop used as an attribute | `data-bascik-attr-<attribute>="propName"` |
| Object, array, or function prop | Not possible. Print one component per item from a build script; use a bubbling `CustomEvent` instead of a callback |
| `useState` in the common parent | Variables in the parent component's `<script>`; one function applies them to the DOM |
| `onChange` callback prop | Child dispatches `new CustomEvent('x', { bubbles: true, detail })` from its own element; the parent listens on its root |
| Re-render of a filtered list | One function sets `hidden` on existing rows. There is no diff, so update every place a value appears |
| `.map()` over data | `<script data-bascik-build>` that prints component tags with escaped props |
| Conditional style | A `data-` attribute and a selector in the component's own CSS |
| React Router `/blog/:slug` | `src/pages/blog/[slug]/index.html` with `<script data-bascik-routes>` |

Gotchas:

- Escape every interpolated value in a build script. JSX did it for you; a template string does not.
- Forward `children` to an inner component by writing a default slot marker between the inner tags: `<inner-box><div data-bascik-slot>fallback</div></inner-box>`. Named wrappers between the inner tags fill the inner component's named slots.
- Plain inputs can disagree with state after Back or reload; re-read the fields on `pageshow`. A form with one text box submits on Enter; call `preventDefault()` in a `submit` listener when a script drives the form.
- Component scripts run once and move to the end of the document in production. Look up elements inside handlers or after `DOMContentLoaded`.
- `bascik --check` cannot see a component that only a build script prints and reports it as unused.
- Tag names need a hyphen: `Card.jsx` becomes `info-card`.
