import { initProductCard } from "/assets/shop.js";
const root = document.getElementById("card");
if (!root) throw new Error("product-card root is missing.");
initProductCard(root);
