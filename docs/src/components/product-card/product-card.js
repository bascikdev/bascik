const save = document.getElementById("save");
save.addEventListener("click", () => {
  const saved = save.getAttribute("aria-pressed") !== "true";
  save.setAttribute("aria-pressed", String(saved));
  save.textContent = saved ? "Saved" : "Save";
});
