(() => {
  // Sticky header that shrinks on scroll.
  const header = document.querySelector("[data-testid=site-header]");
  const onScroll = () => header.classList.toggle("is-compact", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Mobile menu and products dropdown.
  const toggle = document.querySelector("[data-testid=site-header-menu-toggle]");
  const nav = document.querySelector("[data-testid=site-header-nav]");
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  const productsBtn = document.querySelector("[data-testid=site-header-products]");
  const productsMenu = document.querySelector("[data-testid=site-header-products-menu]");
  productsBtn.addEventListener("click", () => {
    const open = productsMenu.hidden;
    productsMenu.hidden = !open;
    productsBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { productsMenu.hidden = true; productsBtn.setAttribute("aria-expanded", "false"); }
  });

  // A/B test: a random variant class on every load (styles are identical).
  const variant = "exp-" + Math.random().toString(36).slice(2, 8);
  document.body.classList.add(variant);
  document.querySelectorAll("[data-ab]").forEach((el) => el.classList.add(variant + "-" + (Math.random() < 0.5 ? "a" : "b")));

  // Fade sections in when they scroll into view.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
  }, { threshold: 0.15 });
  document.querySelectorAll(".fade-in").forEach((el) => io.observe(el));

  // Lazy images with a blur placeholder.
  document.querySelectorAll("img.lazy").forEach((img) => {
    const done = () => img.classList.add("is-loaded");
    if (img.complete && img.naturalWidth) done(); else img.addEventListener("load", done, { once: true });
  });

  // Relative dates in minutes, refreshed every 30 s. A <meta name="clock-skew"> moves the clock, so a test can serve
  // the same page as it reads a minute later.
  const skew = Number(document.querySelector("meta[name=clock-skew]")?.content ?? 0);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const relative = () => document.querySelectorAll("time[data-relative]").forEach((t) => {
    const minutes = Math.round((new Date(t.dateTime).getTime() - Date.now() - skew) / 60000);
    t.textContent = rtf.format(minutes, "minute");
  });
  relative();
  setInterval(relative, 30000);

  // Carousel: autoplay every 4 s, with previous and next buttons.
  const carousel = document.querySelector("[data-testid=review-carousel]");
  if (carousel) {
    const track = carousel.querySelector(".carousel-track");
    const slides = track.children.length;
    let index = 0;
    const go = (i) => { index = (i + slides) % slides; track.style.transform = `translateX(-${index * 100}%)`; carousel.querySelector("[aria-live]").textContent = `Review ${index + 1} of ${slides}`; };
    carousel.querySelector("[data-testid=review-carousel-prev]").addEventListener("click", () => go(index - 1));
    carousel.querySelector("[data-testid=review-carousel-next]").addEventListener("click", () => go(index + 1));
    setInterval(() => go(index + 1), 4000);
  }

  // Cookie banner: slides in 600 ms after load until accepted or rejected.
  const banner = document.querySelector("[data-testid=cookie-banner]");
  let consent = null;
  try { consent = localStorage.getItem("consent"); } catch {}
  if (!consent) {
    setTimeout(() => { banner.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => banner.classList.add("is-shown"))); }, 600);
  }
  const decide = (value) => { try { localStorage.setItem("consent", value); } catch {} banner.classList.remove("is-shown"); setTimeout(() => (banner.hidden = true), 400); };
  banner.querySelector("[data-testid=cookie-banner-accept]").addEventListener("click", () => decide("all"));
  banner.querySelector("[data-testid=cookie-banner-reject]").addEventListener("click", () => decide("essential"));

  // Newsletter modal 3 s after load, once per session.
  const modal = document.querySelector("[data-testid=newsletter-modal]");
  let seen = null;
  try { seen = sessionStorage.getItem("newsletter"); } catch {}
  if (!seen) setTimeout(() => { if (!modal.open) modal.showModal(); }, 3000);
  const close = () => { try { sessionStorage.setItem("newsletter", "1"); } catch {} modal.close(); };
  modal.querySelector("[data-testid=newsletter-modal-close]").addEventListener("click", close);
  modal.querySelector("[data-testid=newsletter-modal-form]").addEventListener("submit", (e) => { e.preventDefault(); close(); });
})();
