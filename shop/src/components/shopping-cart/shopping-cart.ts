import { initShoppingCart } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("shopping-cart root is missing.");
initShoppingCart(root);
