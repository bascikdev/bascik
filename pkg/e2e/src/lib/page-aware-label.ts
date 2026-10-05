// Returns markup for the page-aware badge. The classes and the <em> element are
// styled by page-aware-badge.css, so this output must be scoped like the template.
export const pageAwareLabel = (path: string): string =>
  `<span class="badge-label" data-testid="page-aware-label"><em data-testid="page-aware-em">${path}</em></span>`;
