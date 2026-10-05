# Template Catalog

Every starter that Bascik maintains, with screenshots, version, license, source, and requirements. Each starter is a standalone project you can install with `create-bascik`, then change freely.

## Blog

A Markdown blog with a paginated archive, tag pages, an Atom feed, canonical and link-preview metadata, responsive images, syntax highlighting, drafts, and a 404 page. It ships no client JavaScript. The guide is [Blog](/use-cases/blog).

![The blog starter's home page on a desktop screen, showing the Lantern Log header, navigation, and the three latest posts.](/assets/templates/blog-home-desktop.png)

![A post in the blog starter on a phone screen, showing the title, date, tags, and the first sections with heading anchors.](/assets/templates/blog-post-mobile.png)

| Detail | Value |
| --- | --- |
| Name | `blog` |
| Version | 0.1.0 |
| Install | `npm create bascik@rc my-blog -- --example blog` |
| Source | [`templates/blog`](https://github.com/bascikdev/bascik/tree/main/templates/blog) |
| License | MIT. See [`LICENSE`](https://github.com/bascikdev/bascik/blob/main/templates/blog/LICENSE) and [`NOTICE.md`](https://github.com/bascikdev/bascik/blob/main/templates/blog/NOTICE.md) |
| Bascik | Installed from the starter's package manifest |
| Node.js | 24 or later |
| Hosting | Any static host, served from the root of its domain |
| Client JavaScript | None |
| Requires | `BASCIK_SITE_URL` for production builds |
| Hosted demo | None yet. Preview it locally, as shown below |

The sample text, images, and icon are original to the starter. Its dependencies keep their own licenses.

### Preview it locally

There is no hosted demo, so the quickest way to see the starter is to create it:

```sh
npm create bascik@rc my-blog -- --example blog
cd my-blog
npm run dev
```

Open **http://localhost:8080**. This is the development server, which shows the sample draft post and rebuilds when you edit.

To see the production output instead, build with a site URL and serve the result:

```sh
BASCIK_SITE_URL=http://localhost:8080 npm run build
npm run serve
```

Use a `create-bascik` release that supports `--example`.

## How starters are installed

An official name such as `blog` downloads the branch `examples/blog` of the Bascik repository. That branch is updated after a Bascik release is published. Each starter declares its own Bascik dependency and requirements; the same command can give a newer starter version later.

Any public GitHub repository can also be used as a starter by passing its link. Third-party starters are not reviewed by Bascik and are not listed here. See [Getting Started](/getting-started#start-from-an-example) for every option, the safety checks, and the rules for third-party links.

## Choosing a starter

A starter is a beginning, not a framework. After you create a project it is yours: nothing links it to the catalog, and there is no update command. Read its README, run its tests with `npm test`, and delete the sample content before you publish.

Starters for other site types will be added here when their guides are ready.
