/* ==================================================================
   ocr.js — extrair texto de uma foto

   Esta é a peça que vai ser substituída quando passarmos para Android
   (onde o ML Kit faz o mesmo, melhor e mais depressa). Está isolada de
   propósito: o resto da app só conhece a função OCR.extract().

   O Tesseract descarrega ~10 MB de dados do português na primeira
   utilização e guarda-os. A partir daí funciona sem rede.
   ================================================================== */

const OCR = (function () {
  let worker = null;

  // Cria o worker uma vez só; criá-lo é lento, reutilizá-lo é rápido
  async function getWorker(onProgress) {
    if (worker) return worker;
    if (typeof Tesseract === "undefined") {
      throw new Error("O motor de OCR não carregou. Verifica a ligação à rede.");
    }
    worker = await Tesseract.createWorker("por", 1, {
      logger: (m) => {
        if (!onProgress) return;
        if (m.status === "loading language traineddata" || m.status === "loading tesseract core") {
          onProgress("A preparar o português…", m.progress);
        } else if (m.status === "recognizing text") {
          onProgress("A ler a página…", m.progress);
        }
      },
    });
    return worker;
  }

  /**
   * Lê o texto de uma imagem.
   * @param {Blob} blob imagem já comprimida
   * @param {function} onProgress recebe (mensagem, 0..1)
   * @returns {Promise<string>} texto limpo
   */
  async function extract(blob, onProgress) {
    const w = await getWorker(onProgress);
    const result = await w.recognize(blob);
    const raw = (result && result.data && result.data.text) || "";
    const text = tidy(raw);
    if (!text) throw new Error("Não encontrei texto legível nesta foto");
    return text;
  }

  /**
   * O Tesseract devolve o texto linha a linha, tal como está na página.
   * Isto junta as linhas em parágrafos e cola as palavras que ficaram
   * cortadas por hífen no fim da linha.
   */
  function tidy(raw) {
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let out = "";
    for (const line of lines) {
      if (!out) {
        out = line;
      } else if (/[-\u2010\u2011]$/.test(out)) {
        out = out.slice(0, -1) + line; // palavra cortada: cola sem espaço
      } else if (/[.!?:»"]$/.test(out)) {
        out += "\n\n" + line; // fim de frase: parágrafo novo
      } else {
        out += " " + line;
      }
    }
    return out.trim();
  }

  // Liberta a memória quando já não é preciso
  async function dispose() {
    if (worker) {
      await worker.terminate();
      worker = null;
    }
  }

  return { extract, dispose };
})();
