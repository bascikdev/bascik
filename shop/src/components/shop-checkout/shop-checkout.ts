import { initShopCheckout } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("shop-checkout root is missing.");
initShopCheckout(root);
