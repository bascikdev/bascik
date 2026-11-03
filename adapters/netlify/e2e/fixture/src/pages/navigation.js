const path = location.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";

document.querySelectorAll(".site-nav .links a").forEach((link) => {
  if (new URL(link.href).pathname === path) {
    link.setAttribute("aria-current", "page");
  }
});
