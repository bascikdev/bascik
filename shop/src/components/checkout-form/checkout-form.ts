import { initCheckoutForm } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("checkout-form root is missing.");
initCheckoutForm(root);
