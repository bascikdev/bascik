---
name: bascik-images
description: Prepare and render images in Bascik sites. Use when converting photos to responsive WebP, choosing srcset and sizes, preserving transparency or EXIF orientation, optimizing image bytes or LCP, reserving image and thumbnail space, fixing gallery or color-control flashes and layout shifts, or preventing the wrong product variant from appearing before JavaScript loads. Includes a local responsive WebP generator.
license: MIT
metadata:
  author: bascik
  homepage: https://bascik.dev
---

# Images: Responsive Assets and Stable First Paint

Read [Optimizing Images](https://bascik.dev/how-to/optimizing-images) before changing image assets or rendering. Use the `bascik` skill for project conventions, `bascik-components` for component boundaries and scoping, and `bascik-scripts` for build-time or request-time markup.

## Must-follow workflow

1. **Inspect the layout before encoding.** Measure image slots at breakpoint edges and relevant pixel densities. Keep originals outside published pages, generate only useful widths, never upscale, and preserve orientation and transparency. Keep SVG logos as vectors; the bundled helper handles still images, not animation.
2. **Generate locally.** Run [`scripts/responsive-webp.mjs`](scripts/responsive-webp.mjs) from the user's project root. It loads that project's Sharp and writes WebP files plus a dimensions/URL/bytes/hash manifest. It does not inspect CSS or edit markup. Read the docs for flags and install requirements.
3. **Wire native markup.** Use the manifest's actual widths in `srcset`, match `sizes` to CSS, and reserve image geometry with dimensions or the intended crop's `aspect-ratio`. Prioritize only the likely LCP image; lazy-load below-the-fold images. Do not introduce an image runtime or service.
4. **Render the initial state, not a temporary default.** Build-render known gallery controls and thumbnail visibility. When a valid URL parameter selects a variant, use a server script to render the matching main image, selected option, and thumbnail set before paint. Validate it against the catalog; unknown values use the documented default. Do not show every thumbnail then hide most, or paint a default image then replace it on script startup.
5. **Separate downloads from DOM changes.** Delay images and browser scripts independently. Dimensions fix image layout, not controls created late or an incorrect variant. Reserve stable thumbnail boxes and keep controls in initial HTML rather than hiding the whole page until JavaScript runs.
6. **Preserve Bascik scoping.** Markup returned by a build script is scoped at build time; elements returned by a server script are not part of the original template's element-selector rewrite. Style returned children through a scoped container and child selectors, or shared global primitives. Do not emit a raw local class and assume it gets renamed.
7. **Keep generation out of watched source builds.** Generate once and commit assets, or use a `pre` exec producer writing to `BASCIK_OUT_DIR`, with an explicit URL prefix and a private manifest. Never make a build write generated files into `src/` or watch its own output.
8. **Verify the emitted site.** Test fresh mobile/desktop and high-density contexts, `currentSrc`, transferred bytes, transparency, cropping, and visual quality. With scripts delayed and disabled, assert the requested variant and exact visible thumbnail set. Compare geometry before and after script initialization and image decoding. Keep gallery navigation, color changes, reloads, and invalid-color behavior covered.

## Read the relevant section

| Task                                     | Read                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Preserve originals and choose widths     | `/how-to/optimizing-images#keep-originals-separate`, `/how-to/optimizing-images#choose-widths-from-the-layout` |
| Generate WebP and a manifest             | `/how-to/optimizing-images#generate-webp-locally`                                                              |
| Match responsive markup to CSS           | `/how-to/optimizing-images#wire-up-native-html-and-css`                                                        |
| Diagnose flashes and variant mismatch    | `/how-to/optimizing-images#prevent-flashes-and-layout-shifts`                                                  |
| Request-time rendering and hosting       | `/scripts/server`, `/deployment/cloudflare`                                                                    |
| Verify responsive images and first paint | `/how-to/optimizing-images#verify-the-result`, `/testing/e2e-testing`                                          |

Report measured results and any unverified cases. File generation or a Lighthouse score alone does not prove correct rendering.
