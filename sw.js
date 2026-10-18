'use strict';

/* ============================================================
 * 離線用的 Service Worker：網站自己的檔案先上網抓最新的，抓不到（沒網路）才用上次存的
 * 只處理這個網站的 GET；雲端 API、LINE、地圖、匯率這些外部網址一律不碰
 * version.json 用來檢查新版（見 app.js 的 checkForUpdate），永遠直接上網問
 * ============================================================ */

const CACHE = 'travel-shell-v1';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/config.js', 'js/app.js', 'js/shopping.js', 'js/ui.js', 'js/today.js', 'js/split.js', 'js/bookings.js', 'js/drag.js',
  'js/shopphoto.js', 'js/cloud.js', 'js/static.js', 'js/places.js', 'js/line.js', 'js/pwa.js', 'js/boot.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const NETWORK_WAIT_MS = 4000; // 網路很慢時，等這麼久還沒回來就先用存的

self.addEventListener('install', (e) => {
  // 一個檔案抓不到不要讓整個安裝失敗
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('/version.json')) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(stripSearch(req), res.clone());
    return res;
  });
  const cached = () => cache.match(stripSearch(req)).then((hit) => hit || (req.mode === 'navigate' ? cache.match('./') : undefined));
  try {
    return await Promise.race([net, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_WAIT_MS))]);
  } catch (err) {
    const hit = await cached();
    if (hit) return hit;
    return net; // 沒存過就繼續等網路（失敗就讓瀏覽器顯示錯誤）
  }
}

// ?trip=、?view= 這些參數不影響檔案內容，存的時候拿掉，離線時才找得到
function stripSearch(req) {
  const url = new URL(req.url);
  if (!url.search) return req;
  url.search = '';
  return new Request(url.toString());
}
