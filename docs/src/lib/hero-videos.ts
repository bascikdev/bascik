import { esc } from "@bascik/bascik/html";
import { demoImage } from "./md-renderer.ts";

/** The launch videos linked from the home page hero, in display order. */
export const HERO_VIDEOS = [
  {
    slug: "bascik-in-3-minutes",
    title: "Bascik in 3 Minutes",
    note: "3 min · YouTube",
    href: "https://www.youtube.com/watch?v=pyPPiKpoWVY",
  },
  {
    slug: "bascik-launch",
    title: "Bascik: A New Kind of Web Development Tool",
    note: "Full video · YouTube",
    href: "https://www.youtube.com/watch?v=GCqJvXgm7Dc",
  },
] as const;

/**
 * How wide a thumbnail is laid out: two share a phone's width, and each is at most 300 pixels from there up.
 * The width variants beside each file come from scripts/responsive-images.ts.
 */
const THUMBNAIL_SIZES = "(max-width: 700px) 45vw, 300px";

/**
 * One `<li>` per video for the hero's list: a `<video-link>` with its
 * thumbnail. The thumbnail's alt is empty because the title next to it names
 * the video; a second copy of that name would be read twice.
 */
export function renderHeroVideos(): string {
  return HERO_VIDEOS.map(
    (video) => `<li>
      <video-link
        data-bascik-prop-href="${esc(video.href)}"
        data-bascik-prop-title="${esc(video.title)}"
        data-bascik-prop-note="${esc(video.note)}">
        <span data-bascik-slot="image">${demoImage(
          `/assets/demos/video-${video.slug}@2x.webp`,
          "",
          undefined,
          THUMBNAIL_SIZES,
        )}</span>
      </video-link>
    </li>`,
  ).join("\n");
}
