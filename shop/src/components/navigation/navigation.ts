import { initNavigation } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("navigation root is missing.");
initNavigation(root);
