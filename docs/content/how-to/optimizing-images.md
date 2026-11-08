# Optimizing Images

Use the `bascik-images` skill to prepare responsive images with local tools and render the correct image state from the first paint. Bascik needs no special image component: local tools create optimized files, vanilla HTML selects the image, and CSS controls layout and cropping.

## Use the Image Skill

New Bascik projects offer to install `bascik-images` with the other general-purpose skills. For an existing project, install it from the project root:

```sh
npx skills add bascikdev/bascik --skill bascik-images
```

Tell your assistant to use `bascik-images` when optimizing images or fixing a gallery flash. The skill routes to this guide, runs local tools, and checks the built result. Its helper only generates images and a manifest; the assistant still inspects CSS and wires up `srcset`, initial state, and loading priorities. See [Agent Skills](/agent-skills) for installation options.

## Keep Originals Separate

For the default project layout, keep source photographs in a root folder such as `image-originals/`, outside `src/pages/`. Put only the optimized files you intend to serve in `src/pages/img/`; Bascik copies those assets to `dist/img/`.

Keep the originals so you can change widths, quality, or crops later. Do not convert SVG logos and icons to WebP just to follow this workflow: vectors often stay smaller and sharper. For animated images, use a tool and settings that explicitly preserve animation; the bundled helper is for still images.

## Choose Widths from the Layout

Measure the image's rendered width in CSS pixels at the layout's breakpoints. Multiply that slot width by the pixel densities you want to support, typically 1x and 2x. A photograph displayed at at most 800 CSS pixels may need candidates up to 1600 pixels wide, but a 900-pixel original cannot provide a true 1600-pixel candidate.

Choose a small useful set rather than generating every possible resolution. A thumbnail and a full-width hero need different sets. Never label a file `1600w` unless its actual encoded width is 1600 pixels. Resizing preserves aspect ratio; art-directed crops are a separate decision.

## Generate WebP Locally

The `bascik-images` skill ships the [responsive WebP helper](https://github.com/bascikdev/bascik/blob/main/skills/bascik-images/scripts/responsive-webp.mjs), previously part of `bascik-components`. Run it from your project root. It loads Sharp from your project's dependencies, not from the skill folder.

Install Sharp as a development dependency if it is not already available, using your project's package manager:

```sh
npm install -D sharp
```

This illustrative command assumes the skills are installed in `.agents/skills/` and the source is a 1600 by 900 still image. Adapt the paths and widths to your project:

```sh
node .agents/skills/bascik-images/scripts/responsive-webp.mjs \
  --src image-originals/hero.jpg \
  --out src/pages/img \
  --widths 400,800,1200,1600 \
  --quality 80 \
  --manifest image-originals/manifest.json
```

The helper writes `hero-400.webp`, `hero-800.webp`, `hero-1200.webp`, and `hero-1600.webp`. It skips widths larger than the source, may include the source's own width when it falls between requested widths, and corrects EXIF orientation before resizing. The manifest records upright source dimensions and each variant's width, URL, byte count, and SHA-256 hash. Its URLs are derived from `src/pages/img` as `/img/`; pass `--url-prefix` when using a custom pages directory. For a site hosted under a URL prefix, follow [Base Path](/configuration#base).

Start with quality 80, then inspect the results rather than treating that number as a guarantee. Compare encoded bytes with the original and look for artifacts in faces, gradients, and text. An available ImageMagick or WebP CLI is also fine if it produces the intended widths, orientation, and quality. The resulting HTML does not depend on which encoder you use.

Generate once and commit the optimized assets, then regenerate when the source or layout changes. If generation runs as part of the build instead, use a `pre` [exec script](/exec-scripts) that writes directly to `dist/` using `BASCIK_OUT_DIR`, with an explicit `--url-prefix` and a manifest outside published assets. Do not register a build step that writes into `src/` or watches its own output.

## Wire Up Native HTML and CSS

For the illustrative 1600 by 900 hero above, this component displays the image at the viewport width minus 32 pixels of gutters, capped at 800 pixels:

```html
<style>
  img {
    display: block;
    width: min(800px, calc(100vw - 32px));
    max-width: 100%;
    height: auto;
    margin-inline: auto;
  }
</style>
<img
  src="/img/hero-800.webp"
  srcset="
    /img/hero-400.webp   400w,
    /img/hero-800.webp   800w,
    /img/hero-1200.webp 1200w,
    /img/hero-1600.webp 1600w
  "
  sizes="(max-width: 832px) calc(100vw - 32px), 800px"
  width="1600"
  height="900"
  alt="Sunlight over a mountain lake"
  fetchpriority="high"
  data-testid="hero-image"
/>
```

The `sizes` value matches this CSS, not a guess about device names. Adapt it if the component sits in a narrower parent or a multi-column grid. `width` and `height` reserve the source's aspect ratio before loading; they do not override the responsive CSS width. Use the manifest's actual dimensions and only list files that were generated.

For below-the-fold photos, use `loading="lazy"` instead of `fetchpriority="high"`. Do not lazy-load the hero, and do not mark every image high priority. Keep useful `alt` text on informative images and `alt=""` on decorative ones.

Use `object-fit: cover`, `object-position`, and a stable CSS `aspect-ratio` when the layout needs cropping. If mobile needs a genuinely different composition, generate separate crops and use `<picture>` with media-specific `<source>` elements. For format alternatives, use `type` on `<source>` and keep a working `<img>` fallback. `<picture>` is not required just to serve WebP to modern browsers. See [Performance](/lighthouse/performance#responsive-images-with-srcset) for native syntax examples.

## Prevent Flashes and Layout Shifts

Image downloads and late DOM updates are different problems. Reserving a box fixes missing image space, but it cannot fix a color selector created after load or a Black photo briefly displayed when the URL selected Tan.

### Reserve the image and thumbnail boxes

Give each image accurate `width` and `height`, as above. For square gallery previews, reserve the button's box too, so decoding an image cannot change the grid:

```css
.thumbnails {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}
.thumbnails > * {
  padding: 0;
  min-width: 0;
  aspect-ratio: 1;
  overflow: hidden;
}
.thumbnails > * > * {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
```

This illustrative CSS belongs beside the gallery component. Adapt the columns and ratio to the actual layout. Keep informative images' `alt` text; a thumbnail inside a button with a descriptive accessible name can use `alt=""`. Resizing WebP files preserves transparent backgrounds, but verify the encoded result rather than flattening it against a placeholder color.

### Render known controls at build time

When the catalog already knows the colors and image views, render the color buttons, gallery arrows, and initial `aria-pressed` state in the HTML. Use a [build script](/scripts/build) and slots for repeated catalog content. Browser scripts attach interaction handlers; they should not create the controls or reveal an empty controls row during startup.

Render only the initial color's thumbnails as visible. Keep other colors' thumbnail buttons `hidden` until the customer changes color. Showing all views first and hiding most in JavaScript produces an expanded gallery that suddenly shrinks, even when every image has dimensions.

### Render URL-selected variants on the server

A build script cannot know a request's query string. For a URL that selects a color, a [server script](/scripts/server) can validate the requested value against the owned catalog and return the matching main image, selected color option, and visible thumbnail set before the browser paints. Invalid colors retain the documented default. Use the same validation helper for all three pieces; do not let the image, select, and gallery disagree.

For example, a helper beside a book-cover component could select a requested edition like this:

```ts
import { html } from "@bascik/bascik/html";
import { editions } from "./editions.ts";

export default (request: Request) => {
  const requested = new URL(request.url).searchParams.get("edition");
  const edition =
    editions.find((edition) => edition.id === requested) ?? editions[0];
  return html`<img
    src="${edition.src}"
    width="${edition.width}"
    height="${edition.height}"
    alt="${edition.alt}"
    fetchpriority="high"
  />`;
};
```

The illustrative `editions.ts` is the component's owned, nonempty catalog. Add its actual `srcset` and `sizes` for responsive output, and use that same selected edition when rendering options and thumbnail visibility. Render a selected option with the literal `selected` attribute only on the matching option; `selected="false"` still selects an option. Likewise, `hidden="false"` still hides an element.

Load the helper with `data-bascik-server` in the component. This requires request-time hosting, such as the [Cloudflare adapter](/deployment/cloudflare), not a static-only host. Verify that product routes reach the Worker and that a cache never reuses one query's variant for another query. The catalog listing and image assets can remain static. Do not hide the whole page until JavaScript runs or depend on a browser startup swap to correct the selected variant.

### Style returned markup through its container

Build-script output participates in Bascik's build-time scoping. Server-script output is inserted at request time, so its new elements do not receive the original template's scoped element classes. A raw local class in returned markup does not automatically become its compiler-scoped name.

Keep the gallery container in the component template with its scoped `.thumbnails` class, and style returned buttons and images through child selectors, as above. Shared global image primitives are another option. See [Scoped Styles](/scoped-styles) and [Server Scripts](/scripts/server).

## Verify the Result

1. Build with `npm run build` and confirm that every `src` and `srcset` URL resolves from the built site, including nested routes and any configured base path.
2. Open fresh browser contexts at mobile, tablet, and desktop widths, including 2x device pixel density. Inspect `currentSrc`, the rendered width, and the Network panel's transferred bytes. Resizing one already-loaded page is not sufficient: the browser may keep a larger cached candidate.
3. Compare the chosen encoded width to the rendered width times device pixel density. The browser chooses candidates using its own heuristics, so verify useful selection rather than assuming one exact file is mandatory.
4. Inspect visual quality and cropping at each size, including high density. Confirm that image space is reserved before loading, and that below-the-fold images load when scrolled into view.
5. Compare before/after transferred bytes for the same viewport, density, and cache conditions. Check [Lighthouse Performance](/lighthouse/performance) for LCP and CLS, but do not use a score alone as proof of image quality or correct selection.
6. Delay image responses and browser scripts independently. Before scripts run, assert that controls exist, the requested variant is selected, and exactly the intended thumbnails are visible. Compare image, thumbnail, and nearby heading geometry after scripts initialize and again after visible images decode.
7. Repeat direct links and reloads for every variant, including invalid query values, with JavaScript disabled. Then verify that color changes and previous/next controls still work independently across multiple cards. A correct final screenshot alone misses a wrong first frame.

The end result is ordinary static assets and vanilla markup you own. Change the encoder, widths, CSS, or hosting later without adopting a framework-specific image API.
