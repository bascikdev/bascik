<?php
/**
 * Seeds a fresh WordPress 7.1.2 (Twenty Twenty-Five) with original sample content for task 09.
 * Run by WordPress Playground through blueprint.json. All text and images are original; the
 * images are drawn with GD at seed time. Writes /out/seed.json describing what was created,
 * plus a loopback-only application password for the harness's edit checks.
 */
require_once '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/taxonomy.php';

// An administrator has unfiltered_html, which the hostile-content post needs.
wp_set_current_user(1);

update_option('blogname', 'Fieldwork Journal');
update_option('blogdescription', 'Notes from a small market garden');
update_option('posts_per_page', 3);
update_option('timezone_string', 'UTC');
update_option('permalink_structure', '/%year%/%monthnum%/%day%/%postname%/');
update_option('show_on_front', 'posts');
flush_rewrite_rules();

// Remove the default content so only seeded items exist.
foreach (get_posts(['post_type' => ['post', 'page'], 'post_status' => 'any', 'numberposts' => -1]) as $existing) {
  wp_delete_post($existing->ID, true);
}
wp_delete_comment(1, true);

function seed_image(string $name, int $width, int $height, array $rgb): int {
  $image = imagecreatetruecolor($width, $height);
  $background = imagecolorallocate($image, $rgb[0], $rgb[1], $rgb[2]);
  imagefill($image, 0, 0, $background);
  $stripe = imagecolorallocate($image, 255, 255, 255);
  for ($x = 0; $x < $width; $x += 160) {
    imagefilledrectangle($image, $x, 0, $x + 40, $height, $stripe);
  }
  $temp = wp_tempnam($name);
  imagepng($image, $temp);
  imagedestroy($image);
  $id = media_handle_sideload(['name' => $name, 'tmp_name' => $temp], 0);
  if (is_wp_error($id)) throw new Exception($id->get_error_message());
  return $id;
}

$notes = wp_create_category('Notes');
$projects = wp_create_category('Projects');
wp_update_term(get_option('default_category'), 'category', ['name' => 'Uncategorized']);

$cover = seed_image('raised-beds.png', 1600, 1000, [46, 125, 50]);
update_post_meta($cover, '_wp_attachment_image_alt', 'Rows of raised beds drawn as green and white stripes');
$inline = seed_image('seed-trays.png', 1200, 800, [121, 85, 72]);
update_post_meta($inline, '_wp_attachment_image_alt', 'Seed trays drawn as brown and white stripes');
$inlineUrl = wp_get_attachment_url($inline);

function seed_post(array $post): int {
  $id = wp_insert_post(array_merge(['post_status' => 'publish', 'post_type' => 'post', 'post_author' => 1], $post), true);
  if (is_wp_error($id)) throw new Exception($id->get_error_message());
  return $id;
}

$created = [];
$created['first-frost'] = seed_post([
  'post_title' => 'First frost of the season',
  'post_name' => 'first-frost',
  'post_date' => '2026-01-12 08:00:00',
  'post_category' => [$notes],
  'tags_input' => ['weather'],
  'post_excerpt' => 'The thermometer read minus two at dawn.',
  'post_content' => "<!-- wp:paragraph -->\n<p>The thermometer read minus two at dawn. The kale did not mind; the last of the beans did.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:heading -->\n<h2 class=\"wp-block-heading\">What we covered</h2>\n<!-- /wp:heading -->\n\n<!-- wp:list -->\n<ul class=\"wp-block-list\"><li>Two beds of winter lettuce</li><li>The young garlic</li></ul>\n<!-- /wp:list -->",
]);
$created['tool-shed'] = seed_post([
  'post_title' => 'Rebuilding the tool shed',
  'post_name' => 'tool-shed',
  'post_date' => '2026-02-03 09:30:00',
  'post_category' => [$projects],
  'tags_input' => ['tools'],
  'post_content' => "<!-- wp:paragraph -->\n<p>The old shed leaned east. We replaced the sill plate and two studs.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:image {\"id\":$inline,\"sizeSlug\":\"large\"} -->\n<figure class=\"wp-block-image size-large\"><img src=\"$inlineUrl\" alt=\"Seed trays drawn as brown and white stripes\" class=\"wp-image-$inline\"/><figcaption class=\"wp-element-caption\">Trays waiting on the new shelf.</figcaption></figure>\n<!-- /wp:image -->\n\n<!-- wp:code -->\n<pre class=\"wp-block-code\"><code>cut 4 studs at 2390 mm\nfasten with 90 mm screws</code></pre>\n<!-- /wp:code -->",
]);
$created['raised-beds'] = seed_post([
  'post_title' => 'Raised beds, year two',
  'post_name' => 'raised-beds',
  'post_date' => '2026-03-15 07:45:00',
  'post_category' => [$projects, $notes],
  'tags_input' => ['tools', 'soil'],
  'post_content' => "<!-- wp:paragraph -->\n<p>Year two of the raised beds. The soil settled about five centimeters, so we topped each bed with compost.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:quote -->\n<blockquote class=\"wp-block-quote\"><!-- wp:paragraph -->\n<p>Feed the soil, not the plant.</p>\n<!-- /wp:paragraph --></blockquote>\n<!-- /wp:quote -->",
]);
set_post_thumbnail($created['raised-beds'], $cover);
$created['ampersands'] = seed_post([
  'post_title' => 'Tags & <brackets> "quoted"',
  'post_name' => 'ampersands',
  'post_date' => '2026-04-02 12:00:00',
  'post_category' => [$notes],
  'tags_input' => ['weather'],
  'post_content' => "<!-- wp:paragraph -->\n<p>A title with an ampersand, angle brackets, and quotes must survive every step: Fish &amp; Chips, 3 &lt; 5, \$1 and \$&amp;.</p>\n<!-- /wp:paragraph -->",
]);
// Content an editor pasted from an embed widget. WordPress stores it because administrators have
// unfiltered_html. Bascik's build step must neither run the directive nor ship the scripts.
$created['pasted-embed'] = seed_post([
  'post_title' => 'A pasted embed',
  'post_name' => 'pasted-embed',
  'post_date' => '2026-05-20 10:00:00',
  'post_category' => [$notes],
  'post_content' => "<!-- wp:paragraph -->\n<p>Below is markup pasted from a third-party widget.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:html -->\n<script>window.__pastedEmbed = true;</script>\n<img src=\"/missing.png\" alt=\"broken\" onerror=\"window.__pastedHandler = true\">\n<script data-bascik-build>import { writeFileSync } from 'node:fs'; writeFileSync('BASCIK_CANARY', 'ran'); console.log('<p id=\"canary\">build directive ran</p>');</script>\n<site-header />\n<p><a href=\"javascript:alert(1)\">a javascript link</a></p>\n<!-- /wp:html -->",
]);
$created['seed-saving'] = seed_post([
  'post_title' => 'Saving seed from tomatoes',
  'post_name' => 'seed-saving',
  'post_date' => '2026-06-08 18:20:00',
  'post_category' => [$notes],
  'tags_input' => ['soil'],
  'post_content' => "<!-- wp:paragraph -->\n<p>Ferment the pulp for three days, rinse, and dry the seed on a plate.</p>\n<!-- /wp:paragraph -->",
]);
$created['harvest-log'] = seed_post([
  'post_title' => 'Harvest log, July',
  'post_name' => 'harvest-log',
  'post_date' => '2026-07-30 19:00:00',
  'post_category' => [$projects],
  'tags_input' => ['weather', 'tools'],
  'post_content' => "<!-- wp:table -->\n<figure class=\"wp-block-table\"><table><thead><tr><th>Crop</th><th>Kilograms</th></tr></thead><tbody><tr><td>Beans</td><td>14</td></tr><tr><td>Zucchini</td><td>31</td></tr></tbody></table></figure>\n<!-- /wp:table -->",
]);
// A draft never reaches the public REST API or the theme.
$created['unfinished'] = seed_post([
  'post_title' => 'An unfinished draft',
  'post_name' => 'unfinished',
  'post_status' => 'draft',
  'post_date' => '2026-08-01 08:00:00',
  'post_content' => '<!-- wp:paragraph --><p>Not ready.</p><!-- /wp:paragraph -->',
]);

$about = wp_insert_post([
  'post_type' => 'page', 'post_status' => 'publish', 'post_author' => 1,
  'post_title' => 'About', 'post_name' => 'about', 'menu_order' => 1,
  'post_content' => "<!-- wp:paragraph -->\n<p>Fieldwork Journal is kept by two growers on a half-acre plot.</p>\n<!-- /wp:paragraph -->",
]);
$colophon = wp_insert_post([
  'post_type' => 'page', 'post_status' => 'publish', 'post_author' => 1,
  'post_title' => 'Colophon', 'post_name' => 'colophon', 'post_parent' => $about,
  'post_content' => "<!-- wp:paragraph -->\n<p>This site is written in the WordPress editor.</p>\n<!-- /wp:paragraph -->",
]);

$password = WP_Application_Passwords::create_new_application_password(1, ['name' => 'bascik-harness']);
if (is_wp_error($password)) throw new Exception($password->get_error_message());

file_put_contents('/out/seed.json', json_encode([
  'posts' => $created,
  'pages' => ['about' => $about, 'colophon' => $colophon],
  'media' => ['cover' => $cover, 'inline' => $inline],
  'user' => get_userdata(1)->user_login,
  'applicationPassword' => $password[0],
], JSON_PRETTY_PRINT));

// A WXR export of the same site, produced by WordPress's own exporter (Tools > Export).
require_once ABSPATH . 'wp-admin/includes/export.php';
ob_start();
export_wp(['content' => 'all']);
file_put_contents('/out/export.xml', ob_get_clean());
