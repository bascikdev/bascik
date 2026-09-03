# Sharing Components

A Bascik components directory is plain files: HTML, paired CSS, paired scripts. There is no registry and no package format for components yet. This guide covers the ways to share components across projects today, and the constraint you will hit first.

## The constraint: names come from filenames

Component names are derived from filenames, regardless of subfolder nesting. Two files that produce the same tag name fail the build, by design:

<!-- demo:colliding-component -->
```html
<!-- src/components/hero-card.html -->
<!-- FAILS THE BUILD: two files both define the tag <hero-card>.
     Component names come from the filename, so subfolders do not
     create separate namespaces. Rename one file, for example
     marketing-hero-card.html. -->
<div class="hero-card">
  <p>Local hero card</p>
</div>
```

So a copied component that collides with a local one fails the build with an error naming both files. That is the first thing someone sharing components hits, and it is a feature: the collision is caught at build time, not at runtime. The fix is to rename one file with a prefix, for example `marketing-hero-card.html`, which also documents where the component came from.

## Approach 1: copy the files

For one or two components, copying is the honest answer. A component is a directory of plain files, so copying `hero-card.html` plus its paired `hero-card.css` and any companion scripts into your `src/components/` tree just works. Components may live in subfolders, so `src/components/marketing/hero-card.html` is discovered normally:

<!-- demo:shared-component -->
```html
<!-- src/components/marketing/hero-card.html -->
<!-- Component names derive from the filename, regardless of subfolder nesting. -->
<div class="hero-card">
  <p class="hero-card-title" data-bascik-prop-title></p>
  <p>Shared marketing card</p>
</div>
```

The trade-off is drift: a fix made in one project does not reach the copies. Copy only components that are stable, and rename on the way in if there is any collision risk.

## Approach 2: a git submodule

When the shared set is larger or evolves, put the components in their own repository and consume it as a git submodule:

```sh
git submodule add https://github.com/your-org/shared-bascik-components.git src/components/shared
```

Because components may live in subfolders, the submodule can sit directly inside `src/components/` and every component in it is discovered. The duplicate-name rule still applies: a submodule component whose filename collides with a local one fails the build, so prefix local names or submodule names to keep the namespaces distinct.

The trade-off is workflow weight: submodules pin a commit, so consuming projects must update deliberately, and contributors who have never used submodules will trip on the empty-checkout step.

## Approach 3: a package

For a shared set with a versioning story, publish the components directory as an npm package and consume it from an `exec` step that copies or symlinks the package's components into `src/components/`. This gives you semantic versioning and a changelog, at the cost of maintaining the packaging script. Reach for it when the submodule workflow is hurting, not before.

## What is coming

A `bascik add` command is planned to install components from a registry or repository directly, which will become the primary path. Until it lands, the manual approaches above are the state of the world.
