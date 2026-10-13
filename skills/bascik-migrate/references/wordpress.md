# From WordPress

Full guide: `read-doc.mjs /switch/from-wordpress`.

| WordPress | Bascik |
|---|---|
| The Loop, `WP_Query` | A `src/lib` helper returning escaped HTML, printed by a build script |
| `single.php` at `/%year%/%monthnum%/%day%/%postname%/` | `src/pages/[year]/[month]/[day]/[slug]/index.html` (one bracket per segment; a param cannot contain `/`) |
| Pages and child pages | `src/pages/[pageslug]/index.html` and `src/pages/[parent]/[child]/index.html` |
| Category, tag, and `/page/2/` archives | `category/[term]/`, `tag/[term]/`, `page/[page]/` templates, one template per paged archive |
| REST API (`/wp-json/wp/v2/`) | One `pre` exec script fetches everything (follow `X-WP-TotalPages`; `per_page` above 100 is a 400), sanitizes it, downloads media into `BASCIK_OUT_DIR`, and writes a JSON snapshot that pages read |
| Tools > Export (WXR) | `wordpress-export-to-markdown`, then restore page parents, menu order, term names, and image alt text by hand |
| `wp-content/uploads/` | Same path under `dist/`, so content URLs keep working |
| `/feed/` | A `post` exec script writing `/feed.xml`; redirect `/feed/` at the host |

Gotchas:

- Sanitize every post body before printing it. `content.rendered` can hold `<script>`, `on*` handlers, and `javascript:` links, and administrators may save any markup. Use an allowlist such as `sanitize-html`, which also drops custom elements so content cannot place a component tag. Bascik only removes printed directive scripts.
- Exclude pages that read fetched data from the script cache (`scripts.cache.exclude`). Network responses are not part of the cache key, so a rebuild after an edit in WordPress otherwise reuses old output.
- Keep page helpers light. Every build script is its own Node process; import `zod` and `sanitize-html` in the sync step, not in helpers every page loads.
- Raise the exec `timeout` for media downloads; the default is 60 seconds.
- REST titles are HTML (`&#038;`, curly quotes). Convert to text, then escape. WXR titles are raw text.
- A static build has no comments, search, or date and author archives. Use services or add templates.
