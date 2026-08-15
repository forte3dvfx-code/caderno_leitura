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
  ownFilter: "all",    // all | physical | digital | unread_owned
  bookQuery: "",       // pesquisa na estante
  bookSort: "recent",  // ordenação da estante
  noteType: "all",     // filtro do caderno
  query: "",           // pesquisa no caderno
  bookNoteOrder: "asc",  // dentro de um livro: pela ordem em que foram escritas
  allNoteOrder: "desc",  // no caderno geral: as mais recentes primeiro
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

// Os três tipos de nota, com os mesmos nomes do Bookmory.
// "note" é o tipo antigo, de antes desta separação: tratamo-lo como
// pensamento para não haver notas órfãs.
const NOTE_TYPES = {
  quote: "Citação",
  summary: "Resumo",
  thought: "Pensamento",
};

// Posse: independente do estado de leitura, de propósito. Um livro pode
// estar "Lido" e continuar a ser teu, em papel, na prateleira.
const OWNERSHIP = {
  none: "Não tenho",
  physical: "Tenho em papel",
  digital: "Tenho em digital",
};

function ownership(book) {
  return OWNERSHIP[book.ownership] ? book.ownership : "none";
}

function noteType(note) {
  return NOTE_TYPES[note.type] ? note.type : "thought";
}

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

// As notas mostram data e hora, como no Bookmory: numa sessão de leitura
// escrevem-se várias no mesmo dia e a hora é o que as distingue.
function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return (
    d.toLocaleDateString("pt-PT", { day: "2-digit", month: "short", year: "numeric" }) +
    ", " +
    d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })
  );
}

/**
 * Estrelas de avaliação. Desenha cinco estrelas vazias e por cima uma
 * camada cheia cortada à largura certa — assim meias estrelas (3,5)
 * aparecem corretamente, o que é preciso para os dados do Bookmory.
 * Com `interactive`, cada estrela é clicável.
 */
function starsHtml(rating, interactive) {
  const value = Number(rating) || 0;
  const pct = Math.max(0, Math.min(5, value)) / 5 * 100;
  const hits = interactive
    ? [1, 2, 3, 4, 5]
        .map((i) => `<button class="rt-star-hit" data-star="${i}"
          aria-label="${i} ${i === 1 ? "estrela" : "estrelas"}"></button>`)
        .join("")
    : "";
  return `<div class="rt-stars ${interactive ? "rt-stars-live" : ""}">
    <div class="rt-stars-bg">★★★★★</div>
    <div class="rt-stars-fill" style="width:${pct}%">★★★★★</div>
    ${hits}
  </div>`;
}

/**
 * Tira os acentos e passa a minúsculas, para a pesquisa funcionar como
 * se espera em português: "confissao" tem de encontrar "Confissão" e
 * "eca" tem de encontrar "Eça".
 */
function normalize(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
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

/* ---------------- Preferências ---------------- */

/*
 * As preferências ficam em localStorage e não no IndexedDB: são quatro
 * valores simples e não vale a pena a complicação de mais um armazém.
 * A contagem é por datas reais — se estiveres três semanas sem abrir a
 * app, à primeira abertura ela diz-te que já vais em 21 dias.
 */

const PREFS_KEY = "caderno-prefs";
const DEFAULT_PREFS = {
  backupDays: 14,     // 0 = nunca avisar
  lastBackupAt: null, // data da última exportação
  firstRunAt: null,   // referência para quem ainda nunca exportou
  snoozeUntil: null,  // adiado até esta data
};

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch (e) {
    return { ...DEFAULT_PREFS };
  }
}

let prefs = loadPrefs();

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn("Não consegui guardar as preferências", e);
  }
}

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function markBackupDone() {
  prefs.lastBackupAt = new Date().toISOString();
  prefs.snoozeUntil = null;
  savePrefs();
}

/* ---------------- Capas ---------------- */

// Endereços temporários das capas guardadas, para não ir buscar o mesmo
// blob à base de dados a cada redesenho
const coverUrls = new Map();
let localCovers = new Set();  // ids dos livros com capa guardada

async function refreshLocalCovers() {
  try {
    localCovers = new Set(await DB.coverIds());
  } catch (e) {
    localCovers = new Set();
  }
}

async function localCoverUrl(bookId) {
  if (coverUrls.has(bookId)) return coverUrls.get(bookId);
  const blob = await DB.getCover(bookId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  coverUrls.set(bookId, url);
  return url;
}

function forgetCover(bookId) {
  if (coverUrls.has(bookId)) {
    URL.revokeObjectURL(coverUrls.get(bookId));
    coverUrls.delete(bookId);
  }
  localCovers.delete(bookId);
}

// Preenche as capas locais depois de o ecrã estar desenhado
async function fillCovers() {
  const slots = app().querySelectorAll("img[data-cover-id]");
  for (const img of slots) {
    const url = await localCoverUrl(img.dataset.coverId);
    if (url) img.src = url;
  }
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
 * fica em 200-400 KB. 1600px no lado maior chega para ler o texto da
 * página ao ampliar, sem encher o telemóvel de imagens enormes.
 */
function compressImage(file, maxSide = 1600, quality = 0.8) {
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
  await refreshLocalCovers();
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
  const fallback = `<div class="rt-cover rt-cover-${size} rt-cover-fallback"><span>${esc(initials(book.title))}</span></div>`;
  // Capa guardada no dispositivo: preenchida logo a seguir por fillCovers
  if (book.id && localCovers.has(book.id)) {
    return `<img class="rt-cover rt-cover-${size}" data-cover-id="${book.id}" alt="">`;
  }
  if (book.cover) {
    // O que fazer se a imagem falhar é tratado em bindCoverFallbacks;
    // meter HTML dentro de um atributo onerror parte com as aspas
    return `<img class="rt-cover rt-cover-${size}" src="${esc(book.cover)}"
      data-fallback="${esc(initials(book.title))}" data-size="${size}" alt="">`;
  }
  return fallback;
}

/**
 * Troca por um retângulo com as iniciais qualquer capa que não carregue.
 * Corre depois de cada desenho do ecrã.
 */
function bindCoverFallbacks() {
  app().querySelectorAll("img[data-fallback]").forEach((img) => {
    const swap = () => {
      const div = document.createElement("div");
      div.className = `rt-cover rt-cover-${img.dataset.size} rt-cover-fallback`;
      const span = document.createElement("span");
      span.textContent = img.dataset.fallback;
      div.appendChild(span);
      if (img.parentNode) img.parentNode.replaceChild(div, img);
    };
    img.onerror = swap;
    // A imagem pode já ter falhado antes de chegarmos aqui
    if (img.complete && img.naturalWidth === 0) swap();
  });
}

const BOOK_SORTS = {
  recent: "Mais recentes",
  title: "Título",
  author: "Autor",
  rating: "Avaliação",
  finished: "Data de conclusão",
};

/**
 * Ordena os livros. O localeCompare com "pt" trata os acentos como se
 * espera num índice: Água antes de Azul, e não depois de Zebra.
 */
function sortBooks(list, mode) {
  const byTitle = (a, b) => a.title.localeCompare(b.title, "pt");
  const sorted = list.slice();
  if (mode === "title") sorted.sort(byTitle);
  else if (mode === "author") sorted.sort((a, b) => a.author.localeCompare(b.author, "pt") || byTitle(a, b));
  else if (mode === "rating") sorted.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || byTitle(a, b));
  else if (mode === "finished") {
    // Livros sem data de conclusão vão para o fim, não para o topo
    sorted.sort((a, b) => String(b.finishedAt || "").localeCompare(String(a.finishedAt || "")) || byTitle(a, b));
  } else sorted.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return sorted;
}

function renderLibrary() {
  const year = new Date().getFullYear();
  const finishedThisYear = books.filter(
    (b) => b.status === "finished" && b.finishedAt && b.finishedAt.startsWith(String(year))
  ).length;

  const term = normalize(state.bookQuery.trim());

  // Ao pesquisar, procura em toda a estante e não só no estado escolhido.
  // Caso contrário procuravas "Tolstoi" em "A ler" e não encontravas nada
  // por ele estar em "Lido" — que é exatamente quando a pesquisa falha.
  const searching = term.length > 0;

  // O filtro de posse corre em paralelo ao de estado. "unread_owned" é o
  // cruzamento das duas dimensões: livros que tens em casa e ainda não leste.
  function matchesOwn(b) {
    const own = ownership(b);
    if (state.ownFilter === "all") return true;
    if (state.ownFilter === "unread_owned") {
      return own !== "none" && b.status !== "finished" && b.status !== "abandoned";
    }
    return own === state.ownFilter;
  }

  // "Por ler em casa" ignora o estado escolhido: a pergunta é sobre a
  // prateleira, não sobre a gaveta em que o livro está arrumado
  const wholeShelf = searching || state.ownFilter === "unread_owned";
  const base = books
    .filter((b) =>
      searching
        ? normalize(b.title).includes(term) || normalize(b.author).includes(term)
        : wholeShelf || b.status === state.filter
    )
    .filter(matchesOwn);
  const shown = sortBooks(base, state.bookSort);

  const chips = Object.entries(STATUS)
    .map(([key, label]) => {
      const n = books.filter((b) => b.status === key).length;
      return `<button class="rt-chip ${!searching && !wholeShelf && state.filter === key ? "rt-chip-on" : ""}" data-filter="${key}">
        ${label}${n ? ` <em>${n}</em>` : ""}</button>`;
    })
    .join("");

  const unreadOwned = books.filter(
    (b) => ownership(b) !== "none" && b.status !== "finished" && b.status !== "abandoned"
  ).length;
  const ownChips = [
    ["all", "Todos"],
    ["unread_owned", "Por ler em casa"],
    ["physical", "Em papel"],
    ["digital", "Em digital"],
  ]
    .map(([k, label]) => {
      let n = 0;
      if (k === "unread_owned") n = unreadOwned;
      else if (k !== "all") n = books.filter((b) => ownership(b) === k).length;
      return `<button class="rt-chip rt-chip-own ${state.ownFilter === k ? "rt-chip-on" : ""}" data-own="${k}">${label}${n ? ` <em>${n}</em>` : ""}</button>`;
    })
    .join("");

  const sortOptions = Object.entries(BOOK_SORTS)
    .map(([k, label]) => `<option value="${k}" ${state.bookSort === k ? "selected" : ""}>${label}</option>`)
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
              ${Number(b.rating) ? starsHtml(b.rating, false) : ""}
              <p class="rt-note-count">${wholeShelf ? STATUS[b.status] + " · " : ""}${ownership(b) !== "none" ? OWNERSHIP[ownership(b)] + " · " : ""}${n === 0 ? "sem notas" : n + (n === 1 ? " nota" : " notas")}</p>
            </div>
          </button></li>`;
        })
        .join("")}</ul>`
    : searching
      ? `<div class="rt-empty"><p>Nenhum livro corresponde a "${esc(state.bookQuery)}".</p></div>`
      : state.ownFilter === "unread_owned"
        ? `<div class="rt-empty"><p>Não há livros teus por ler.</p>
           <p class="rt-hint">Marca um livro como "Tenho em papel" no ecrã dele.</p></div>`
        : state.ownFilter !== "all"
          ? `<div class="rt-empty"><p>Nenhum livro marcado como "${OWNERSHIP[state.ownFilter]}".</p></div>`
          : `<div class="rt-empty"><p>Nada em "${STATUS[state.filter]}".</p>
             <button class="rt-btn rt-btn-primary" data-go="add">Procurar um livro</button></div>`;

  app().innerHTML = `
    <main class="rt-main">
      <header class="rt-header">
        <h1 class="rt-title">A minha estante</h1>
        <p class="rt-subtitle">${books.length} livros · ${notes.length} notas · ${finishedThisYear} lidos em ${year}</p>
      </header>
      <input class="rt-input" id="bookFilterSearch" placeholder="Procurar por título ou autor…" value="${esc(state.bookQuery)}">
      <div class="rt-filters">${chips}</div>
      <div class="rt-filters rt-filters-tight">${ownChips}</div>
      <div class="rt-sortbar">
        <span class="rt-meta">${searching ? shown.length + (shown.length === 1 ? " resultado" : " resultados") : "Ordenar por"}</span>
        <select class="rt-select" id="bookSort">${sortOptions}</select>
      </div>
      ${list}
    </main>`;

  const search = $("#bookFilterSearch");
  search.oninput = () => {
    state.bookQuery = search.value;
    const pos = search.selectionStart;
    render();
    const again = $("#bookFilterSearch");
    again.focus();
    again.setSelectionRange(pos, pos);
  };
  $("#bookSort").onchange = (e) => { state.bookSort = e.target.value; render(); };

  app().querySelectorAll("[data-own]").forEach((el) => {
    el.onclick = () => { state.ownFilter = el.dataset.own; render(); };
  });
  app().querySelectorAll("[data-filter]").forEach((el) => {
    el.onclick = () => {
      state.filter = el.dataset.filter;
      state.bookQuery = "";  // escolher um estado limpa a pesquisa
      if (state.ownFilter === "unread_owned") state.ownFilter = "all";
      render();
    };
  });
  app().querySelectorAll("[data-book]").forEach((el) => {
    el.onclick = () => { state.openBookId = el.dataset.book; render(); };
  });
  const go = app().querySelector("[data-go]");
  if (go) go.onclick = () => { state.view = "add"; render(); };
  fillCovers();
  bindCoverFallbacks();
}

/* ---------------- Ecrã: Caderno (todas as notas) ---------------- */

function noteBodyHtml(note) {
  const t = noteType(note);
  const badge = `<span class="rt-badge rt-badge-${t}">${NOTE_TYPES[t]}</span>`;
  const body =
    t === "quote"
      ? `<p class="rt-quote"><span class="rt-marker">${esc(note.text)}</span></p>`
      : `<p class="rt-note-text">${esc(note.text)}</p>`;
  return badge + body;
}

// Ordena as notas por data de criação, no sentido pedido.
// "asc" = pela ordem em que foram escritas, que é como se lê um diário
// de leitura. "desc" = as mais recentes no topo.
function sortNotes(list, order) {
  const sorted = list
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return order === "desc" ? sorted.reverse() : sorted;
}

function orderChipHtml(order, attr) {
  const label = order === "asc" ? "Mais antigas primeiro" : "Mais recentes primeiro";
  return `<div class="rt-filters rt-filters-tight">
    <button class="rt-chip" ${attr}>${label}</button></div>`;
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
  const filtered = notes
    .filter((n) => (state.noteType === "all" ? true : noteType(n) === state.noteType))
    .filter((n) =>
      !term
        ? true
        : n.text.toLowerCase().includes(term) || titleOf(n.bookId).toLowerCase().includes(term)
    );
  const shown = sortNotes(filtered, state.allNoteOrder);

  const chips = [["all", "Tudo"], ["quote", "Citações"], ["summary", "Resumos"], ["thought", "Pensamentos"]]
    .map(([k, label]) => {
      const n = k === "all" ? notes.length : notes.filter((x) => noteType(x) === k).length;
      return `<button class="rt-chip ${state.noteType === k ? "rt-chip-on" : ""}" data-ntype="${k}">${label}${n ? ` <em>${n}</em>` : ""}</button>`;
    })
    .join("");

  const list = shown.length
    ? `<ul class="rt-notes">${shown
        .map(
          (n) => `<li class="rt-note"><div class="rt-note-main">
            <button class="rt-note-book" data-book="${n.bookId}">${esc(titleOf(n.bookId))}</button>
            ${noteBodyHtml(n)}
            ${photoHtml(n)}
            <span class="rt-meta">${n.page ? "pág. " + n.page + " · " : ""}${formatDateTime(n.createdAt)}</span>
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
      ${orderChipHtml(state.allNoteOrder, 'data-allorder')}
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
  const allOrder = app().querySelector("[data-allorder]");
  if (allOrder) allOrder.onclick = () => {
    state.allNoteOrder = state.allNoteOrder === "asc" ? "desc" : "asc";
    render();
  };
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
  bindCoverFallbacks();
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
  const mine = sortNotes(
    notes.filter((n) => n.bookId === book.id),
    state.bookNoteOrder
  );

  const options = Object.entries(STATUS)
    .map(([k, v]) => `<option value="${k}" ${book.status === k ? "selected" : ""}>${v}</option>`)
    .join("");

  const ownOptions = Object.entries(OWNERSHIP)
    .map(([k, v]) => `<option value="${k}" ${ownership(book) === k ? "selected" : ""}>${v}</option>`)
    .join("");

  const list = mine.length
    ? `<ul class="rt-notes">${mine
        .map(
          (n) => `<li class="rt-note"><div class="rt-note-main">
            ${noteBodyHtml(n)}
            ${photoHtml(n)}
            <span class="rt-meta">${n.page ? "pág. " + n.page + " · " : ""}${formatDateTime(n.createdAt)}</span>
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
        <div class="rt-cover-slot">
          ${coverHtml(book, "lg")}
          ${book.cover ? "" : `<button class="rt-cover-find" id="findCover">Procurar capa</button>`}
        </div>
        <div>
          <h1 class="rt-detail-title">${esc(book.title)}</h1>
          <p class="rt-book-author">${esc(book.author)}</p>
          <select class="rt-select" id="statusSel">${options}</select>
          <select class="rt-select" id="ownSel">${ownOptions}</select>
          ${starsHtml(book.rating, true)}
          ${book.finishedAt ? `<p class="rt-meta rt-meta-block">Terminado a ${formatDate(book.finishedAt)}</p>` : ""}
        </div>
      </div>
      <button class="rt-btn rt-btn-primary rt-btn-full" id="newNote">Nova nota</button>
      <h2 class="rt-section-title">${mine.length} ${mine.length === 1 ? "nota" : "notas"}</h2>
      ${mine.length > 1 ? orderChipHtml(state.bookNoteOrder, "data-bookorder") : ""}
      ${list}
      <button class="rt-danger" id="delBook">Remover livro e as suas notas</button>
    </main>`;

  $("#back").onclick = () => { state.openBookId = null; render(); };
  $("#newNote").onclick = () => { state.editorBookId = book.id; render(); };
  const bookOrder = app().querySelector("[data-bookorder]");
  if (bookOrder) bookOrder.onclick = () => {
    state.bookNoteOrder = state.bookNoteOrder === "asc" ? "desc" : "asc";
    render();
  };
  $("#statusSel").onchange = async (e) => {
    const status = e.target.value;
    const patch = { ...book, status, updatedAt: new Date().toISOString() };
    if (status === "finished" && !patch.finishedAt) patch.finishedAt = today();
    if (status === "reading" && !patch.startedAt) patch.startedAt = today();
    await DB.putBook(patch);
    await refresh();
  };
  $("#ownSel").onchange = async (e) => {
    await DB.putBook({ ...book, ownership: e.target.value, updatedAt: new Date().toISOString() });
    await refresh();
  };
  const findCover = $("#findCover");
  if (findCover) findCover.onclick = () => searchCover(book, findCover);

  // Estrelas: tocar numa põe essa avaliação; tocar na atual limpa-a
  app().querySelectorAll("[data-star]").forEach((el) => {
    el.onclick = async () => {
      const value = Number(el.dataset.star);
      const rating = Number(book.rating) === value ? 0 : value;
      await DB.putBook({ ...book, rating, updatedAt: new Date().toISOString() });
      await refresh();
    };
  });
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
    forgetCover(book.id);
    await DB.deleteBook(book.id);
    state.openBookId = null;
    await refresh();
  };
  bindZoom();
  fillPhotos();
  fillCovers();
  bindCoverFallbacks();
}

/**
 * Procura a capa de um livro nas várias fontes e guarda-a no
 * dispositivo. Se o download falhar (acontece: nem todos os servidores
 * autorizam o browser a ler a imagem), fica pelo menos o endereço.
 */
async function searchCover(book, btn) {
  btn.disabled = true;
  btn.textContent = "A procurar…";
  try {
    const found = await Covers.findUrl(book);
    if (!found) {
      btn.disabled = false;
      btn.textContent = "Procurar capa";
      notify("Não encontrei capa em nenhuma fonte");
      return;
    }
    await DB.putBook({ ...book, cover: found.url, updatedAt: new Date().toISOString() });
    try {
      btn.textContent = "A guardar…";
      await Covers.download(book, found.url);
      forgetCover(book.id);
    } catch (e) {
      // Guardar falhou, mas o endereço serve enquanto houver rede
    }
    await refresh();
    notify(`Capa encontrada (${found.source})`);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Procurar capa";
    notify("Sem ligação para procurar capas");
  }
}

/* ---------------- Ecrã: Nova nota ---------------- */

// Guardado fora do render para a foto não se perder ao redesenhar o ecrã
let draft = { blob: null, url: null, type: "quote" };

const PLACEHOLDERS = {
  quote: "A passagem, tal como está no livro",
  summary: "O que este capítulo diz, por tuas palavras",
  thought: "O que pensaste sobre isto?",
};

function renderEditor(book) {
  app().innerHTML = `
    <main class="rt-main rt-detail">
      <button class="rt-back" id="back">&larr; ${esc(book ? book.title : "Voltar")}</button>
      <h1 class="rt-detail-title rt-mb">Nova nota</h1>

      <div class="rt-toggle">
        ${Object.entries(NOTE_TYPES)
          .map(([k, label]) =>
            `<button data-type="${k}" class="${draft.type === k ? "rt-toggle-on" : ""}">${label}</button>`
          )
          .join("")}
      </div>

      <div id="photoArea"></div>

      <label class="rt-label" for="noteText">Texto (opcional se tiveres foto)</label>
      <textarea class="rt-input rt-textarea" id="noteText" rows="6"
        placeholder="${esc(PLACEHOLDERS[draft.type])}"></textarea>

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
      $("#noteText").placeholder = PLACEHOLDERS[draft.type];
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
        <button class="rt-btn" id="useCam2">Repetir foto</button>
        <button class="rt-btn" id="useGal2">Outra imagem</button>
        <button class="rt-btn" id="dropPhoto">Remover</button>
      </div>
    </div>`;
  $("#useCam2").onclick = () => $("#camInput").click();
  $("#useGal2").onclick = () => $("#galInput").click();
  $("#dropPhoto").onclick = () => { clearDraft(); renderPhotoArea(); };
}

function clearDraft() {
  if (draft.url) URL.revokeObjectURL(draft.url);
  draft = { blob: null, url: null, type: draft.type };
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
    renderPhotoArea();
  } catch (err) {
    notify(err.message);
  }
}

async function saveNote(book) {
  const text = $("#noteText").value.trim();
  const page = parseInt($("#notePage").value, 10) || null;
  if (!text && !draft.blob) { notify("A nota está vazia"); return; }

  const id = uid();
  const keep = !!draft.blob;
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

/**
 * Envia o ficheiro para o menu de partilha do sistema (Drive, email, etc).
 * Só existe em HTTPS e em browsers que o suportem — no computador quase
 * nunca está disponível, por isso verificamos antes de mostrar o botão.
 */
function canShareFiles() {
  return !!(navigator.canShare && navigator.share);
}

async function shareBackup(withPhotos) {
  const data = await DB.exportData(withPhotos);
  const base = withPhotos ? `leituras-completo-${today()}` : `leituras-${today()}`;
  const body = JSON.stringify(data, null, 2);

  // Alguns Android recusam application/json na partilha e aceitam
  // text/plain. Tentamos os dois antes de desistir; a extensão .txt
  // acompanha o tipo para o sistema não estranhar.
  const attempts = [
    { name: base + ".json", type: "application/json" },
    { name: base + ".txt", type: "text/plain" },
  ];

  let lastError = null;
  for (const a of attempts) {
    const file = new File([body], a.name, { type: a.type });
    try {
      if (!navigator.canShare({ files: [file] })) continue;
      await navigator.share({ files: [file], title: "Caderno de Leitura" });
      markBackupDone();
      notify("Cópia enviada");
      return;
    } catch (e) {
      // O utilizador fechou o menu: não é falha nem é cópia feita
      if (e && e.name === "AbortError") return;
      lastError = e;
    }
  }

  downloadJson(data, base + ".json");
  markBackupDone();
  notify(
    lastError
      ? `A partilha falhou (${lastError.name || "erro"}); descarreguei o ficheiro`
      : "O teu browser não partilha ficheiros; descarreguei-o"
  );
}

/* ---------------- Aviso de cópia de segurança ---------------- */

/**
 * Mostra o aviso se já passaram os dias escolhidos desde a última
 * exportação. Corre uma vez por abertura da app.
 */
function maybeShowBackupReminder() {
  if (!prefs.backupDays) return;                 // avisos desligados
  if (books.length === 0 && notes.length === 0) return;  // nada a perder ainda

  // Quem ainda nunca exportou conta a partir do primeiro dia de uso
  if (!prefs.firstRunAt) {
    prefs.firstRunAt = new Date().toISOString();
    savePrefs();
  }
  if (prefs.snoozeUntil && Date.now() < new Date(prefs.snoozeUntil).getTime()) return;

  const days = daysSince(prefs.lastBackupAt || prefs.firstRunAt);
  if (days === null || days < prefs.backupDays) return;

  showBackupDialog(days, !prefs.lastBackupAt);
}

function showBackupDialog(days, never) {
  const wrap = document.createElement("div");
  wrap.className = "rt-modal";
  wrap.innerHTML = `
    <div class="rt-modal-box" role="dialog" aria-modal="true">
      <h2 class="rt-modal-title">Fazer uma cópia?</h2>
      <p class="rt-modal-text">
        ${never
          ? `Ainda não exportaste nada, e já lá vão ${days} dias.`
          : `A última cópia foi há <strong>${days} dias</strong>.`}
        Se limpares os dados do browser, ${books.length} livros e ${notes.length} notas
        desaparecem sem volta.
      </p>
      <button class="rt-btn rt-btn-primary rt-btn-full" id="mExport">${canShareFiles() ? "Enviar cópia" : "Exportar agora"}</button>
      <button class="rt-btn rt-btn-full" id="mSnooze">Lembrar amanhã</button>
      <button class="rt-link" id="mOff">Não voltar a avisar</button>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();

  wrap.querySelector("#mExport").onclick = async () => {
    const btn = wrap.querySelector("#mExport");
    btn.disabled = true;
    if (canShareFiles()) {
      await shareBackup(false);
    } else {
      downloadJson(await DB.exportData(false), `leituras-${today()}.json`);
      markBackupDone();
      notify("Cópia exportada");
    }
    close();
  };
  wrap.querySelector("#mSnooze").onclick = () => {
    prefs.snoozeUntil = new Date(Date.now() + 86400000).toISOString();
    savePrefs();
    close();
  };
  wrap.querySelector("#mOff").onclick = () => {
    prefs.backupDays = 0;
    savePrefs();
    close();
    notify("Avisos desligados. Podes voltar a ligá-los em Dados.");
  };
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
        <button class="rt-btn rt-btn-full" id="shareText" hidden>Enviar para o Drive, email…</button>
        <button class="rt-btn rt-btn-full" id="imp">Importar JSON</button>
        <input type="file" id="impInput" accept="application/json" hidden>
        <p class="rt-hint" id="usage"></p>
      </div>

      <h2 class="rt-section-title">Cópias de segurança</h2>
      <div class="rt-panel">
        <p class="rt-hint" id="backupState"></p>
        <label class="rt-label" for="backupDays">Avisar-me quando passarem</label>
        <select class="rt-select" id="backupDays">
          <option value="7">7 dias</option>
          <option value="14">14 dias</option>
          <option value="30">30 dias</option>
          <option value="60">60 dias</option>
          <option value="0">Nunca avisar</option>
        </select>
      </div>

      <h2 class="rt-section-title">Instalação</h2>
      <div class="rt-panel">
        <p class="rt-hint" id="installHint">A verificar…</p>
        <button class="rt-btn rt-btn-full" id="install" hidden>Instalar no telemóvel</button>
      </div>

      <h2 class="rt-section-title">Capas</h2>
      <div class="rt-panel">
        <p class="rt-hint" id="coverState"></p>
        <button class="rt-btn rt-btn-full" id="findCovers">Procurar capas em falta</button>
        <button class="rt-btn rt-btn-full" id="saveCovers">Guardar capas no telemóvel</button>
        <p class="rt-hint">Guardar as capas no telemóvel faz com que apareçam
        offline e deixem de depender de sites externos. Alguns servidores
        recusam — nesses casos fica o link.</p>
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
    markBackupDone();
    renderSettings();
    notify("Texto exportado");
  };
  $("#expAll").onclick = async () => {
    notify("A juntar as fotos…");
    downloadJson(await DB.exportData(true), `leituras-completo-${today()}.json`);
    markBackupDone();
    renderSettings();
  };

  // O botão de partilha só aparece onde o sistema o suporta — no
  // computador quase nunca, no Android quase sempre
  const shareBtn = $("#shareText");
  if (canShareFiles()) {
    shareBtn.hidden = false;
    shareBtn.onclick = async () => {
      shareBtn.disabled = true;
      await shareBackup(false);
      shareBtn.disabled = false;
      renderSettings();
    };
  }

  // Estado das cópias e escolha do intervalo
  const sel = $("#backupDays");
  sel.value = String(prefs.backupDays);
  sel.onchange = () => {
    prefs.backupDays = Number(sel.value);
    prefs.snoozeUntil = null;
    savePrefs();
    renderSettings();
    notify(prefs.backupDays ? `Aviso aos ${prefs.backupDays} dias` : "Avisos desligados");
  };
  const d = daysSince(prefs.lastBackupAt);
  $("#backupState").textContent = prefs.lastBackupAt
    ? `Última cópia: ${formatDate(prefs.lastBackupAt)} (há ${d} ${d === 1 ? "dia" : "dias"}).`
    : "Ainda não exportaste nenhuma cópia.";
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
  // Capas: procurar as que faltam e guardar no dispositivo as que só
  // existem como endereço externo
  const missing = books.filter((b) => !b.cover && !localCovers.has(b.id));
  const remoteOnly = books.filter((b) => b.cover && !localCovers.has(b.id));
  const coverState = $("#coverState");
  const coverBtn = $("#findCovers");
  const saveBtn = $("#saveCovers");

  const parts = [];
  if (localCovers.size) parts.push(`${localCovers.size} guardadas no telemóvel`);
  if (remoteOnly.length) parts.push(`${remoteOnly.length} só como link`);
  if (missing.length) parts.push(`${missing.length} sem capa`);
  coverState.textContent = parts.length ? parts.join(" · ") + "." : "Sem livros ainda.";

  coverBtn.disabled = missing.length === 0;
  coverBtn.textContent = `Procurar ${missing.length} capas em falta`;
  coverBtn.onclick = async () => {
    coverBtn.disabled = true;
    let found = 0;
    for (let i = 0; i < missing.length; i++) {
      const b = missing[i];
      coverBtn.textContent = `A procurar… ${i + 1}/${missing.length}`;
      try {
        const hit = await Covers.findUrl(b);
        if (hit) {
          await DB.putBook({ ...b, cover: hit.url, updatedAt: new Date().toISOString() });
          try {
            await Covers.download(b, hit.url);
            forgetCover(b.id);
          } catch (e) { /* fica o endereço */ }
          found++;
        }
      } catch (e) {
        break;  // sem rede: não vale a pena insistir
      }
      // Pausa entre livros: estes serviços são gratuitos e não é boa
      // educação martelá-los com dezenas de pedidos seguidos
      await new Promise((r) => setTimeout(r, 400));
    }
    await refresh();
    notify(found ? `${found} ${found === 1 ? "capa encontrada" : "capas encontradas"}` : "Nenhuma capa encontrada");
  };

  saveBtn.disabled = remoteOnly.length === 0;
  saveBtn.textContent = `Guardar ${remoteOnly.length} capas no telemóvel`;
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    let saved = 0, failed = 0;
    for (let i = 0; i < remoteOnly.length; i++) {
      const b = remoteOnly[i];
      saveBtn.textContent = `A guardar… ${i + 1}/${remoteOnly.length}`;
      try {
        await Covers.download(b, b.cover);
        forgetCover(b.id);
        saved++;
      } catch (e) {
        failed++;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    await refresh();
    notify(
      failed
        ? `${saved} guardadas, ${failed} recusadas pelo servidor`
        : `${saved} capas guardadas no telemóvel`
    );
  };

  $("#demo").onclick = async () => {
    const demo = demoData();
    for (const b of demo.books) await DB.putBook(b);
    for (const n of demo.notes) await DB.putNote(n);
    notify("Exemplos carregados");
    await refresh();
  };
  $("#wipe").onclick = async () => {
    if (!confirm("Apagar todos os livros, notas, fotos e capas?")) return;
    photoUrls.forEach((url) => URL.revokeObjectURL(url));
    photoUrls.clear();
    coverUrls.forEach((url) => URL.revokeObjectURL(url));
    coverUrls.clear();
    localCovers.clear();
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
  const mk = (title, author, status, age, started, finished, rating, own) => ({
    id: uid(), title, author, cover: null, isbn: null, status, rating: rating || 0,
    ownership: own || "none",
    startedAt: started != null ? dayOnly(started) : null,
    finishedAt: finished != null ? dayOnly(finished) : null,
    createdAt: daysAgo(age), updatedAt: daysAgo(age),
  });

  const books = [
    mk("Livro do Desassossego", "Bernardo Soares / Fernando Pessoa", "reading", 2, 40, 0, "physical"),
    mk("O Deserto dos Tártaros", "Dino Buzzati", "reading", 5, 12),
    mk("Ensaio sobre a Cegueira", "José Saramago", "finished", 20, 90, 25, 5),
    mk("Os Maias", "Eça de Queirós", "finished", 60, 200, 70, 4),
    mk("Sapiens", "Yuval Noah Harari", "finished", 120, 180, 130, 3.5),
    mk("Memorial do Convento", "José Saramago", "wishlist", 8, null, null, 0, "physical"),
    mk("Cem Anos de Solidão", "Gabriel García Márquez", "wishlist", 15, null, null, 0, "digital"),
    mk("A Insustentável Leveza do Ser", "Milan Kundera", "abandoned", 45, 150),
  ];

  const notes = [
    { id: uid(), bookId: books[0].id, type: "quote", page: 112, hasPhoto: false, createdAt: daysAgo(2),
      text: "Assim é que uma citação aparece: com o marcador amarelo por baixo, como se a tivesses sublinhado no papel." },
    { id: uid(), bookId: books[0].id, type: "thought", page: null, hasPhoto: false, createdAt: daysAgo(3),
      text: "Ler aos poucos, meia dúzia de fragmentos de cada vez. De seguida perde o efeito." },
    { id: uid(), bookId: books[2].id, type: "summary", page: 78, hasPhoto: false, createdAt: daysAgo(30),
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

// Pede ao browser para não deitar fora os dados quando o telemóvel ficar
// com pouco espaço. Não é garantia, mas reduz muito o risco.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persisted().then((already) => {
    if (!already) navigator.storage.persist();
  });
}

// Arranca a app e, uma vez por abertura, verifica se está na hora de
// fazer cópia de segurança
refresh().then(maybeShowBackupReminder);
