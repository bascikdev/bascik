// One click listener serves every card on the page. The text is the same in
// every instance (no scoped id), so one CSP hash covers cards a server script
// renders at request time too.
if (!document.documentElement.hasAttribute("data-product-card-save")) {
  document.documentElement.setAttribute("data-product-card-save", "");
  document.addEventListener("click", (event) => {
    const save = event.target.closest(".save");
    if (save === null) return;
    const saved = save.getAttribute("aria-pressed") !== "true";
    save.setAttribute("aria-pressed", String(saved));
    save.textContent = saved ? "Saved" : "Save";
  });
}
