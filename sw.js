/* =====================================================================
   RÉVISIO — Service Worker PWA (v2)
   - Pré-cache l'app shell (page hors ligne, manifeste, logos, icônes)
   - Navigation : réseau d'abord, repli sur la dernière page connue, puis offline.html
   - Scripts / styles / JSON locaux : RÉSEAU D'ABORD (un déploiement est vu tout de suite)
   - Images / polices locales : cache d'abord (rapide, rarement modifiées)
   - CDN (unpkg, jsdelivr, cdnjs) : stale-while-revalidate
   - Ne touche JAMAIS aux appels /api/*, à Supabase, ni aux requêtes non-GET
   ===================================================================== */

const APP_VERSION = 'revisio-v4';          // ← à incrémenter pour forcer la purge des anciens caches
const SHELL_CACHE = `${APP_VERSION}-shell`;
const CDN_CACHE   = `${APP_VERSION}-cdn`;
const DATA_CACHE  = `${APP_VERSION}-data`;   // dernières listes de quiz (consultables hors ligne)
const MAX_DATA_ENTRIES = 10;

const SHELL_ASSETS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/favicon.png',
  '/site.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

const CDN_ORIGINS = [
  'https://unpkg.com',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com'
];

// ---------------- INSTALL : pré-cache, fichier par fichier (un absent n'annule pas tout)
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(SHELL_ASSETS.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch((err) => console.warn('[SW] non mis en cache :', url, err))
    ));
    await self.skipWaiting();
  })());
});

// ---------------- ACTIVATE : purge des anciennes versions
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(APP_VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---------------- FETCH
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;
  // Liste publique des quiz : réseau d'abord, puis dernière copie en cache si le téléphone est hors ligne
  if (url.origin === self.location.origin && url.pathname === '/api/quizzes') {
    event.respondWith(quizzesNetworkFirst(req));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/auth/')) return;
  if (url.hostname.endsWith('.supabase.co')) return;
  if (url.pathname === '/sw.js') return;            // laisser le navigateur gérer la mise à jour du SW

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req));
    return;
  }
  if (CDN_ORIGINS.includes(url.origin)) {
    event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
    return;
  }
  if (url.origin === self.location.origin) {
    const d = req.destination;                       // 'script', 'style', 'image', 'font', '' (fetch/json)…
    if (d === 'image' || d === 'font') event.respondWith(cacheFirst(req, SHELL_CACHE));
    else event.respondWith(networkFirst(req, SHELL_CACHE));
  }
});

// ---------------- STRATÉGIES
function dataKey(href) {
  const u = new URL(href);
  u.searchParams.delete('_');            // paramètre anti-cache de l'application : ignoré pour la clé
  u.searchParams.sort();
  return u.origin + u.pathname + u.search;
}

async function quizzesNetworkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  const key = dataKey(req.url);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      await cache.put(key, fresh.clone());
      const keys = await cache.keys();
      if (keys.length > MAX_DATA_ENTRIES) await cache.delete(keys[0]);
    }
    return fresh;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('X-From-Cache', '1');
      return new Response(await hit.blob(), { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: 'Hors ligne', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put('/', fresh.clone()).catch(() => {});
    return fresh;
  } catch (err) {
    return (await cache.match('/')) || (await cache.match('/offline.html')) || new Response('Hors ligne', { status: 503 });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (err) {
    return (await cache.match(req)) || new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const refresh = fetch(req)
    .then((fresh) => { if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {}); return fresh; })
    .catch(() => null);
  return cached || (await refresh) || new Response('', { status: 504 });
}

// ---------------- PUSH : affichage des notifications et clic
function safeUrl(u) {
  return (typeof u === 'string' && /^\/(?!\/)\S{0,299}$/.test(u)) ? u : '/';
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const options = {
    body: String(data.body || '').slice(0, 300),
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    lang: 'fr',
    data: { url: safeUrl(data.url) }
  };
  if (data.tag) { options.tag = String(data.tag).slice(0, 64); options.renotify = true; }
  event.waitUntil(self.registration.showNotification(String(data.title || 'Révisio').slice(0, 100), options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(safeUrl(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(target); } catch (e) {} }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// ---------------- MESSAGE : forcer la mise à jour depuis la page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
