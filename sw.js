/* ==================================================================
   sw.js — o service worker

   É um pequeno programa que fica entre a app e a rede. Guarda cópias
   dos ficheiros para a app funcionar sem ligação.

   ESTRATÉGIA, e a razão dela:

   - Ficheiros da app (HTML, CSS, JS): REDE PRIMEIRO, cache como recurso.
     A versão anterior fazia o contrário, e o resultado era ficar preso a
     código antigo mesmo depois de publicar ficheiros novos. Assim, com
     rede tens sempre a versão mais recente; sem rede, tens a última que
     ficou guardada.

   - Imagens externas (capas): CACHE PRIMEIRO. São imutáveis e pesadas;
     não faz sentido ir buscá-las à rede de cada vez.

   Continua a valer a pena aumentar CACHE_NAME quando publicas ficheiros
   novos, mas já não é isso que decide se a atualização chega.
   ================================================================== */

const CACHE_NAME = "caderno-leitura-v15";

const APP_FILES = [
  "./",
  "index.html",
  "css/style.css",
  "js/db.js",
  "js/covers.js",
  "js/drive.js",
  "js/app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES))
  );
  self.skipWaiting();  // entra em vigor sem esperar que feches a app
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // A pesquisa de livros precisa sempre de dados frescos
  if (
    url.hostname === "openlibrary.org" ||
    url.hostname.endsWith("googleapis.com") ||
    url.hostname.endsWith("google.com") ||
    url.hostname.endsWith("gstatic.com")
  ) return;

  if (sameOrigin) {
    // REDE PRIMEIRO: uma versão nova chega assim que existe
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          // Sem rede: usa a cópia guardada
          const cached = await caches.match(req);
          if (cached) return cached;
          if (req.mode === "navigate") {
            const index = await caches.match("index.html");
            if (index) return index;
          }
          return new Response("", { status: 504 });
        })
    );
    return;
  }

  // CACHE PRIMEIRO para o que vem de fora (capas): não muda e é pesado
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => new Response("", { status: 504 }));
    })
  );
});
