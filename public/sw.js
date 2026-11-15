'use strict';
// Service worker : permet d'ouvrir l'appli sans réseau et synchronise les actions en attente (Background Sync, quand le navigateur le permet).
importScripts('/idb.js');
const VERSION = 'v4'; // à changer quand les fichiers de l'appli évoluent (nettoie l'ancien cache)
const SHELL = 'topo-shell-' + VERSION, MEDIA = 'topo-media', FONTS = 'topo-fonts';
const SHELL_FILES = ['/', '/index.html', '/style.css', '/app.js', '/idb.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('topo-shell-') && k !== SHELL) await caches.delete(k);
  await self.clients.claim();
})()));

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function networkFirst(req) { // réseau d'abord (3 s max : réseau faible), sinon la copie du téléphone
  const cache = await caches.open(SHELL), key = req.mode === 'navigate' ? '/index.html' : req;
  try {
    const res = await withTimeout(fetch(req), 3000);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req, name, max = 150) {
  const cache = await caches.open(name), hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
  }
  return res;
}
async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name), hit = await cache.match(req);
  const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return; // les données sont gérées par l'appli (IndexedDB)
    if (url.pathname.startsWith('/media/')) {
      if (!/\.(jpg|png|webp)$/.test(url.pathname) || req.headers.has('range')) return; // vidéos : jamais en cache (trop lourdes)
      return e.respondWith(cacheFirst(req, MEDIA));
    }
    if (req.mode === 'navigate' || SHELL_FILES.includes(url.pathname)) return e.respondWith(networkFirst(req));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') e.respondWith(staleWhileRevalidate(req, FONTS));
});

// ---- Background Sync : envoie la file d'attente quand le réseau revient, même page fermée (Chrome / Android) ----
self.addEventListener('sync', e => { if (e.tag === 'topo-sync') e.waitUntil(flushQueue()); });
async function flushQueue() {
  const items = (await TopoDB.all('queue')).sort((a, b) => a.seq - b.seq);
  if (!items.length) return;
  const refused = [];
  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    const r = await fetch('/api/sync', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: chunk.map(({ seq, ...a }) => a) }) });
    if (r.status === 401) return;                    // pas connecté : la page reprendra la main à l'ouverture
    if (!r.ok) throw new Error('sync ' + r.status);  // le navigateur réessaiera plus tard
    for (const x of (await r.json()).results) {
      if (x.status === 'wrong_user' || x.status === 'error') continue; // on garde l'action
      if (x.status === 'rejected') refused.push(x.error || 'refusée');
      await TopoDB.del('queue', x.id);               // confirmée par le serveur : on la retire de la file
    }
  }
  if (refused.length) await TopoDB.put('kv', 'rejected', refused);
  for (const c of await self.clients.matchAll()) c.postMessage({ type: 'synced', refused: refused.length });
}
