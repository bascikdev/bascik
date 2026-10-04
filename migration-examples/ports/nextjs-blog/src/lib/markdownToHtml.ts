import { remark } from "remark";
import html from "remark-html";

// Unchanged from the upstream example. remark-html sanitizes its output by default.
export default async function markdownToHtml(markdown: string) {
  const result = await remark().use(html).process(markdown);
  return result.toString();
}
