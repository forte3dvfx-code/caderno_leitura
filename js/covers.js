/* ==================================================================
   covers.js — encontrar e guardar capas

   Duas responsabilidades separadas:
   1. PROCURAR o endereço de uma capa, tentando várias fontes por ordem
   2. DESCARREGAR essa imagem e guardá-la no dispositivo, para deixar de
      depender de sites externos que um dia mudam os endereços

   A ordem das fontes é deliberada: primeiro as que dão respostas exatas
   (ISBN), depois as que adivinham pelo título. A Google Books vem antes
   da procura por título na Open Library porque tem muito melhor
   cobertura de edições portuguesas e brasileiras.
   ================================================================== */

const Covers = (function () {

  /* ---------------- Procurar o endereço ---------------- */

  // 1. Open Library por ISBN — exato quando existe
  async function fromOpenLibraryIsbn(book) {
    if (!book.isbn) return null;
    // default=false faz devolver 404 quando não há capa, em vez de uma
    // imagem vazia de 1 pixel que passaria por boa
    const url = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(book.isbn)}-L.jpg?default=false`;
    const res = await fetch(url, { method: "HEAD" });
    return res.ok ? url : null;
  }

  // 2. Google Books — a melhor para edições portuguesas
  async function fromGoogleBooks(book) {
    const q = book.isbn
      ? `isbn:${book.isbn}`
      : `intitle:${book.title} inauthor:${firstAuthor(book.author)}`;
    const res = await fetch(
      `https://www.googleapis.com/books/v1/volumes?maxResults=3&q=${encodeURIComponent(q)}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    for (const item of json.items || []) {
      const links = item.volumeInfo && item.volumeInfo.imageLinks;
      if (!links) continue;
      // Pede a maior que houver; zoom=1 dá melhor qualidade que a miniatura
      const raw = links.thumbnail || links.smallThumbnail;
      if (raw) return raw.replace("http://", "https://").replace("&edge=curl", "");
    }
    return null;
  }

  // 3. Open Library por título
  async function fromOpenLibraryTitle(book) {
    const q = encodeURIComponent(`${book.title} ${firstAuthor(book.author)}`);
    const res = await fetch(
      `https://openlibrary.org/search.json?limit=3&fields=cover_i,title&q=${q}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    const hit = (json.docs || []).find((d) => d.cover_i);
    return hit ? `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg` : null;
  }

  // 4. Wikidata — apanha clássicos que as outras falham
  async function fromWikidata(book) {
    const url =
      "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language=pt&limit=3&search=" +
      encodeURIComponent(book.title);
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    for (const hit of json.search || []) {
      const d = await fetch(
        `https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&origin=*&property=P18&entity=${hit.id}`
      );
      if (!d.ok) continue;
      const claims = (await d.json()).claims;
      const img = claims && claims.P18 && claims.P18[0];
      const name = img && img.mainsnak && img.mainsnak.datavalue && img.mainsnak.datavalue.value;
      if (name) {
        return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=400`;
      }
    }
    return null;
  }

  // O campo de autor traz frequentemente tradutores e editores separados
  // por vírgula; para procurar, só o primeiro nome interessa
  function firstAuthor(author) {
    return String(author || "").split(",")[0].trim();
  }

  // A Google Books tem melhor cobertura de edições portuguesas, mas só
  // devolve miniaturas de 128px, que ficam desfocadas ao serem mostradas
  // em tamanho normal. A Open Library dá imagens grandes, por isso é a
  // única fonte usada. O código da Google Books ficou aqui em baixo,
  // desativado, caso um dia a cobertura pese mais que a nitidez.
  const SOURCES = [
    { name: "Open Library (ISBN)", fn: fromOpenLibraryIsbn },
    { name: "Open Library", fn: fromOpenLibraryTitle },
  ];

  /**
   * Procura o endereço de uma capa, parando na primeira fonte que
   * responda. Devolve { url, source } ou null.
   */
  async function findUrl(book) {
    for (const src of SOURCES) {
      try {
        const url = await src.fn(book);
        if (url) return { url, source: src.name };
      } catch (e) {
        // Uma fonte em baixo não impede as seguintes
      }
    }
    return null;
  }

  /* ---------------- Guardar no dispositivo ---------------- */

  /**
   * Descarrega a imagem e reduz o tamanho antes de guardar. As capas
   * originais variam entre 20 KB e 1 MB; depois disto ficam à volta de
   * 30 KB, o que dá uns 3 MB para uma estante de cem livros.
   */
  function shrink(blob, maxSide = 500, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.width;
        let h = img.height;
        if (!w || !h) return reject(new Error("Imagem inválida"));
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (out) => (out ? resolve(out) : reject(new Error("Falhou a conversão"))),
          "image/jpeg",
          quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Não consegui abrir a imagem"));
      };
      img.src = url;
    });
  }

  /**
   * Descarrega a capa de um endereço e guarda-a no dispositivo.
   * Pode falhar por CORS: nem todos os servidores autorizam que o
   * browser leia a imagem em vez de apenas a mostrar.
   */
  async function download(book, url) {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) throw new Error("Não é uma imagem");
    // Imagens minúsculas costumam ser marcadores de "sem capa"
    if (blob.size < 1200) throw new Error("Imagem vazia");
    const small = await shrink(blob);
    await DB.putCover(book.id, small);
    return small.size;
  }

  /**
   * Procura várias capas candidatas, para o utilizador escolher.
   * Sem ISBN, procurar por título devolve frequentemente a capa de um
   * livro homónimo — por isso é melhor mostrar opções do que adivinhar.
   * @returns {Promise<Array<{url, source, label}>>}
   */
  async function findCandidates(book, limit = 6) {
    const out = [];
    const seen = new Set();

    const add = (url, source, label) => {
      if (!url || seen.has(url) || out.length >= limit) return;
      seen.add(url);
      out.push({ url, source, label: label || "" });
    };

    // Pelo ISBN, quando existe: é a única via exata
    if (book.isbn) {
      try {
        const url = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(book.isbn)}-L.jpg?default=false`;
        const res = await fetch(url, { method: "HEAD" });
        if (res.ok) add(url, "ISBN", "Edição exata");
      } catch (e) { /* segue */ }
    }

    // Por título e autor: vários resultados, com o ano para ajudar a
    // distinguir edições
    try {
      const q = encodeURIComponent(`${book.title} ${firstAuthor(book.author)}`);
      const res = await fetch(
        `https://openlibrary.org/search.json?limit=10&fields=cover_i,title,author_name,first_publish_year,language&q=${q}`
      );
      if (res.ok) {
        const docs = ((await res.json()).docs || []).filter((d) => d.cover_i);
        // Edições em português primeiro: são as mais prováveis de serem
        // o livro que está mesmo na prateleira
        docs.sort((a, b) => {
          const pa = (a.language || []).includes("por") ? 0 : 1;
          const pb = (b.language || []).includes("por") ? 0 : 1;
          return pa - pb;
        });
        for (const d of docs) {
          const label = [
            (d.author_name && d.author_name[0]) || "",
            d.first_publish_year || "",
            (d.language || []).includes("por") ? "PT" : "",
          ]
            .filter(Boolean)
            .join(" · ");
          add(`https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`, "Open Library", label);
        }
      }
    } catch (e) { /* segue */ }

    return out;
  }

  /**
   * Guarda uma imagem escolhida pelo utilizador (foto da capa ou
   * ficheiro da galeria) como capa do livro. É a única via que garante
   * a edição certa, e a única que funciona para livros que nenhuma base
   * de dados conhece.
   */
  async function saveOwn(book, file) {
    if (!file.type.startsWith("image/")) throw new Error("Isso não é uma imagem");
    const small = await shrink(file, 700, 0.85);
    await DB.putCover(book.id, small);
    return small.size;
  }

  return { findUrl, findCandidates, download, saveOwn, shrink, SOURCES };
})();
