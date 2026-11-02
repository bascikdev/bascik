# Optimizing Images

Have your coding agent prepare responsive images with local tools, then wire them into vanilla HTML and CSS. Bascik needs no special image component: local tools create optimized files, HTML tells the browser which file to load, and CSS controls layout and cropping. No image service or browser JavaScript is required.

## Ask Your Coding Agent

Copy this prompt into your existing Bascik project:

```text
Optimize this site's images using local tools. Read the Bascik
bascik-components skill and /how-to/optimizing-images first.

Inspect the original images and the components' CSS at mobile, tablet,
and desktop widths. Choose useful WebP widths for each rendered slot,
including high-density screens, without upscaling. Keep originals
outside the published pages directory and preserve them.

Use the bundled responsive-webp helper or an available local image CLI.
Update the owning components with native img srcset and accurate sizes,
dimensions, descriptive alt text (empty for decorative images), and
appropriate loading priorities. Use picture only where different crops
or formats are needed. Keep layout and cropping in CSS.

Build the site and verify every generated URL, fresh browser currentSrc
selection at different viewport widths and pixel densities, visual
quality, and transferred bytes. Report before/after measurements and
anything you could not verify. Do not add a framework image component,
an image service, or runtime JavaScript for image selection.
```

The agent runs tools on your machine and edits your component files. The helper only generates images and a manifest; it does not inspect CSS or automatically add `srcset`. Those are the agent's jobs.

## Keep Originals Separate

For the default project layout, keep source photographs in a root folder such as `image-originals/`, outside `src/pages/`. Put only the optimized files you intend to serve in `src/pages/img/`; Bascik copies those assets to `dist/img/`.

Keep the originals so you can change widths, quality, or crops later. Do not convert SVG logos and icons to WebP just to follow this workflow: vectors often stay smaller and sharper. For animated images, use a tool and settings that explicitly preserve animation; the bundled helper is for still images.

## Choose Widths from the Layout

Measure the image's rendered width in CSS pixels at the layout's breakpoints. Multiply that slot width by the pixel densities you want to support, typically 1x and 2x. A photograph displayed at at most 800 CSS pixels may need candidates up to 1600 pixels wide, but a 900-pixel original cannot provide a true 1600-pixel candidate.

Choose a small useful set rather than generating every possible resolution. A thumbnail and a full-width hero need different sets. Never label a file `1600w` unless its actual encoded width is 1600 pixels. Resizing preserves aspect ratio; art-directed crops are a separate decision.

## Generate WebP Locally

The existing `bascik-components` skill ships a [responsive WebP helper](https://github.com/bascikdev/bascik/blob/main/skills/bascik-components/scripts/responsive-webp.mjs). Run it from your project root. It loads Sharp from your project's dependencies, not from the skill folder.

Install Sharp as a development dependency if it is not already available, using your project's package manager:

```sh
npm install -D sharp
```

This illustrative command assumes the skills are installed in `.agents/skills/` and the source is a 1600 by 900 still image. Adapt the paths and widths to your project:

```sh
node .agents/skills/bascik-components/scripts/responsive-webp.mjs \
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

## Verify the Result

1. Build with `npm run build` and confirm that every `src` and `srcset` URL resolves from the built site, including nested routes and any configured base path.
2. Open fresh browser contexts at mobile, tablet, and desktop widths, including 2x device pixel density. Inspect `currentSrc`, the rendered width, and the Network panel's transferred bytes. Resizing one already-loaded page is not sufficient: the browser may keep a larger cached candidate.
3. Compare the chosen encoded width to the rendered width times device pixel density. The browser chooses candidates using its own heuristics, so verify useful selection rather than assuming one exact file is mandatory.
4. Inspect visual quality and cropping at each size, including high density. Confirm that image space is reserved before loading, and that below-the-fold images load when scrolled into view.
5. Compare before/after transferred bytes for the same viewport, density, and cache conditions. Check [Lighthouse Performance](/lighthouse/performance) for LCP and CLS, but do not use a score alone as proof of image quality or correct selection.

The end result is ordinary static assets and vanilla markup you own. Change the encoder, widths, CSS, or hosting later without adopting a framework-specific image API.
