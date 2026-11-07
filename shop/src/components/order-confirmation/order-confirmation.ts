import { initOrderConfirmation } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("order-confirmation root is missing.");
initOrderConfirmation(root);
