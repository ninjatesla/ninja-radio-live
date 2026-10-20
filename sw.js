// Ninja Radio PWA service worker
// Deliberately do not cache live HTML, API data, WebSocket traffic, or music.
self.addEventListener("install", (event) => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  // Pass requests through to the network so live state stays current.
});
