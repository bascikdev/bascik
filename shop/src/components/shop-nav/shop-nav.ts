import { initShopNav } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("shop-nav root is missing.");
initShopNav(root);
