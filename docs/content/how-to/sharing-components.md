# Sharing Components

A Bascik components directory is plain files: HTML, paired CSS, and paired scripts. Sharing components between projects follows a copy-in model where components are copied directly into your project's `src/components/` directory and become first-class project files.

This page is about separate repositories. If all of your sites live in one repository, you do not need to copy anything: point each site's `directory.components` and `scripts.importRoot` at shared folders instead. See [Monorepos](/how-to/monorepos).

## The primary path: `bascik add`

The easiest way to share and consume components across projects is with `bascik add`. Install an npm package that exports Bascik components, then copy all or specific components into your project:

```sh
# Copy all components from the package
bascik add @acme/ui

# Copy a single component
bascik add @acme/ui/card
```

When you run `bascik add`:

- Files are copied directly into `src/components/` and belong to your project.
- Adding one component also copies the non-test files in the folder named after it, beside it (`chat/voice-call.html` brings `chat/voice-call/*.ts`), since a component's relative imports point there.
- A `bascik-lock.json` file is created or updated to track package versions and file content hashes.
- Re-adding an unmodified component updates it safely. If you locally edit a copied component, `bascik add` refuses to overwrite it unless you pass `--force`.
- Run `bascik add --dry-run` to see what would be copied without writing files to disk.

See [Publishing Components](/how-to/publishing-components) for details on creating packages compatible with `bascik add`.

## The constraint: names come from filenames

Component names are derived from filenames, regardless of subfolder nesting. Two files that produce the same tag name fail the build, by design:

<!-- demo:colliding-component -->

```html
<!-- src/components/hero-card.html -->
<!-- FAILS THE BUILD: two files both define the tag <hero-card>.
     Component names come from the filename, so subfolders do not
     create separate namespaces. Rename one file, for example
     marketing-hero-card.html. -->
<div class="hero-card" data-testid="hero-card">
  <p>Local hero card</p>
</div>
```

When using `bascik add` or manual copying, any collision with an existing project component is detected before writing anything. If a name collision occurs, rename the local file (e.g. `marketing-hero-card.html`) or adjust the package.

## Alternative 1: manual file copy

For one or two components without npm packaging, copying files manually is straightforward. Copy `hero-card.html` plus its paired `hero-card.css` and companion scripts into `src/components/`:

<!-- demo:shared-component -->

```html
<!-- src/components/marketing/hero-card.html -->
<!-- Component names derive from the filename, regardless of subfolder nesting. -->
<div class="hero-card" data-testid="hero-card">
  <p data-bascik-prop-title></p>
  <p>Shared marketing card</p>
</div>
```

The trade-off is drift: improvements made in one project must be copied manually to others.

## Alternative 2: a git submodule

When sharing a set of components across internal repositories, you can consume a shared repository as a git submodule:

```sh
git submodule add https://github.com/your-org/shared-bascik-components.git src/components/shared
```

Because components may live in subfolders, the submodule sits directly inside `src/components/` and every component in it is discovered automatically. The duplicate-name rule still applies: ensure filenames in the submodule do not collide with top-level project components.

The submodule does not have to live under `src/components/`. Since `directory.components` accepts an array, you can check it out anywhere and list it as a second root, which keeps vendored and hand-written components in separate trees:

```sh
git submodule add https://github.com/your-org/shared-bascik-components.git vendor/shared-components
```

```ts
directory: {
  components: ['src/components', 'vendor/shared-components'],
}
```

Do not do both: a submodule inside `src/components/` that is also listed as its own root is rejected at startup as a nested root.

## Components a model writes

[Generative UI](/ai) uses the same model for a different reader. A catalog, the components a model is allowed to write, is a folder of components, and `@bascik/ai` ships a starter catalog and its chat components as a component package:

```sh
bascik add @bascik/ai
```

The files land in `src/components/catalog/` and `src/components/chat/`, and the catalog is read from that folder at request time. Copying matters more here than usual: a catalog component's `@bascik` description is part of the prompt a model reads, so editing your copy is how you change what the model does with it. See [Share a catalog](/ai/catalog#share-a-catalog).
