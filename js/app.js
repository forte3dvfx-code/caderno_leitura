/* ==================================================================
   app.js — os ecrãs e a lógica

   JavaScript simples, sem frameworks. O funcionamento é:
   1. carrega livros e notas da base de dados para memória
   2. desenha o ecrã atual dentro da div #app
   3. quando algo muda, grava na base de dados e volta a desenhar

   Para uma app pessoal com centenas de notas isto é mais do que
   suficiente. Se um dia forem dezenas de milhares, muda-se.
   ================================================================== */

/* ---------------- Estado ---------------- */

const state = {
  view: "library",     // library | notes | add | settings
  filter: "reading",   // filtro da estante
  noteType: "all",     // filtro do caderno
  query: "",           // pesquisa no caderno
  openBookId: null,    // livro aberto
  editorBookId: null,  // a escrever nota para este livro
  searchResults: [],
  searchState: "idle",
  manualOpen: false,
};

let books = [];
let notes = [];
let deferredInstall = null; // guarda o convite de instalação do Android

const STATUS = {
  reading: "A ler",
  wishlist: "Quero ler",
  finished: "Lido",
  abandoned: "Abandonado",
};

/* ---------------- Utilitários ---------------- */

const $ = (sel) => document.querySelector(sel);
const app = () => $("#app");

const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const today = () => new Date().toISOString().slice(0, 10);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("pt-PT", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function initials(title) {
  return String(title)
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

let toastTimer = null;
function notify(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/* ---------------- Fotos ---------------- */

// Guarda os endereços temporários das imagens para os poder libertar
const photoUrls = new Map();

async function photoUrl(id) {
  if (photoUrls.has(id)) return photoUrls.get(id);
  const blob = await DB.getPhoto(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  photoUrls.set(id, url);
  return url;
}

function forgetPhoto(id) {
  if (photoUrls.has(id)) {
    URL.revokeObjectURL(photoUrls.get(id));
    photoUrls.delete(id);
  }
}

// Depois de desenhar, preenche as imagens que ficaram por carregar
async function fillPhotos() {
  const slots = app().querySelectorAll("img[data-photo-id]");
  for (const img of slots) {
    const url = await photoUrl(img.dataset.photoId);
    if (url) img.src = url;
  }
}

/**
 * Reduz a foto antes de a guardar. Uma foto de telemóvel tem 3-6 MB;
 * fica em 300-600 KB sem perder legibilidade. Mantenho 2000px de lado
 * maior porque o OCR precisa de ver bem as letras.
 */
function compressImage(file, maxSide = 2000, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Falhou a conversão"))),
          "image/jpeg",
          quality
        );
      };
      img.onerror = () => reject(new Error("Não consegui abrir a imagem"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Não consegui ler o ficheiro"));
    reader.readAsDataURL(file);
  });
}

/* ---------------- Carregar e desenhar ---------------- */

async function refresh() {
  books = await DB.getBooks();
  notes = await DB.getNotes();
  render();
}

function render() {
  // Marca o separador ativo
  document.querySelectorAll("#tabs .rt-tab").forEach((b) => {
    b.classList.toggle("rt-tab-on", b.dataset.view === state.view);
  });
  $("#tabs").hidden = !!(state.openBookId || state.editorBookId);

  if (state.editorBookId) {
    const book = books.find((b) => b.id === state.editorBookId);
    renderEditor(book);
    return;
  }
  if (state.openBookId) {
    const book = books.find((b) => b.id === state.openBookId);
    if (!book) {
      state.openBookId = null;
    } else {
      renderBook(book);
      return;
    }
  }
  if (state.view === "library") renderLibrary();
  else if (state.view === "notes") renderNotes();
  else if (state.view === "add") renderAdd();
  else renderSettings();
}

/* ---------------- Ecrã: Estante ---------------- */

function coverHtml(book, size) {
  if (book.cover) {
    return `<img class="rt-cover rt-cover-${size}" src="${esc(book.cover)}" alt=""
      onerror="this.outerHTML='<div class=\\'rt-cover rt-cover-${size} rt-cover-fallback\\'><span>${esc(initials(book.title))}</span></div>'">`;
  }
  return `<div class="rt-cover rt-cover-${size} rt-cover-fallback"><span>${esc(initials(book.title))}</span></div>`;
}

function renderLibrary() {
  const year = new Date().getFullYear();
  const finishedThisYear = books.filter(
    (b) => b.status === "finished" && b.finishedAt && b.finishedAt.startsWith(String(year))
  ).length;

  const shown = books
    .filter((b) => b.status === state.filter)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const chips = Object.entries(STATUS)
    .map(([key, label]) => {
      const n = books.filter((b) => b.status === key).length;
      return `<button class="rt-chip ${state.filter === key ? "rt-chip-on" : ""}" data-filter="${key}">
        ${label}${n ? ` <em>${n}</em>` : ""}</button>`;
    })
    .join("");

  const list = shown.length
    ? `<ul class="rt-list">${shown
        .map((b) => {
          const n = notes.filter((x) => x.bookId === b.id).length;
          return `<li><button class="rt-card" data-book="${b.id}">
            ${coverHtml(b, "md")}
            <div class="rt-card-body">
              <h2 class="rt-book-title">${esc(b.title)}</h2>
              <p class="rt-book-author">${esc(b.author)}</p>
              <p class="rt-note-count">${n === 0 ? "sem notas" : n + (n === 1 ? " nota" : " notas")}</p>
            </div>
          </button></li>`;
        })
        .join("")}</ul>`
    : `<div class="rt-empty"><p>Nada em "${STATUS[state.filter]}".</p>
       <button class="rt-btn rt-btn-primary" data-go="add">Procurar um livro</button></div>`;

  app().innerHTML = `
    <main class="rt-main">
      <header class="rt-header">
        <h1 class="rt-title">A minha estante</h1>
        <p class="rt-subtitle">${books.length} livros · ${notes.length} notas · ${finishedThisYear} lidos em ${year}</p>
      </header>
      <div class="rt-filters">${chips}</div>
      ${list}
    </main>`;

  app().querySelectorAll("[data-filter]").forEach((el) => {
    el.onclick = () => { state.filter = el.dataset.filter; render(); };
  });
  app().querySelectorAll("[data-book]").forEach((el) => {
    el.onclick = () => { state.openBookId = el.dataset.book; render(); };
  });
  const go = app().querySelector("[data-go]");
  if (go) go.onclick = () => { state.view = "add"; render(); };
}

/* ---------------- Ecrã: Caderno (todas as notas) ---------------- */

function noteBodyHtml(note) {
  return note.type === "quote"
    ? `<p class="rt-quote"><span class="rt-marker">${esc(note.text)}</span></p>`
    : `<p class="rt-note-text">${esc(note.text)}</p>`;
}

function photoHtml(note) {
  if (!note.hasPhoto) return "";
  return `<button class="rt-photo-btn" data-zoom="${note.id}">
    <img class="rt-photo" data-photo-id="${note.id}" alt="Foto da página"></button>`;
}

function renderNotes() {
  const titleOf = (id) => {
    const b = books.find((x) => x.id === id);
    return b ? b.title : "Livro removido";
  };
  const term = state.query.trim().toLowerCase();
  const shown = notes
    .filter((n) => (state.noteType === "all" ? true : n.type === state.noteType))
    .filter((n) =>
      !term
        ? true
        : n.text.toLowerCase().includes(term) || titleOf(n.bookId).toLowerCase().includes(term)
    )
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const chips = [["all", "Tudo"], ["quote", "Citações"], ["note", "Notas"]]
    .map(([k, label]) =>
      `<button class="rt-chip ${state.noteType === k ? "rt-chip-on" : ""}" data-ntype="${k}">${label}</button>`
    )
    .join("");

  const list = shown.length
    ? `<ul class="rt-notes">${shown
        .map(
          (n) => `<li class="rt-note"><div class="rt-note-main">
            <button class="rt-note-book" data-book="${n.bookId}">${esc(titleOf(n.bookId))}</button>
            ${noteBodyHtml(n)}
            ${photoHtml(n)}
            <span class="rt-meta">${n.page ? "pág. " + n.page + " · " : ""}${formatDate(n.createdAt)}</span>
          </div></li>`
        )
        .join("")}</ul>`
    : `<div class="rt-empty"><p>${term ? "Nada corresponde a essa pesquisa." : "O caderno ainda está vazio."}</p></div>`;

  app().innerHTML = `
    <main class="rt-main">
      <header class="rt-header">
        <h1 class="rt-title">O meu caderno</h1>
        <p class="rt-subtitle">Tudo o que apontaste, em todos os livros</p>
      </header>
      <input class="rt-input" id="noteSearch" placeholder="Procurar nas notas…" value="${esc(state.query)}">
      <div class="rt-filters rt-filters-tight">${chips}</div>
      ${list}
    </main>`;

  const input = $("#noteSearch");
  input.oninput = () => {
    state.query = input.value;
    const pos = input.selectionStart;
    render();
    const again = $("#noteSearch");
    again.focus();
    again.setSelectionRange(pos, pos);
  };
  app().querySelectorAll("[data-ntype]").forEach((el) => {
    el.onclick = () => { state.noteType = el.dataset.ntype; render(); };
  });
  app().querySelectorAll("[data-book]").forEach((el) => {
    el.onclick = () => { state.openBookId = el.dataset.book; render(); };
  });
  bindZoom();
  fillPhotos();
}

/* ---------------- Ecrã: Adicionar livro ---------------- */

function renderAdd() {
  let body = "";
  if (state.searchState === "searching") body = `<p class="rt-hint">A procurar…</p>`;
  if (state.searchState === "error")
    body = `<div class="rt-notice"><p>Não consegui chegar à Open Library. Se estiveres sem rede, adiciona o livro à mão.</p></div>`;
  if (state.searchState === "done" && state.searchResults.length === 0)
    body = `<div class="rt-notice"><p>Sem resultados. Tenta menos palavras.</p></div>`;
  if (state.searchResults.length) {
    body = `<ul class="rt-list">${state.searchResults
      .map(
        (b, i) => `<li><div class="rt-card rt-card-static">
          ${coverHtml(b, "sm")}
          <div class="rt-card-body">
            <h2 class="rt-book-title">${esc(b.title)}</h2>
            <p class="rt-book-author">${esc(b.author)}${b.year ? " · " + b.year : ""}</p>
            <div class="rt-add-actions">
              <button class="rt-mini" data-add="${i}" data-status="reading">A ler</button>
              <button class="rt-mini" data-add="${i}" data-status="wishlist">Quero ler</button>
              <button class="rt-mini" data-add="${i}" data-status="finished">Lido</button>
            </div>
          </div></div></li>`
      )
      .join("")}</ul>`;
  }

  const manual = state.manualOpen
    ? `<div class="rt-panel">
        <label class="rt-label" for="mTitle">Título</label>
        <input class="rt-input" id="mTitle">
        <label class="rt-label" for="mAuthor">Autor</label>
        <input class="rt-input" id="mAuthor">
        <div class="rt-add-actions rt-add-actions-wide">
          <button class="rt-mini" data-manual="reading">A ler</button>
          <button class="rt-mini" data-manual="wishlist">Quero ler</button>
          <button class="rt-mini" data-manual="finished">Lido</button>
        </div>
      </div>`
    : "";

  app().innerHTML = `
    <main class="rt-main">
      <header class="rt-header">
        <h1 class="rt-title">Adicionar livro</h1>
        <p class="rt-subtitle">Procura por título, autor ou ISBN</p>
      </header>
      <div class="rt-searchbar">
        <input class="rt-input" id="bookSearch" placeholder="Ex.: Saramago Ensaio sobre a cegueira">
        <button class="rt-btn rt-btn-primary" id="doSearch">Procurar</button>
      </div>
      ${body}
      <button class="rt-link" id="toggleManual">${state.manualOpen ? "Fechar" : "Não encontras? Adiciona à mão"}</button>
      ${manual}
    </main>`;

  const input = $("#bookSearch");
  $("#doSearch").onclick = () => searchBooks(input.value);
  input.onkeydown = (e) => { if (e.key === "Enter") searchBooks(input.value); };
  $("#toggleManual").onclick = () => { state.manualOpen = !state.manualOpen; render(); };

  app().querySelectorAll("[data-add]").forEach((el) => {
    el.onclick = () => addBook(state.searchResults[+el.dataset.add], el.dataset.status);
  });
  app().querySelectorAll("[data-manual]").forEach((el) => {
    el.onclick = () => {
      const title = $("#mTitle").value.trim();
      if (!title) { notify("Falta o título"); return; }
      addBook({ title, author: $("#mAuthor").value.trim() || "Autor desconhecido" }, el.dataset.manual);
    };
  });
}

async function searchBooks(query) {
  if (!query.trim()) return;
  state.searchState = "searching";
  state.searchResults = [];
  render();
  try {
    const url =
      "https://openlibrary.org/search.json?limit=12&fields=key,title,author_name,cover_i,first_publish_year,isbn&q=" +
      encodeURIComponent(query.trim());
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    state.searchResults = (json.docs || []).map((d) => ({
      title: d.title,
      author: (d.author_name && d.author_name[0]) || "Autor desconhecido",
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
      year: d.first_publish_year || null,
      isbn: (d.isbn && d.isbn[0]) || null,
    }));
    state.searchState = "done";
  } catch (e) {
    state.searchState = "error";
  }
  render();
}

async function addBook(found, status) {
  const now = new Date().toISOString();
  const book = {
    id: uid(),
    title: found.title,
    author: found.author,
    cover: found.cover || null,
    isbn: found.isbn || null,
    status,
    startedAt: status === "reading" ? today() : null,
    finishedAt: status === "finished" ? today() : null,
    createdAt: now,
    updatedAt: now,
  };
  await DB.putBook(book);
  notify(`"${book.title}" foi para a estante`);
  state.view = "library";
  state.filter = status;
  state.searchResults = [];
  state.searchState = "idle";
  state.manualOpen = false;
  await refresh();
}

/* ---------------- Ecrã: Livro ---------------- */

function renderBook(book) {
  const mine = notes
    .filter((n) => n.bookId === book.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const options = Object.entries(STATUS)
    .map(([k, v]) => `<option value="${k}" ${book.status === k ? "selected" : ""}>${v}</option>`)
    .join("");

  const list = mine.length
    ? `<ul class="rt-notes">${mine
        .map(
          (n) => `<li class="rt-note"><div class="rt-note-main">
            ${noteBodyHtml(n)}
            ${photoHtml(n)}
            <span class="rt-meta">${n.page ? "pág. " + n.page + " · " : ""}${formatDate(n.createdAt)}</span>
          </div>
          <button class="rt-icon-btn rt-icon-btn-quiet" data-delnote="${n.id}" aria-label="Apagar nota">&times;</button>
          </li>`
        )
        .join("")}</ul>`
    : `<p class="rt-hint">Fotografa uma página ou escreve à mão — fica tudo aqui.</p>`;

  app().innerHTML = `
    <main class="rt-main rt-detail">
      <button class="rt-back" id="back">&larr; Estante</button>
      <div class="rt-detail-head">
        ${coverHtml(book, "lg")}
        <div>
          <h1 class="rt-detail-title">${esc(book.title)}</h1>
          <p class="rt-book-author">${esc(book.author)}</p>
          <select class="rt-select" id="statusSel">${options}</select>
          ${book.finishedAt ? `<p class="rt-meta rt-meta-block">Terminado a ${formatDate(book.finishedAt)}</p>` : ""}
        </div>
      </div>
      <button class="rt-btn rt-btn-primary rt-btn-full" id="newNote">Nova nota</button>
      <h2 class="rt-section-title">${mine.length} ${mine.length === 1 ? "nota" : "notas"}</h2>
      ${list}
      <button class="rt-danger" id="delBook">Remover livro e as suas notas</button>
    </main>`;

  $("#back").onclick = () => { state.openBookId = null; render(); };
  $("#newNote").onclick = () => { state.editorBookId = book.id; render(); };
  $("#statusSel").onchange = async (e) => {
    const status = e.target.value;
    const patch = { ...book, status, updatedAt: new Date().toISOString() };
    if (status === "finished" && !patch.finishedAt) patch.finishedAt = today();
    if (status === "reading" && !patch.startedAt) patch.startedAt = today();
    await DB.putBook(patch);
    await refresh();
  };
  app().querySelectorAll("[data-delnote]").forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.delnote;
      forgetPhoto(id);
      await DB.deleteNote(id);
      await refresh();
    };
  });
  $("#delBook").onclick = async () => {
    if (!confirm("Apagar este livro e todas as suas notas?")) return;
    for (const n of mine) forgetPhoto(n.id);
    await DB.deleteBook(book.id);
    state.openBookId = null;
    await refresh();
  };
  bindZoom();
  fillPhotos();
}

/* ---------------- Ecrã: Nova nota ---------------- */

// Guardado fora do render para não se perder enquanto o OCR corre
let draft = { blob: null, url: null, type: "quote", keepPhoto: true };

function renderEditor(book) {
  app().innerHTML = `
    <main class="rt-main rt-detail">
      <button class="rt-back" id="back">&larr; ${esc(book ? book.title : "Voltar")}</button>
      <h1 class="rt-detail-title rt-mb">Nova nota</h1>

      <div class="rt-toggle">
        <button data-type="quote" class="${draft.type === "quote" ? "rt-toggle-on" : ""}">Citação</button>
        <button data-type="note" class="${draft.type === "note" ? "rt-toggle-on" : ""}">Nota minha</button>
      </div>

      <div id="photoArea"></div>
      <p class="rt-hint" id="ocrStatus" hidden></p>

      <label class="rt-label" for="noteText">Texto</label>
      <textarea class="rt-input rt-textarea" id="noteText" rows="8"
        placeholder="A passagem do livro — ou fotografa a página acima"></textarea>

      <label class="rt-label" for="notePage">Página (opcional)</label>
      <input class="rt-input" id="notePage" type="number" inputmode="numeric">

      <button class="rt-btn rt-btn-primary rt-btn-full" id="saveNote">Guardar nota</button>

      <input type="file" id="camInput" accept="image/*" capture="environment" hidden>
      <input type="file" id="galInput" accept="image/*" hidden>
    </main>`;

  renderPhotoArea();

  $("#back").onclick = () => { clearDraft(); state.editorBookId = null; render(); };
  app().querySelectorAll("[data-type]").forEach((el) => {
    el.onclick = () => {
      draft.type = el.dataset.type;
      app().querySelectorAll("[data-type]").forEach((x) =>
        x.classList.toggle("rt-toggle-on", x.dataset.type === draft.type)
      );
      $("#noteText").placeholder =
        draft.type === "quote"
          ? "A passagem do livro — ou fotografa a página acima"
          : "O que pensaste sobre isto?";
    };
  });
  $("#camInput").onchange = (e) => pickPhoto(e.target);
  $("#galInput").onchange = (e) => pickPhoto(e.target);
  $("#saveNote").onclick = () => saveNote(book);
}

function renderPhotoArea() {
  const area = $("#photoArea");
  if (!area) return;
  if (!draft.url) {
    area.innerHTML = `
      <div class="rt-pickers">
        <button class="rt-dropzone" id="useCam"><span>Tirar foto</span><small>Abre a câmara</small></button>
        <button class="rt-dropzone" id="useGal"><span>Escolher imagem</span><small>Da galeria</small></button>
      </div>`;
    $("#useCam").onclick = () => $("#camInput").click();
    $("#useGal").onclick = () => $("#galInput").click();
    return;
  }
  area.innerHTML = `
    <div class="rt-panel">
      <img class="rt-photo rt-photo-big" src="${draft.url}" alt="Página fotografada">
      <div class="rt-row rt-row-wrap">
        <button class="rt-btn" id="redoOcr">Extrair texto outra vez</button>
        <button class="rt-btn" id="useCam2">Repetir foto</button>
        <button class="rt-btn" id="dropPhoto">Remover</button>
      </div>
      <label class="rt-check">
        <input type="checkbox" id="keepPhoto" ${draft.keepPhoto ? "checked" : ""}>
        <span>Guardar a foto com a nota</span>
      </label>
    </div>`;
  $("#redoOcr").onclick = () => runOcr();
  $("#useCam2").onclick = () => $("#camInput").click();
  $("#dropPhoto").onclick = () => { clearDraft(); renderPhotoArea(); };
  $("#keepPhoto").onchange = (e) => { draft.keepPhoto = e.target.checked; };
}

function clearDraft() {
  if (draft.url) URL.revokeObjectURL(draft.url);
  draft = { blob: null, url: null, type: draft.type, keepPhoto: true };
}

async function pickPhoto(input) {
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  try {
    const blob = await compressImage(file);
    if (draft.url) URL.revokeObjectURL(draft.url);
    draft.blob = blob;
    draft.url = URL.createObjectURL(blob);
    draft.keepPhoto = true;
    renderPhotoArea();
    runOcr();
  } catch (err) {
    notify(err.message);
  }
}

async function runOcr() {
  if (!draft.blob) return;
  const status = $("#ocrStatus");
  status.hidden = false;
  status.textContent = "A preparar o motor de leitura…";
  try {
    const text = await OCR.extract(draft.blob, (msg, progress) => {
      const pct = progress ? ` ${Math.round(progress * 100)}%` : "";
      status.textContent = msg + pct;
    });
    const box = $("#noteText");
    box.value = box.value.trim() ? box.value.trim() + "\n\n" + text : text;
    status.textContent = "Texto extraído. Confere e corrige o que for preciso.";
  } catch (err) {
    status.textContent = err.message + " Podes escrever o texto à mão.";
  }
}

async function saveNote(book) {
  const text = $("#noteText").value.trim();
  const page = parseInt($("#notePage").value, 10) || null;
  if (!text && !draft.blob) { notify("A nota está vazia"); return; }

  const id = uid();
  const keep = !!(draft.blob && draft.keepPhoto);
  if (keep) await DB.putPhoto(id, draft.blob);

  await DB.putNote({
    id,
    bookId: book.id,
    type: draft.type,
    text,
    page,
    hasPhoto: keep,
    createdAt: new Date().toISOString(),
  });
  await DB.putBook({ ...book, updatedAt: new Date().toISOString() });

  clearDraft();
  state.editorBookId = null;
  notify("Nota guardada");
  await refresh();
}

/* ---------------- Ecrã: Dados ---------------- */

function renderSettings() {
  const withPhotos = notes.filter((n) => n.hasPhoto).length;

  app().innerHTML = `
    <main class="rt-main">
      <header class="rt-header">
        <h1 class="rt-title">Os meus dados</h1>
        <p class="rt-subtitle">${books.length} livros · ${notes.length} notas · ${withPhotos} com foto</p>
      </header>

      <div class="rt-panel">
        <p class="rt-hint">Tudo fica neste dispositivo. O ficheiro só com texto é pequeno
        e serve para cópias frequentes; o completo inclui as fotos e fica grande depressa.</p>
        <button class="rt-btn rt-btn-full" id="expText">Exportar só o texto</button>
        <button class="rt-btn rt-btn-full" id="expAll">Exportar tudo, com fotos</button>
        <button class="rt-btn rt-btn-full" id="imp">Importar JSON</button>
        <input type="file" id="impInput" accept="application/json" hidden>
        <p class="rt-hint" id="usage"></p>
      </div>

      <h2 class="rt-section-title">Instalação</h2>
      <div class="rt-panel">
        <p class="rt-hint" id="installHint">A verificar…</p>
        <button class="rt-btn rt-btn-full" id="install" hidden>Instalar no telemóvel</button>
      </div>

      <h2 class="rt-section-title">Testes</h2>
      <div class="rt-panel">
        <p class="rt-hint">Enche a estante com oito livros e três notas, para experimentares
        os ecrãs sem escrever tudo à mão.</p>
        <button class="rt-btn rt-btn-full" id="demo">Carregar exemplos</button>
        <button class="rt-danger" id="wipe">Apagar tudo e recomeçar</button>
      </div>
    </main>`;

  $("#expText").onclick = async () => {
    downloadJson(await DB.exportData(false), `leituras-${today()}.json`);
    notify("Texto exportado");
  };
  $("#expAll").onclick = async () => {
    notify("A juntar as fotos…");
    downloadJson(await DB.exportData(true), `leituras-completo-${today()}.json`);
  };
  $("#imp").onclick = () => $("#impInput").click();
  $("#impInput").onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await DB.importData(JSON.parse(reader.result));
        notify("Dados importados");
        await refresh();
      } catch (err) {
        notify("Ficheiro inválido");
      }
    };
    reader.readAsText(file);
  };
  $("#demo").onclick = async () => {
    const demo = demoData();
    for (const b of demo.books) await DB.putBook(b);
    for (const n of demo.notes) await DB.putNote(n);
    notify("Exemplos carregados");
    await refresh();
  };
  $("#wipe").onclick = async () => {
    if (!confirm("Apagar todos os livros, notas e fotos?")) return;
    photoUrls.forEach((url) => URL.revokeObjectURL(url));
    photoUrls.clear();
    await DB.clearAll();
    notify("Tudo apagado");
    await refresh();
  };

  // Espaço ocupado
  DB.usage().then((bytes) => {
    const el = $("#usage");
    if (el && bytes != null) {
      el.textContent = `Ocupado neste dispositivo: ${(bytes / 1048576).toFixed(1)} MB.`;
    }
  });

  // Botão de instalação, se o browser o oferecer
  const hint = $("#installHint");
  const btn = $("#install");
  if (window.matchMedia("(display-mode: standalone)").matches) {
    hint.textContent = "Já estás a usar a app instalada.";
  } else if (deferredInstall) {
    hint.textContent = "Instala para teres o ícone no ecrã inicial e funcionar sem rede.";
    btn.hidden = false;
    btn.onclick = async () => {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      btn.hidden = true;
    };
  } else {
    hint.textContent =
      "Para instalar: menu do browser (⋮) → 'Adicionar ao ecrã principal' ou 'Instalar aplicação'.";
  }
}

function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- Dados de exemplo ---------------- */

function demoData() {
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const dayOnly = (d) => daysAgo(d).slice(0, 10);
  const mk = (title, author, status, age, started, finished) => ({
    id: uid(), title, author, cover: null, isbn: null, status,
    startedAt: started != null ? dayOnly(started) : null,
    finishedAt: finished != null ? dayOnly(finished) : null,
    createdAt: daysAgo(age), updatedAt: daysAgo(age),
  });

  const books = [
    mk("Livro do Desassossego", "Bernardo Soares / Fernando Pessoa", "reading", 2, 40),
    mk("O Deserto dos Tártaros", "Dino Buzzati", "reading", 5, 12),
    mk("Ensaio sobre a Cegueira", "José Saramago", "finished", 20, 90, 25),
    mk("Os Maias", "Eça de Queirós", "finished", 60, 200, 70),
    mk("Sapiens", "Yuval Noah Harari", "finished", 120, 180, 130),
    mk("Memorial do Convento", "José Saramago", "wishlist", 8),
    mk("Cem Anos de Solidão", "Gabriel García Márquez", "wishlist", 15),
    mk("A Insustentável Leveza do Ser", "Milan Kundera", "abandoned", 45, 150),
  ];

  const notes = [
    { id: uid(), bookId: books[0].id, type: "quote", page: 112, hasPhoto: false, createdAt: daysAgo(2),
      text: "Assim é que uma citação aparece: com o marcador amarelo por baixo, como se a tivesses sublinhado no papel." },
    { id: uid(), bookId: books[0].id, type: "note", page: null, hasPhoto: false, createdAt: daysAgo(3),
      text: "Ler aos poucos, meia dúzia de fragmentos de cada vez. De seguida perde o efeito." },
    { id: uid(), bookId: books[2].id, type: "note", page: 78, hasPhoto: false, createdAt: daysAgo(30),
      text: "A cegueira como metáfora do que a sociedade escolhe não ver. Reler o capítulo da quarentena." },
  ];

  return { books, notes };
}

/* ---------------- Foto em grande ---------------- */

function bindZoom() {
  app().querySelectorAll("[data-zoom]").forEach((el) => {
    el.onclick = async () => {
      const url = await photoUrl(el.dataset.zoom);
      if (!url) return;
      $("#lightboxImg").src = url;
      $("#lightbox").hidden = false;
    };
  });
}

/* ---------------- Arranque ---------------- */

document.querySelectorAll("#tabs .rt-tab").forEach((btn) => {
  btn.onclick = () => {
    state.view = btn.dataset.view;
    state.openBookId = null;
    render();
  };
});

$("#lightbox").onclick = () => { $("#lightbox").hidden = true; };

// O Android avisa quando a app pode ser instalada; guardamos o convite
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
});

// Service worker: é o que faz a app funcionar sem rede
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      console.warn("Service worker não registado (normal se abrires o ficheiro localmente)");
    });
  });
}

refresh();
