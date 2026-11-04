"use strict";

const CACHE_NAME = "shedshare-shell-v10";
const SHELL_URLS = ["/", "/style.css", "/script.js", "/listing-photo-selection.js", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => name.startsWith("shedshare-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name))
  )));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put("/", response.clone()));
      return response;
    }).catch(async () => (await caches.match("/")) || Response.error()));
    return;
  }

  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || "You have a new ShedShare update." }; }
    const title = payload.title || "ShedShare";
    const unreadCount = Math.max(0, Number(payload.unreadCount) || 0);
    if (unreadCount && self.navigator?.setAppBadge) await self.navigator.setAppBadge(unreadCount).catch(() => {});
    await self.registration.showNotification(title, {
      body: payload.body || "You have a new update.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: payload.notificationId ? `shedshare-${payload.notificationId}` : "shedshare-update",
      data: { url: payload.url || "/" }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        await client.focus();
        client.postMessage({ type: "open-notifications" });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
