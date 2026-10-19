# Tab Group

Accessible tabs built from the sections you pass in, with arrow-key navigation and IDs that stay unique when the component appears more than once on a page. Without JavaScript every section stays visible.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/tab-group)

## Usage

Each child of the slot becomes one panel, and its `data-tab` attribute is the tab's text. `label` names the tab list for screen readers.

<!-- demo:usage -->

```html
<tab-group data-bascik-prop-label="Pricing plans">
  <section data-tab="Monthly"><p>$10 per month, cancel any time.</p></section>
  <section data-tab="Yearly"><p>$100 per year, two months free.</p></section>
  <section data-tab="Team"><p>$25 per person per month.</p></section>
</tab-group>
```

<!-- example:demo -->

## How It Works

- The script builds one `<button role="tab">` per section and gives every tab and panel an ID derived from the component root's scoped ID (`${root.id}-tab-0`). Bascik rewrites `root` to a different ID in each instance, so two tab groups never share IDs, and `aria-controls` and `aria-labelledby` always point at the right element.
- Left and Right move between tabs and wrap at the ends; Home and End jump to the first and last tab. Only the selected tab is in the Tab order (a roving `tabindex`).
- `tab.className = 'tab'` is a static string, so Bascik rewrites it to the scoped class from the component's `<style>` block. A template literal would not be rewritten.
- The tab list is `hidden` in the markup and shown by the script, so a visitor without JavaScript never sees buttons that do nothing.

## Adapt It

- Give each section a heading if it must make sense when the sections are stacked without JavaScript.
- To remember the selected tab across reloads, store its index in `sessionStorage`, keyed by `root.id`.
- To open a specific tab from a link, read `location.hash` on load and select the panel whose `data-tab` matches.
