# Notices

This port reproduces the visitor-facing behavior of a WordPress 7.1.2 site using the bundled default theme, Twenty Twenty-Five 1.5. It is original code.

- **WordPress and Twenty Twenty-Five** are GPL-2.0-or-later. They were used only as a running reference (through WordPress Playground) to observe routes, listings, pagination, and markup structure. No WordPress PHP, theme templates, block markup, CSS, fonts, or images are copied into this port. The styles in `src/css/` and the components are written from scratch.
- **Sample content** (posts, pages, and the two striped PNG images) is original. It was written for this port, seeded into WordPress by `migration-examples/sources/wordpress-seed/seed.php`, and converted back with `wordpress-export-to-markdown`. The images were drawn with PHP GD at seed time.
- **Libraries** are used as npm dependencies under their own licenses: `sanitize-html` (MIT), `entities` (BSD-2-Clause), `marked` (MIT), `gray-matter` (MIT), `image-size` (MIT), `zod` (MIT).

"WordPress" is a trademark of the WordPress Foundation. This port is not affiliated with or endorsed by it.
