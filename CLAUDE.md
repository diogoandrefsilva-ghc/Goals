# Goals — guia para o assistente

App pessoal de acompanhamento (jogos, golos, "estouro", amigos e dívidas).
**Sem build, sem npm.** Site estático (GitHub Pages), PWA. Sincroniza via **GitHub** (não tem Supabase).

## Estrutura
- `index.html` — **ficheiro único GRANDE (~2871 linhas)**: markup + CSS + JS tudo dentro. (É forte candidato a ser dividido em `index.html` + `app.js` + `style.css`, como já fiz no SplitBill e FestasBV — diz se queres.)
- `sw.js` — service worker (cache PWA).
- Não mexer: `apple-touch-icon.png`, `manifest.json`.

## Como NÃO gastar tokens à toa (crítico, é o maior ficheiro)
- **Não leias o `index.html` todo.** Está em secções com comentários `/* ── X ── */` e `<!-- ═══ X ═══ -->`. Faz `grep` pelo título e lê só essa. Secções principais:
  `DASHBOARD` · `ABA ESTOURO` · `DB` · `ÉPOCA NAV` · `CÁLCULOS` · `NAV` · **`JOGOS`** · `GOLOS COUNTER` · `MODAL EDITAR JOGO` · `AMIGOS` · `EXPORTAR DÍVIDAS` · **`GITHUB SYNC`** · `SEGURANÇA: TOKEN GITHUB` · `ESTOURO DOS GOLOS` · `FAB MENU` · `READ-ONLY MODE`
- Faz **edições cirúrgicas** (diffs pequenos). **Nunca reescrevas o ficheiro inteiro** (são 2871 linhas — seria carésimo).

## Regras técnicas (não partir a app)
- O JS está inline e há handlers `onclick="…"` → as funções têm de ser **globais** (não converter para module).
- **PWA/cache:** se alterares o HTML/CSS/JS, **sobe a versão do CACHE no `sw.js`**.
- **Sync GitHub:** o token é **introduzido pelo utilizador em runtime** (guardado em `localStorage`) — **não está no código, nunca o coloques hardcoded**. Os dados são gravados em `diogoandrefsilva-ghc/AppDataJSON` → `goals-data.json`. ⚠️ Esse repo é **público**.

## Deploy
GitHub Pages a partir de `main`. Um push para `main` publica.
