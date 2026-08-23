/* ==================================================================
   drive.js — cópia de segurança no Google Drive

   Como funciona, em linguagem simples:

   1. Carregas em "Ligar ao Drive" e a Google pergunta-te se autorizas.
   2. Se autorizares, a Google devolve um bilhete (token) que vale uma
      hora e fica guardado só neste telemóvel.
   3. Com esse bilhete, a app cria uma pasta "Caderno de Leitura" no teu
      Drive e escreve lá um ficheiro. Nas vezes seguintes substitui o
      mesmo ficheiro, em vez de encher a pasta de cópias.
   4. Quando o bilhete expira, a app pede outro em silêncio — sem te
      voltar a perguntar nada, desde que continues com sessão iniciada
      na Google.

   O ID de cliente abaixo é público de propósito: identifica a app, não
   dá acesso a nada. Quem autoriza és tu, no ecrã da Google, e o âmbito
   drive.file faz com que a app só veja os ficheiros que ela criou — o
   resto do teu Drive é invisível para ela.
   ================================================================== */

const Drive = (function () {
  const CLIENT_ID = "110359919647-5mtubvedf2omr1b325t0aqcnccdq4es4.apps.googleusercontent.com";
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const FOLDER_NAME = "Caderno de Leitura";
  const FILE_NAME = "caderno-leitura.json";
  const STATE_KEY = "caderno-drive";

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;

  /* ---------------- Estado guardado ---------------- */

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveState(patch) {
    const next = { ...loadState(), ...patch };
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(next));
    } catch (e) {
      /* sem espaço: não é fatal */
    }
    return next;
  }

  const isLinked = () => !!loadState().linked;
  const lastUpload = () => loadState().lastUpload || null;

  function unlink() {
    accessToken = null;
    tokenExpiry = 0;
    saveState({ linked: false, fileId: null, folderId: null, lastUpload: null });
  }

  /* ---------------- Biblioteca da Google ---------------- */

  // Carrega o script da Google só quando é preciso, para a app continuar
  // a arrancar depressa e a funcionar offline sem ele
  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        return resolve();
      }
      const existing = document.getElementById("gis-script");
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("Falhou a carregar a Google")));
        return;
      }
      const s = document.createElement("script");
      s.id = "gis-script";
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Sem ligação à Google"));
      document.head.appendChild(s);
    });
  }

  /**
   * Obtém um bilhete de acesso.
   * @param {boolean} interactive true mostra o ecrã de autorização;
   *   false tenta em silêncio e falha se for preciso perguntar
   */
  async function getToken(interactive) {
    if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;

    await loadGis();
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: () => {},  // substituído em cada pedido
      });
    }

    return new Promise((resolve, reject) => {
      tokenClient.callback = (res) => {
        if (res.error) return reject(new Error(res.error));
        accessToken = res.access_token;
        tokenExpiry = Date.now() + (Number(res.expires_in) || 3600) * 1000;
        saveState({ linked: true });
        resolve(accessToken);
      };
      tokenClient.error_callback = (err) => {
        reject(new Error((err && err.type) || "Autorização cancelada"));
      };
      // prompt vazio = não perguntar se já houver consentimento dado
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    });
  }

  async function api(path, options = {}, interactive = false) {
    const token = await getToken(interactive);
    const res = await fetch(path, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: "Bearer " + token },
    });
    if (res.status === 401) {
      // Bilhete recusado: força um novo e tenta outra vez
      accessToken = null;
      const fresh = await getToken(interactive);
      return fetch(path, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: "Bearer " + fresh },
      });
    }
    return res;
  }

  /* ---------------- Pasta e ficheiro ---------------- */

  async function ensureFolder() {
    const state = loadState();
    if (state.folderId) {
      // Confirma que ainda existe: o utilizador pode tê-la apagado
      const check = await api(
        `https://www.googleapis.com/drive/v3/files/${state.folderId}?fields=id,trashed`
      );
      if (check.ok) {
        const info = await check.json();
        if (!info.trashed) return state.folderId;
      }
    }
    const res = await api("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    if (!res.ok) throw new Error("Não consegui criar a pasta no Drive");
    const folder = await res.json();
    saveState({ folderId: folder.id });
    return folder.id;
  }

  /**
   * Envia a cópia. Substitui o ficheiro anterior em vez de acumular
   * cópias: o Drive guarda o histórico de versões, portanto não perdes
   * as anteriores.
   */
  async function upload(data, interactive) {
    const body = JSON.stringify(data, null, 2);
    const state = loadState();
    const folderId = await ensureFolder();

    const metadata = state.fileId
      ? { name: FILE_NAME }
      : { name: FILE_NAME, parents: [folderId] };

    const boundary = "caderno" + Math.random().toString(36).slice(2);
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      body +
      `\r\n--${boundary}--`;

    const url = state.fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${state.fileId}?uploadType=multipart&fields=id`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";

    const res = await api(
      url,
      {
        method: state.fileId ? "PATCH" : "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body: multipart,
      },
      interactive
    );

    if (res.status === 404 && state.fileId) {
      // O ficheiro foi apagado no Drive: esquece o id e cria de novo
      saveState({ fileId: null });
      return upload(data, interactive);
    }
    if (!res.ok) throw new Error("O Drive recusou o envio (" + res.status + ")");

    const file = await res.json();
    saveState({
      fileId: file.id,
      lastUpload: new Date().toISOString(),
      size: body.length,
    });
    return { id: file.id, size: body.length };
  }

  /** Liga ao Drive pela primeira vez, com o ecrã de autorização. */
  async function connect() {
    await getToken(true);
    return true;
  }

  return { connect, upload, isLinked, lastUpload, unlink, loadState, FOLDER_NAME };
})();
