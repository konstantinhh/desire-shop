/* Минимальный сервис-воркер: нужен браузеру, чтобы предложить «Установить приложение».
   Страницы всегда берутся из сети; копия главной — только на случай пропавшего интернета. */
const CACHE = 'desire-shell-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.add('/')).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match('/')));
});
