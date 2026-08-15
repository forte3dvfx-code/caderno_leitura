/* ==================================================================
   sw.js — o service worker

   É um pequeno programa que fica entre a app e a rede. Guarda os
   ficheiros da app na primeira visita; nas seguintes serve-os do
   telemóvel, mesmo sem ligação.

   IMPORTANTE: sempre que mudares algum ficheiro da app, aumenta o
   número em CACHE_NAME. Caso contrário o telemóvel continua a mostrar
   a versão antiga.
   ================================================================== */

const CACHE_NAME = "caderno-leitura-v9";

const APP_FILES = [
  "./",
  "index.html",
  "css/style.css",
  "js/db.js",
  "js/app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// Instalação: guarda os ficheiros da app
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES))
  );
  self.skipWaiting();
});

// Ativação: deita fora as versões antigas da cache
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // A pesquisa de livros precisa sempre de dados frescos: nunca da cache
  if (url.hostname === "openlibrary.org") return;

  // As capas dos livros vêm de fora: guarda-as assim que chegarem,
  // para aparecerem offline na próxima vez
  const isExternal = url.origin !== self.location.origin;

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
        .catch(() => {
          // Sem rede e sem cópia guardada: devolve a página inicial
          if (!isExternal && req.mode === "navigate") return caches.match("index.html");
          return new Response("", { status: 504 });
        });
    })
  );
});
