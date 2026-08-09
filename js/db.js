/* ==================================================================
   db.js — tudo o que toca no armazenamento

   Usa IndexedDB, que é a base de dados que vive dentro do browser.
   Ao contrário do localStorage, aguenta imagens e centenas de MB.

   Três "armazéns" (o equivalente a tabelas):
     books   → { id, title, author, cover, isbn, status,
                 startedAt, finishedAt, createdAt, updatedAt }
     notes   → { id, bookId, type, text, page, hasPhoto, createdAt }
     photos  → { id, blob }   (id igual ao id da nota)

   As fotos ficam num armazém à parte para que ler a lista de notas
   não tenha de arrastar megabytes de imagens.
   ================================================================== */

const DB = (function () {
  const DB_NAME = "leitura";
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("books")) {
          db.createObjectStore("books", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("notes")) {
          const notes = db.createObjectStore("notes", { keyPath: "id" });
          notes.createIndex("bookId", "bookId", { unique: false });
        }
        if (!db.objectStoreNames.contains("photos")) {
          db.createObjectStore("photos", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // Envolve um pedido do IndexedDB numa promessa, para podermos usar await
  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  async function getAll(name) {
    return wrap((await store(name, "readonly")).getAll());
  }

  async function put(name, value) {
    return wrap((await store(name, "readwrite")).put(value));
  }

  async function remove(name, key) {
    return wrap((await store(name, "readwrite")).delete(key));
  }

  async function get(name, key) {
    return wrap((await store(name, "readonly")).get(key));
  }

  /* ---------- Livros ---------- */

  const getBooks = () => getAll("books");
  const putBook = (book) => put("books", book);

  async function deleteBook(bookId) {
    const notes = await getNotesOf(bookId);
    for (const n of notes) await deleteNote(n.id);
    await remove("books", bookId);
  }

  /* ---------- Notas ---------- */

  const getNotes = () => getAll("notes");
  const putNote = (note) => put("notes", note);

  async function getNotesOf(bookId) {
    const s = await store("notes", "readonly");
    return wrap(s.index("bookId").getAll(bookId));
  }

  async function deleteNote(noteId) {
    await remove("photos", noteId); // apaga a foto junto com a nota
    await remove("notes", noteId);
  }

  /* ---------- Fotos ---------- */

  const putPhoto = (id, blob) => put("photos", { id, blob });

  async function getPhoto(id) {
    const row = await get("photos", id);
    return row ? row.blob : null;
  }

  /* ---------- Exportar e importar ---------- */

  // Converte um Blob para texto base64, para caber num ficheiro JSON
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function base64ToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
  }

  async function exportData(withPhotos) {
    const out = {
      format: "caderno-leitura",
      version: 1,
      exportedAt: new Date().toISOString(),
      books: await getBooks(),
      notes: await getNotes(),
    };
    if (withPhotos) {
      out.photos = {};
      const rows = await getAll("photos");
      for (const row of rows) {
        out.photos[row.id] = await blobToBase64(row.blob);
      }
    }
    return out;
  }

  async function importData(data) {
    if (!data || !Array.isArray(data.books)) {
      throw new Error("Este ficheiro não tem o formato esperado");
    }
    for (const b of data.books) await putBook(b);
    for (const n of data.notes || []) await putNote(n);
    if (data.photos) {
      for (const [id, dataUrl] of Object.entries(data.photos)) {
        await putPhoto(id, await base64ToBlob(dataUrl));
      }
    }
  }

  async function clearAll() {
    const db = await open();
    const tx = db.transaction(["books", "notes", "photos"], "readwrite");
    tx.objectStore("books").clear();
    tx.objectStore("notes").clear();
    tx.objectStore("photos").clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Quanto espaço a app está a ocupar (aproximado, dado pelo browser)
  async function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const est = await navigator.storage.estimate();
    return est.usage || 0;
  }

  return {
    getBooks, putBook, deleteBook,
    getNotes, getNotesOf, putNote, deleteNote,
    putPhoto, getPhoto,
    exportData, importData, clearAll, usage,
  };
})();
