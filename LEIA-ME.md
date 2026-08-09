# Caderno de Leitura

App pessoal para registar livros e guardar anotações, citações e fotos de páginas.
Funciona no browser, instala-se no telemóvel e guarda tudo no próprio dispositivo.

## Ficheiros

```
index.html        a página e a barra de navegação
css/style.css     o aspeto
js/db.js          base de dados (IndexedDB)
js/ocr.js         extração de texto das fotos (Tesseract)
js/app.js         os ecrãs e a lógica
manifest.json     nome, ícone e cores da app instalada
sw.js             faz a app funcionar sem rede
icons/            os ícones
```

## Pôr no telemóvel — passo a passo

A app precisa de estar num endereço `https://` para poder ser instalada. O GitHub
Pages faz isso de graça. Não é preciso instalar nada no computador.

### 1. Criar conta no GitHub
Vai a github.com e cria uma conta gratuita, se ainda não tiveres.

### 2. Criar o repositório
- Carrega no `+` no canto superior direito → **New repository**
- Nome: `caderno-leitura`
- Visibilidade: **Public** (o GitHub Pages gratuito só funciona em repositórios públicos)
- Não marques nenhuma das caixas de baixo
- **Create repository**

> O código fica visível para quem o procurar. Os teus livros e notas **não** —
> esses ficam guardados no teu telemóvel e nunca são enviados para lado nenhum.

### 3. Carregar os ficheiros
- Na página do repositório: **uploading an existing file**
- Descompacta primeiro o ficheiro `.zip` no teu computador
- Arrasta para a página o **conteúdo** da pasta: `index.html`, `manifest.json`,
  `sw.js`, e as pastas `css`, `js` e `icons`
- Não arrastes o `.zip` — tem de ir descompactado
- Em baixo, carrega em **Commit changes**

### 4. Ligar o GitHub Pages
- **Settings** (no topo do repositório) → **Pages** (menu da esquerda)
- Em *Source*, escolhe **Deploy from a branch**
- Branch: `main`, pasta: `/ (root)` → **Save**
- Espera 1 a 2 minutos e recarrega a página. Vai aparecer o endereço:
  `https://O-TEU-NOME.github.io/caderno-leitura/`

### 5. Instalar no telemóvel
- Abre esse endereço no **Chrome do Android**
- Menu `⋮` → **Instalar aplicação** (ou *Adicionar ao ecrã principal*)
- Fica um ícone no ecrã inicial e abre sem a barra do browser

### 6. Quando quiseres mudar alguma coisa
- No GitHub, abre o ficheiro → ícone do lápis → edita → **Commit changes**
- Se mudares `index.html`, `css` ou `js`, **aumenta o número em `CACHE_NAME`**
  dentro do `sw.js` (por exemplo `caderno-leitura-v2`). Sem isso o telemóvel
  continua a mostrar a versão antiga.

## Primeira utilização do OCR

Na primeira foto, o Tesseract descarrega cerca de 10 MB com os dados do
português. Demora e precisa de rede. A partir daí funciona offline.

## Cópias de segurança

Em **Dados** podes exportar tudo para um ficheiro JSON. Faz isso de vez em
quando: se limpares os dados do browser, as notas desaparecem.
