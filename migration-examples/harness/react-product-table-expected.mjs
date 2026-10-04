// Expectations that differ between the pinned React tutorial code and the Bascik port. The
// behavior both must share is in react-product-table-checks.mjs.
export const upstream = {
  name: 'upstream',
  // The tutorial's final form has no onSubmit handler, so Enter submits the form and the page
  // navigates to "/?".
  enterNavigates: true,
  // The tutorial's inputs carry no label, only a placeholder.
  textBoxAriaLabel: '',
  // One bundle holds the React runtime and the app (about 221 kB at the pinned lockfile).
  productionScripts: true,
  minScriptBytes: 100000,
  maxScriptBytes: 400000,
  rendersWithoutJavaScript: false,
};

export const port = {
  name: 'port',
  enterNavigates: false,
  textBoxAriaLabel: 'Search products',
  // Two small inline scripts, no runtime.
  productionScripts: true,
  minScriptBytes: 500,
  maxScriptBytes: 6000,
  rendersWithoutJavaScript: true,
};
