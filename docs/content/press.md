# Press Resources

Official Bascik logos, colors, and usage rules for articles, talks, videos, podcasts, and community sites. Download the full brand kit or pick individual files.

## Kit Contents

The brand kit is a single zip containing a `bascik-press-kit/` folder. Every raster file is generated from the same two master SVGs, so all sizes stay consistent.

| Folder | Contents | Use for |
| --- | --- | --- |
| `logo/svg` | Wordmark and mark in full color, black, and white | Web, print, slides, and anywhere SVG is supported |
| `logo/png` | Full-color wordmark at 600, 1200, and 2400 px wide; mark at 256, 512, and 1024 px. Transparent backgrounds | Tools that do not accept SVG |
| `avatar` | 1024 x 1024 profile images on dark and light backgrounds | Profile pictures on social networks and community sites |
| `social` | Link preview image and profile banners | Article headers, repository previews, and social profiles |
| `README.txt` | One-page summary of the rules on this page | Sharing the rules with collaborators |

## Brand Guidelines

The sections below cover logos, colors, naming, image sizes, and usage. Following them keeps Bascik recognizable and accurately represented wherever it appears.

## Logos

Bascik has two logos. Both are skewed lime tiles with an ink cursor, and both are supplied as static artwork.

- **Wordmark.** The tile with the cursor and the name `BASCIK`. Use it whenever there is room, because it names the project.
- **Mark.** The tile with the cursor only. Use it where a square or very small image is required, such as avatars, favicons, and app lists, and only after the wordmark or the name "Bascik" has appeared nearby.

### Color Versions

| Version | Use on |
| --- | --- |
| Full color (lime tile, ink cursor and letters) | Everywhere by default, on dark, light, and mid-tone backgrounds |
| Black | Only when a single ink is required, such as one-color print |
| White | Only when a single ink is required on a dark stock |

Use the full-color logo unless you are limited to one color. The black and white versions are a solid tile with the cursor and letters cut out, so the background shows through them. On a plain white background, give the full-color logo a little extra clear space so the lime tile reads as a shape.

### Spacing and Minimum Size

Always keep adequate clear space around the wordmark and the mark. As a guide, leave at least one quarter of the logo height on every side, with no text, other logos, or image edges inside it.

The wordmark and the mark should always be at least 24 px tall in digital applications and 1/8 inch (3 mm) tall in print.

## Colors

| Name | Hex | RGB | Use |
| --- | --- | --- | --- |
| Lime | `#d3ff8d` | 211, 255, 141 | Logo tile and accents |
| Ink | `#0e0f10` | 14, 15, 16 | Logo cursor and letters, and text on Lime |
| Charcoal | `#18191b` | 24, 25, 27 | Dark backgrounds |
| Paper | `#f2f3f0` | 242, 243, 240 | Light backgrounds |

Ink on Lime has a contrast ratio of 16.9:1, and Lime on Charcoal has 15.5:1. Both pass WCAG AAA for body text.

## Naming and Description

Write the name as **Bascik** in running text: capital B, lowercase rest. The all-caps `BASCIK` appears only inside the wordmark artwork. The npm packages are `@bascik/bascik` and `create-bascik`.

The tagline is **HTML components. Zero runtime.**

Use this description when you need a short, accurate summary of the project:

```text
Bascik is a build tool for HTML components with automatically scoped CSS and JS. Zero runtime. The code that ships is the code you wrote.
```

Official links:

- Website: <https://bascik.dev>
- Source and issues: <https://github.com/bascikdev/bascik>
- Press and media: <press@bascik.dev>

## Image Sizes and Resolutions

Use the SVG whenever the destination accepts it. SVG is resolution independent, so it stays sharp at any size. When you need a raster image, pick the file that matches the destination:

| Destination | Size (px) | File |
| --- | --- | --- |
| Article header, Open Graph, and link previews | 1200 x 630 | `social/bascik-social-1200x630.png` |
| GitHub repository social preview | 1280 x 640 | `social/bascik-github-social-1280x640.png` |
| X (Twitter) profile header | 1500 x 500 | `social/bascik-banner-1500x500.png` |
| LinkedIn profile or page banner | 1584 x 396 | `social/bascik-banner-1584x396.png` |
| Profile picture on a dark theme | 1024 x 1024 | `avatar/bascik-avatar-dark-1024.png` |
| Profile picture on a light theme | 1024 x 1024 | `avatar/bascik-avatar-light-1024.png` |
| Slides, video, and print layouts that need a transparent image | 2400 px wide | `logo/png/bascik-wordmark-2400.png` |
| Documents and web pages (transparent) | 1200 px wide | `logo/png/bascik-wordmark-1200.png` |
| Small interface elements | 256 x 256 | `logo/png/bascik-mark-256.png` |

The profile pictures keep the mark well inside the frame, so circular crops do not clip it.

PNG exports are rendered at 1x. For sharp results on high-density screens, display a PNG at half its pixel width, for example a 2400 px file shown at 1200 CSS px.

Platforms change their recommended sizes from time to time. If a destination needs something different, scale the SVG instead of stretching a PNG.

## Using the Logo

### How to Use the Logo

These uses are fine without asking, as long as you follow the rules on this page:

- Link to the Bascik website or GitHub repository.
- Show that your tool, template, starter, or product has built-in Bascik support. The claim must be accurate and made in good faith.
- Illustrate an article, tutorial, talk, video, podcast, book, or course about Bascik.
- Promote a meetup, workshop, or conference that is about Bascik.
- Show your experience with Bascik in a portfolio, resume, or personal site.

### Things to Avoid

- Do not use the Bascik logo as the icon or logo of your own app, website, or company.
- Do not include the Bascik logo inside your own logo.
- Do not modify the logo. That includes recoloring it, changing its proportions, rotating or skewing it further, adding shadows, outlines, gradients, or other effects, cropping it, or retyping the wordmark in another typeface. Use the supplied artwork.
- Do not place the logo on a background that makes it hard to see.
- Do not use the logo in a way that suggests Bascik, or anyone who contributes to it, sponsors or endorses your product, service, event, or organization.
- Do not sell products that feature the logo, such as stickers or shirts, without permission.

If you want to do something this page does not cover, open an issue on [GitHub](https://github.com/bascikdev/bascik/issues) and ask first.

The Bascik software is licensed under the [MIT License](/license). The license does not grant rights to use Bascik's names, logos, or trademarks.
