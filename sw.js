/*
 * Pocket Ebook Reader — Service Worker (Fase 3 roadmap: "PWA & offline mode")
 *
 * Tujuan: setelah kunjungan pertama (online), aplikasi berjalan PENUH tanpa
 * internet — termasuk membuka buku dari Library (IndexedDB, bukan urusan SW)
 * dan PDF (chunk pdf.js + worker ikut di-precache).
 *
 * Berkas ini dilayani apa adanya dari public/. Saat `vite build`, plugin
 * build/pwaPrecachePlugin.ts mengganti dua penanda di bawah dengan daftar
 * berkas hasil build + id build. Tanpa build (mode dev), daftar kosong: SW
 * hanya menjalankan cache runtime dan TIDAK didaftarkan sama sekali oleh
 * aplikasi (lihat src/pwa/PwaController.ts) — dev server tak boleh di-cache.
 *
 * STRATEGI
 *  - Precache: setiap berkas build di-cache SAAT INSTALL, dengan kunci
 *    `url?__rev=<hash isi>`. Deploy baru hanya mengunduh berkas yang
 *    hash-nya berubah; sisanya dipakai ulang dari cache.
 *  - Navigasi: selalu dijawab dengan app shell (index.html) dari cache.
 *    Aplikasi ini SPA satu halaman, dan pembaruan datang lewat versi SW baru
 *    — bukan lewat memeriksa jaringan tiap membuka aplikasi.
 *  - Aset terprecache: cache-first.
 *  - Lainnya se-origin (GET): stale-while-revalidate di cache runtime.
 *  - Lintas-origin (mis. API terjemahan): TIDAK disentuh — gagalnya jaringan
 *    ditangani aplikasi sendiri (status subtitle "offline").
 *  - Pembaruan: SW baru menunggu (waiting) sampai pengguna memilih "Muat
 *    ulang" di aplikasi (pesan SKIP_WAITING). Tidak pernah memuat ulang
 *    halaman sendiri — pengguna mungkin sedang membaca.
 */
"use strict";

const PRECACHE_MANIFEST = [{"url":"apple-touch-icon.png","revision":"a0398f206438"},{"url":"assets/TranslationWorker-CU4Ar0pg.js","revision":"b004a6fe3fea"},{"url":"assets/index-DbF_XmzY.js","revision":"dbf863d5d1c2"},{"url":"assets/index-Si3amNmh.css","revision":"06387eb4950d"},{"url":"assets/ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm","revision":"c46655e8a94a"},{"url":"assets/pdf-onFs2SJT.js","revision":"aa42b5343f13"},{"url":"assets/pdf.worker-BgryrOlp.mjs","revision":"7c237f83fa56"},{"url":"favicon.svg","revision":"61bc9a161de5"},{"url":"icon-192.png","revision":"514356b39908"},{"url":"icon-512.png","revision":"3ecedcfb4320"},{"url":"icon-maskable-512.png","revision":"046a2275173f"},{"url":"icon.svg","revision":"3c0c811e1a00"},{"url":"icons.svg","revision":"b45fa506195c"},{"url":"index.html","revision":"89987d77b8d0"},{"url":"manifest.json","revision":"419c3bca7802"}];
const BUILD_ID = "294836d78e17";

// Awalan nama cache — dipakai UI penyimpanan (src/storage/StorageInfo.ts) untuk mengenali cache milik aplikasi ini.
const PREFIX = "pocket-reader-";
const PRECACHE = PREFIX + "precache";
const RUNTIME = PREFIX + "runtime";

const SCOPE = self.registration.scope;

function absoluteUrl(relative) {
  return new URL(relative, SCOPE).href;
}

function cacheKey(entry) {
  return absoluteUrl(entry.url) + "?__rev=" + entry.revision;
}

// url (tanpa query/hash) → kunci precache-nya.
const KEY_BY_URL = new Map();
let SHELL_KEY = null;
for (const entry of PRECACHE_MANIFEST) {
  const key = cacheKey(entry);
  KEY_BY_URL.set(absoluteUrl(entry.url), key);
  if (entry.url === "index.html") {
    SHELL_KEY = key;
    KEY_BY_URL.set(SCOPE, key); // "/" dan "/index.html" sama-sama app shell
  }
}
const EXPECTED_KEYS = new Set(PRECACHE_MANIFEST.map(cacheKey));

async function fetchFresh(entry) {
  // `reload` melewati cache HTTP browser: precache harus berisi versi yang benar-benar dari build ini.
  const response = await fetch(new Request(absoluteUrl(entry.url), { cache: "reload" }));
  if (!response.ok) throw new Error("Gagal mengunduh " + entry.url + " (" + response.status + ")");
  return response;
}

// --- Install: unduh yang belum ada. Gagal satu berkas = gagal seluruh install (SW lama tetap berjalan). ---
async function precacheMissing() {
  const cache = await caches.open(PRECACHE);
  const missing = [];
  for (const entry of PRECACHE_MANIFEST) {
    if (!(await cache.match(cacheKey(entry)))) missing.push(entry);
  }
  await Promise.all(
    missing.map(async (entry) => {
      await cache.put(cacheKey(entry), await fetchFresh(entry));
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheMissing());
});

// --- Activate: buang entri precache versi lama & ambil alih halaman yang sudah terbuka. ---
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      for (const request of await cache.keys()) {
        if (!EXPECTED_KEYS.has(request.url)) await cache.delete(request);
      }
      await self.clients.claim();
    })(),
  );
});

async function handleNavigation(request) {
  if (SHELL_KEY) {
    const shell = await (await caches.open(PRECACHE)).match(SHELL_KEY);
    if (shell) return shell;
  }
  return fetch(request);
}

async function cacheFirst(key, request) {
  const cache = await caches.open(PRECACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  // Terhapus (mis. pembersihan storage oleh browser): ambil dari jaringan & pulihkan.
  const response = await fetch(request);
  if (response.ok) await cache.put(key, response.clone());
  return response;
}

async function staleWhileRevalidate(event) {
  const request = event.request;
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    // Perbarui di belakang layar; jawab langsung dari cache. waitUntil menjaga SW tetap hidup sampai cache tertulis.
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  const key = KEY_BY_URL.get(url.origin + url.pathname);
  if (key) {
    event.respondWith(cacheFirst(key, request));
    return;
  }
  event.respondWith(staleWhileRevalidate(event));
});

// --- "Segarkan cache offline": unduh SEMUA berkas dulu, baru tukar isi cache. ---
// Bila unduhan gagal (mis. sedang offline), cache lama dibiarkan UTUH — membersihkan
// cache tanpa bisa mengisinya lagi akan mematikan mode offline.
async function refreshAll() {
  try {
    const fetched = await Promise.all(
      PRECACHE_MANIFEST.map(async (entry) => [cacheKey(entry), await fetchFresh(entry)]),
    );
    await caches.delete(RUNTIME);
    const cache = await caches.open(PRECACHE);
    for (const request of await cache.keys()) await cache.delete(request);
    for (const [key, response] of fetched) await cache.put(key, response);
    return true;
  } catch (error) {
    return false;
  }
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const reply = event.ports && event.ports[0];
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "REFRESH_PRECACHE") {
    event.waitUntil(
      refreshAll().then((ok) => {
        if (reply) reply.postMessage({ ok: ok });
      }),
    );
  } else if (data.type === "GET_BUILD_ID") {
    if (reply) reply.postMessage({ buildId: BUILD_ID });
  }
});
