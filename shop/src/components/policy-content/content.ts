import { html, raw } from "@bascik/bascik/html";
import { policyPages } from "../../lib/policies.ts";
export default () => {
  // The request-time component manifest probes templates without a page.
  if (process.env.BASCIK_PAGE_PATH === "") return html``;
  const policy = policyPages.find(
    (policy) => process.env.BASCIK_PAGE_PATH === `/${policy.route}`,
  );
  if (!policy) throw new Error(`No policy for ${process.env.BASCIK_PAGE_PATH}`);
  return html`<h1>${policy.title}</h1>
    ${raw(policy.content)}`;
};
