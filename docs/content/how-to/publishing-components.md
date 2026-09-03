# Publishing Components

Publishing Bascik components allows teams and open-source authors to distribute reusable components as standard npm packages. Consuming projects copy those components into their codebase with `bascik add`.

## The `bascik.components` contract

A component package is a regular npm package with a **`bascik.components`** field in its `package.json` pointing to the directory containing component files:

```json
{
  "name": "@acme/ui",
  "version": "1.0.0",
  "bascik": {
    "components": "./components"
  }
}
```

The directory path is relative to the package root. All component files (`.html`, paired `.css`, paired scripts) in that directory and its subdirectories are advertised for consumers to add.

## Recommended package layout

Organize your component package repository with a clean components directory:

```text
my-component-package/
  package.json
  README.md
  LICENSE
  components/
    button/
      button.html
      button.css
    card/
      card.html
      card.css
    badge/
      badge.html
```

Ensure the `files` field in `package.json` includes the components directory (e.g. `"files": ["components"]`), or that `.npmignore` does not exclude it when publishing.

## Files are copied verbatim

Bascik does not run a build step or transformation pass when copying components with `bascik add`. Files land in the consumer's `src/components/` directory exactly as published.

Because of this copy-in model:

1. **Do not rely on package-relative build steps:** Write vanilla HTML, standard CSS, and vanilla JavaScript.
2. **Component names come from filenames:** Lowercase base filenames determine custom element tag names (e.g. `fancy-button.html` becomes `<fancy-button>`). Subfolders do not create separate namespaces.
3. **Keep companions co-located:** Keep `.css` and script files paired with their corresponding `.html` template so `bascik add` copies all associated assets.

## Semantic versioning

When publishing updates to a component package:

- **Patch (`1.0.1`):** Bug fixes and styling improvements that do not change the component's public interface or tag names.
- **Minor (`1.1.0`):** New components or backward-compatible props/slots additions.
- **Major (`2.0.0`):** Breaking prop renames, slot changes, or tag name modifications.

Consumers tracking your package via `bascik-lock.json` can re-run `bascik add <package>` to pull in new versions cleanly, while locally modified files are protected from accidental overwrites.
