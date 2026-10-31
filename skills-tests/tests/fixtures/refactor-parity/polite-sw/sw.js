// Answers ./probe itself after an analytics hit and a POST beacon, so neither request comes from the page.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  if (!new URL(event.request.url).pathname.endsWith("/probe")) return;
  event.respondWith(
    (async () => {
      const sent = [];
      for (const [url, init] of [
        ["/_vercel/insights/sw", undefined],
        ["/polite-sw/beacon", { method: "POST", body: "event=view" }],
      ]) {
        try {
          await fetch(url, init);
          sent.push("ok");
        } catch {
          sent.push("blocked");
        }
      }
      return new Response(sent.join(","));
    })(),
  );
});
