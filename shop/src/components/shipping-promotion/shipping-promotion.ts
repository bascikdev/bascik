import { initShippingPromotion } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("shipping-promotion root is missing.");
initShippingPromotion(root);
