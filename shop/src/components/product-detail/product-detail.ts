import { initProductDetail } from "/assets/shop.js";
const root = document.getElementById("root");
if (!root) throw new Error("product-detail root is missing.");
initProductDetail(root);
