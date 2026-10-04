# Notices

This directory is a Bascik adaptation of the finished example in the React documentation tutorial
"Thinking in React". The structure, component names, filtering rules, and stylesheet values are
adapted from it. The code is rewritten for Bascik and shares no source text with the original.

## Thinking in React (CC BY 4.0)

- Title: "Thinking in React"
- Source: <https://github.com/reactjs/react.dev/blob/8c68ae8d2410abe59f351195780c6f8ea9f50904/src/content/learn/thinking-in-react.md>
- Rendered at: <https://react.dev/learn/thinking-in-react>
- Copyright: Meta Platforms, Inc. and affiliates
- License: Creative Commons Attribution 4.0 International,
  <https://creativecommons.org/licenses/by/4.0/>
  (full text in `LICENSE-DOCS.md` of `reactjs/react.dev` at the same commit)

Changes: the React components became Bascik components, the state and its updates became a small
component script with a bubbling event, the product list became a TypeScript data module printed
by a build script, and the original stylesheet's rules moved next to the components that use them.
No endorsement by Meta Platforms, Inc. or the React team is implied.

The tutorial's mockup images are not used. The product names and prices are the tutorial's sample
data, which is part of the licensed material.
