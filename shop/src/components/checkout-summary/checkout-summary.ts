import { initCheckoutSummary } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("Checkout summary root is missing.");
initCheckoutSummary(root);
