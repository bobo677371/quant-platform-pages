/* =============================================================================
 * quant-platform · PWA Service Worker
 *
 * 策略：
 *   外壳（HTML/CSS/JS/图标/manifest）→ 预缓存 + cache-first（离线也能打开）
 *   vendor/echarts.min.js           → 预缓存（大文件，避免每次回源）
 *   data/*.json                     → network-first，失败回退缓存（数据要新鲜，但断网不许白屏）
 *   导航请求                          → network-first，失败回退 index.html
 *
 * 升版本：只改 SW_VERSION 即可让旧缓存整体失效。
 * ========================================================================== */

const SW_VERSION = 'qp-pwa-v1.0.0';
const SHELL_CACHE = 'qp-shell-' + SW_VERSION;
const DATA_CACHE = 'qp-data-' + SW_VERSION;
const CACHE_PREFIXES = ['qp-shell-', 'qp-data-'];

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './vendor/echarts.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

const OFFLINE_HTML =
  '<!doctype html><meta charset="utf-8"><title>离线</title>' +
  '<p style="font-family:sans-serif;padding:24px;line-height:1.6">' +
  '离线且没有可用缓存。<br>请恢复网络后刷新一次，外壳与最近一次数据快照会被缓存。</p>';

/* ------------------------------------------------------------------ install */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.allSettled(
        SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
      ))
      .then(() => self.skipWaiting())
  );
});

/* ----------------------------------------------------------------- activate */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => CACHE_PREFIXES.some((p) => key.indexOf(p) === 0))
          .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* -------------------------------------------------------------------- fetch */
function isDataRequest(url) {
  return /\/data\/[^/]*\.json$/.test(url.pathname);
}

function isShellAsset(url, request) {
  if (request.mode === 'navigate') return true;
  const p = url.pathname;
  return (
    p.endsWith('/') ||
    p.endsWith('/index.html') ||
    p.endsWith('.css') ||
    p.endsWith('.js') ||
    p.endsWith('.webmanifest') ||
    p.endsWith('.png') ||
    p.endsWith('.ico') ||
    p.endsWith('.svg')
  );
}

function offlineNotFound(request) {
  if (request.mode === 'navigate') {
    return new Response(OFFLINE_HTML, {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
  return new Response('offline-no-cache', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

function putInCache(cacheName, request, response) {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(cacheName).then((cache) => cache.put(request, copy)).catch(() => {});
}

/* 数据：network-first，失败回退缓存 */
function handleData(request) {
  return fetch(request)
    .then((response) => {
      /* 404 也要透传给页面，让前端显示「该模块尚未生成」空态 */
      if (response.ok) putInCache(DATA_CACHE, request, response);
      return response;
    })
    .catch(() => caches.match(request).then((hit) => hit || offlineNotFound(request)));
}

/* 外壳：cache-first，同时后台更新（stale-while-revalidate） */
function handleShell(request) {
  return caches.match(request, { ignoreSearch: false }).then((hit) => {
    const network = fetch(request)
      .then((response) => {
        putInCache(SHELL_CACHE, request, response);
        return response;
      })
      .catch(() => null);

    if (hit) return hit;
    return network.then((response) => {
      if (response) return response;
      if (request.mode === 'navigate') {
        return caches.match('./index.html').then((idx) => idx || offlineNotFound(request));
      }
      return offlineNotFound(request);
    });
  });
}

/* 导航：network-first，失败回退 index.html（保证断网也能打开） */
function handleNavigation(request) {
  return fetch(request)
    .then((response) => {
      putInCache(SHELL_CACHE, request, response);
      return response;
    })
    .catch(() => caches.match(request).then((hit) =>
      hit || caches.match('./index.html').then((idx) => idx || offlineNotFound(request))
    ));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;

  if (isDataRequest(url)) {
    event.respondWith(handleData(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isShellAsset(url, request)) {
    event.respondWith(handleShell(request));
  }
});

/* 允许页面主动触发更新（保留接口，前端当前用 register 自带更新流程） */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
