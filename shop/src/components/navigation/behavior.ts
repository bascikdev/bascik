import { cart } from "../../browser/cart.ts";
import { componentElements } from "../../browser/dom.ts";
export function initNavigation(root: HTMLElement) {
  const { element } = componentElements(root);
  const render = () => {
    const badge = element("[data-cart-count]");
    if (badge) {
      badge.textContent = String(
        cart().reduce((sum, item) => sum + item.quantity, 0),
      );
      badge.dataset.ready = "true";
    }
  };
  document.addEventListener("shop:cart-changed", render);
  render();
  element("[data-theme-toggle]")?.addEventListener("click", () => {
    const theme =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("bascik-theme", theme);
    } catch (error) {
      console.error("Could not save theme", error);
    }
  });
  const menu = element("[data-testid=shop-nav-menu]");
  menu?.addEventListener("click", () =>
    menu.setAttribute(
      "aria-expanded",
      String(menu.getAttribute("aria-expanded") !== "true"),
    ),
  );
}
