// supabase/functions/calendario-sporting/index.ts
// Calendário oficial do Sporting CP (futebol masculino, equipa principal) lido
// com o Gemini + pesquisa Google, para as DUAS apps que dependem do mesmo
// calendário:
//   · Goals     — todos os jogos oficiais (casa, fora, campo neutro)
//   · SplitBill — só os que se jogam em Alvalade (filtro do lado da app)
//
// A função devolve SEMPRE a época inteira, sem filtrar por local nem por
// competição: quem filtra é cada app, conforme o que lhe interessa. Assim há um
// só prompt e uma só resposta para manter, e o SplitBill nunca fica com uma
// visão diferente da do Goals.
//
// A resposta tem TRÊS arrays:
//   · `jogos`      — jogos com adversário conhecido (o que sempre houve)
//   · `porDefinir` — rondas que o Sporting VAI jogar de certeza mas cujo
//                    adversário ainda não está sorteado (fase de liga da
//                    Champions antes do sorteio, a eliminatória da Taça em que
//                    os clubes da I Liga entram). Campo NOVO e aditivo: quem
//                    não o conhecer — o SplitBill — ignora-o e continua a ver
//                    exactamente o mesmo que via antes. Só entram aqui rondas
//                    com presença GARANTIDA: nada que dependa de ganhar a
//                    eliminatória anterior ou da classificação final.
//   · `potenciais` — o OPOSTO de `porDefinir`: rondas que o Sporting só chega
//                    a jogar SE vencer a anterior ou SE não ficar entre os 8
//                    primeiros da fase de liga da Champions (play-off de
//                    acesso aos oitavos, quartos/meias/final da Taça de
//                    Portugal e da Taça da Liga). Também aditivo — só o Goals
//                    usa isto, para mostrar esses jogos marcados como
//                    "potenciais" na listagem sem contarem para a época.
//
// É irmã da `fatura-restaurante` do SplitBill (mesmo projeto Supabase, mesmo
// padrão de descoberta de modelo e de fallback), mas com duas diferenças
// importantes:
//   1) usa GROUNDING com pesquisa Google (`tools:[{google_search:{}}]`) — sem
//      isso o modelo responde com o calendário que "lembra" do treino, que para
//      datas futuras é adivinhação pura;
//   2) com o tool de pesquisa ligado a API RECUSA `response_mime_type: json`,
//      por isso o JSON vem dentro de texto e é extraído aqui (ver extrairJson).
//
// O resultado é SEMPRE uma SUGESTÃO: nenhuma das apps grava seja o que for sem
// o admin confirmar jogo a jogo. É de propósito — um calendário lido por IA
// acerta na maioria mas engana-se, e as datas aqui mexem em dinheiro.
//
// Só o admin pode chamar (o email é o mesmo nas duas apps).
//
// Cada chamada deixa rasto em `goals.sync_log` (ver registar()): é o que
// permite despistar uma falha depois de acontecer, sem depender de apanhar o
// erro no ecrã no momento certo.
//
// Secrets necessários (Edge Functions -> Secrets):
//   GEMINI_API_KEY   chave do Google AI Studio
//   GEMINI_MODEL     (opcional) fixa um modelo; sem ele descobre o melhor flash
//   ADMIN_EMAIL      (opcional) sobrepõe-se ao email de admin por omissão
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy calendario-sporting

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") ?? "diogo.andre.f.silva@gmail.com").toLowerCase();
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
// Limite próprio, abaixo dos ~60s a que o Safari/iOS mata o pedido — dá para
// devolver um erro legível em vez de "Load failed". Mais folgado que o da
// fatura porque aqui há pesquisa Google pelo meio (várias idas à net).
const TIMEOUT_MS = 55_000;
// Orçamento por TENTATIVA (um modelo, uma chamada). Desde 28/08 o Gemini com
// `google_search` começou por vezes a ficar pendurado sem devolver resposta
// nenhuma — nem um 429/503 rápido, nada — e como todas as tentativas
// partilhavam o MESMO AbortSignal de 55s, um único modelo preso gastava a
// função toda sem sobrar tempo para tentar outro candidato. Isto dá a cada
// tentativa um relógio próprio, mais curto, para uma que fique presa ser
// abandonada depressa e a próxima ainda ter tempo dentro do TIMEOUT_MS geral.
// Dividido em dois relógios desde que os logs mostraram, em 29/08, TRÊS
// modelos "flash" diferentes (não um só) a ficar sem resposta NENHUMA
// durante o tempo todo quando `google_search` estava ligado — sinal de que
// é a pesquisa em si que está em baixo do lado da Google, não um modelo
// específico. Falhar depressa na tentativa com pesquisa e cair já para uma
// chamada sem pesquisa (mais rápida, sem o tool) dá muito mais hipótese de
// devolver alguma coisa dentro do orçamento total — a app já assinala bem
// visível quando `pesquisa:false` (ver app.js, `semPesquisa`).
const SEARCH_TENTATIVA_TIMEOUT_MS = 9_000;
const FALLBACK_TENTATIVA_TIMEOUT_MS = 15_000;

/* ── Escolha do modelo (mesma estratégia da `fatura-restaurante`) ──
   Os nomes dos modelos Gemini mudam com o tempo. Em vez de fixar um, pergunta-se
   à API que modelos a chave tem e ordenam-se os "flash" do melhor para o pior;
   devolve-se a LISTA para se poder cair no seguinte quando o preferido falha
   (404 se foi reformado, 503 se está sobrecarregado). */
// Sinal derivado com relógio próprio, que também aborta se `sinalPai` abortar
// primeiro — usado para não deixar UMA chamada externa (ListModels, Gemini)
// gastar sozinha todo o orçamento partilhado quando fica presa sem responder.
function comLimiteProprio(sinalPai: AbortSignal, ms: number): { signal: AbortSignal; limpar: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const propagar = () => c.abort();
  sinalPai.addEventListener("abort", propagar, { once: true });
  return {
    signal: c.signal,
    limpar: () => { clearTimeout(t); sinalPai.removeEventListener("abort", propagar); },
  };
}

let _models: string[] | null = null;
function rankFlash(names: string[]): string[] {
  const ok = [...new Set(names.filter((n) =>
    n.includes("flash") &&
    !/(lite|8b|image|tts|live|audio|embed|exp|preview|thinking)/.test(n)
  ))];
  const score = (n: string): number => {
    if (n === "gemini-flash-latest") return 100; // apontador sempre atualizado
    const m = n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/);
    return m ? parseFloat(m[1]) : 0;
  };
  return ok.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}
async function descobrirFlash(signal: AbortSignal): Promise<string[]> {
  if (_models) return _models;
  try {
    const names: string[] = [];
    let page = "";
    for (let i = 0; i < 3; i++) {
      // 8s por página: se o ListModels ficar preso, cai-se depressa no
      // fallback (ESTAVEIS) em vez de gastar aqui o orçamento dos 55s todo.
      const { signal: sinalPagina, limpar } = comLimiteProprio(signal, 8_000);
      let r: Response;
      try {
        r = await fetch(
          `${GAPI}/models?pageSize=200${page ? `&pageToken=${page}` : ""}&key=${GEMINI_KEY}`,
          { signal: sinalPagina },
        );
      } catch (_) {
        limpar();
        break;   // presa ou abortada — fica-se com o que já se tinha (ou nada)
      }
      limpar();
      if (!r.ok) break;
      const d = await r.json();
      (d.models ?? []).forEach((m: any) => {
        if ((m.supportedGenerationMethods ?? []).includes("generateContent")) {
          names.push(String(m.name).replace(/^models\//, ""));
        }
      });
      page = d.nextPageToken ?? "";
      if (!page) break;
    }
    const ranked = rankFlash(names);
    if (ranked.length) _models = ranked;
  } catch (_) { /* fica o fallback (inclui abort do timeout) */ }
  return _models ?? [];
}
const ESTAVEIS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
async function candidatosModelo(signal: AbortSignal): Promise<string[]> {
  const pinned = Deno.env.get("GEMINI_MODEL");
  const descobertos = await descobrirFlash(signal);
  const vistos = new Set<string>();
  const lista = [...(pinned ? [pinned] : []), ...ESTAVEIS, ...descobertos]
    .filter((m) => (vistos.has(m) ? false : vistos.add(m)));
  return lista.length ? lista : ["gemini-flash-latest"];
}

// As duas apps correm no GitHub Pages (origem diferente) → CORS obrigatório
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const COMPETICOES = [
  "Liga Portugal",
  "Liga dos Campeões",
  "Taça de Portugal",
  "Taça da Liga",
  "Supertaça",
  "Outro",
];

/* ── Nomes já em uso (opcional) ──
   A app manda os adversários que já tem gravados. Serve para o modelo devolver
   EXATAMENTE a grafia que a app já usa ("FC Porto" e não "Futebol Clube do
   Porto") — é isso que faz a correspondência com os jogos existentes bater
   certo em vez de sugerir um jogo "novo" que afinal já lá está. */
function lerConhecidos(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const vistos = new Set<string>();
  return raw
    .filter((n) => typeof n === "string" && n.trim())
    .map((n) => String(n).replace(/\s+/g, " ").trim().slice(0, 50))
    .filter((n) => (vistos.has(n) ? false : vistos.add(n)))
    .slice(0, 60);
}

// Época "2025/26" → intervalo de datas plausível, para o modelo não misturar épocas.
function janelaEpoca(epoca: string): { ini: string; fim: string } | null {
  const m = /^(\d{4})\s*\/\s*(\d{2,4})$/.exec(String(epoca || "").trim());
  if (!m) return null;
  const a = parseInt(m[1], 10);
  if (!isFinite(a) || a < 1990 || a > 2100) return null;
  return { ini: `${a}-07-01`, fim: `${a + 1}-06-30` };
}

const prompt = (epoca: string, hoje: string, conhecidos: string[]) => {
  const j = janelaEpoca(epoca);
  return `Hoje é ${hoje}. Pesquisa no Google e devolve o calendário de jogos
OFICIAIS do Sporting Clube de Portugal — futebol masculino, EQUIPA PRINCIPAL —
da época ${epoca}${j ? ` (jogos entre ${j.ini} e ${j.fim})` : ""}.

Confirma as datas em fontes fiáveis e atuais: sítio oficial do Sporting CP,
zerozero.pt, Liga Portugal, UEFA, Federação Portuguesa de Futebol.

INCLUI: Liga Portugal, Taça de Portugal, Taça da Liga, Supertaça, Liga dos
Campeões (também as pré-eliminatórias e o play-off), Liga Europa e Liga
Conferência — tudo o que seja competição oficial, já jogado ou por jogar.
EXCLUI: jogos particulares/amigáveis e torneios de pré-época (Troféu Cinco
Violinos e afins), equipa B, sub-23, formação, futsal, feminino e todas as
outras modalidades.

Devolve APENAS um objeto JSON com esta forma exata:
{"epoca": string, "jogos": [{"data": "YYYY-MM-DD", "hora": "HH:MM"|null,
  "adversario": string, "local": "Casa"|"Fora"|"Neutro", "competicao": string,
  "jornada": string|null, "estadio": string|null, "confirmado": true|false}],
 "porDefinir": [{"competicao": string, "jornada": string,
  "data_ini": "YYYY-MM-DD", "data_fim": "YYYY-MM-DD",
  "local": "Casa"|"Fora"|"Neutro"|null, "certeza": "garantida"}],
 "potenciais": [{"competicao": string, "jornada": string, "condicao": string,
  "data_ini": "YYYY-MM-DD", "data_fim": "YYYY-MM-DD",
  "local": "Casa"|"Fora"|"Neutro"|null}]}

Regras:
- "adversario": só o clube adversário, na forma curta usada em Portugal
  ("Benfica", "FC Porto", "Vitória SC", "Arsenal"). NUNCA metas "Sporting" aqui,
  nem o resultado, nem a competição.
- "local": "Casa" quando o Sporting joga em Alvalade, "Fora" no estádio do
  adversário, "Neutro" em campo neutro (Supertaça, final da Taça da Liga, final
  da Taça de Portugal no Jamor).
- "estadio": nome do estádio se o souberes; nos jogos em casa é o Estádio José
  Alvalade. null se não souberes.
- "competicao": exatamente um destes: ${COMPETICOES.map((c) => `"${c}"`).join(", ")}.
  Usa "Outro" para Liga Europa, Liga Conferência ou o que não encaixe.
- "jornada": "J12" na Liga; "1.ª mão", "Oitavos", "Meia-final", "Final" nas
  taças e provas europeias. null se não fizer sentido ou não souberes.
- "confirmado": true só quando a data já está oficialmente marcada; false quando
  é provisória, é uma janela ainda por marcar, ou o adversário ainda depende de
  um sorteio/apuramento.
- NÃO INVENTES. Um jogo cujo adversário ainda não está sorteado NÃO entra em
  "jogos" — vai para "porDefinir" (regras abaixo). Mais vale faltar um jogo do
  que devolver um que não existe.
- Uma entrada por jogo, sem repetições, ordenadas por data crescente.

Sobre "porDefinir" — rondas em que o Sporting JÁ TEM presença garantida mas
cujo adversário ainda não está sorteado:
- "certeza" é SEMPRE "garantida", e só metes lá o que não depende de NENHUM
  resultado por jogar: as jornadas da fase de liga da Liga dos Campeões quando
  o Sporting já está apurado para essa fase, e a eliminatória da Taça de
  Portugal em que os clubes da I Liga entram. NUNCA metas uma eliminatória que
  dependa de ganhar a anterior (oitavos, quartos, meias, finais, play-off do
  knockout), nem nada que dependa da classificação final. Na dúvida, deixa de
  fora — uma ronda a menos não faz mal nenhum, uma ronda que o Sporting não
  chega a jogar estraga as contas de quem usa isto.
- "data_ini"/"data_fim": a janela oficial já publicada dessa ronda (ex.: uma
  jornada da Champions marcada para 8 a 10 de setembro dá
  "data_ini":"AAAA-09-08" e "data_fim":"AAAA-09-10"). Se a data já for certa,
  mete o mesmo dia nos dois.
- "jornada": obrigatório e é o que identifica a ronda ("J1"… "J8" na fase de
  liga, "4.ª eliminatória" na Taça). Sem isto a entrada é deitada fora.
- "local": "Casa"/"Fora" só se já se souber; null antes do sorteio.
- NÃO repitas aqui nada que já tenha ido para "jogos".
- Se não houver nenhuma ronda nestas condições, devolve "porDefinir": [].

Sobre "potenciais" — o OPOSTO de "porDefinir": rondas que o Sporting só
chega a jogar SE vencer a anterior ou SE não ficar entre os 8 primeiros da
fase de liga da Champions:
- Inclui: o play-off de acesso aos oitavos da Liga dos Campeões (só se o
  Sporting ainda não estiver garantido nos oitavos), e as eliminatórias da
  Taça de Portugal e da Taça da Liga posteriores à primeira em que o
  Sporting entra (só se ainda dependerem de vencer a ronda anterior).
- IDA E VOLTA: no formato atual da Liga dos Campeões, o play-off e as
  eliminatórias até às MEIAS-FINAIS (inclusive) são a DUAS MÃOS — dois jogos
  distintos, cada um com o seu próprio resultado e a sua própria dívida no
  pote. Para cada uma dessas fases mete DUAS entradas em "potenciais", uma
  para "1.ª mão" e outra para "2.ª mão" (mesma "condicao" nas duas, datas
  diferentes). A FINAL da Liga dos Campeões é jogo único (jogo-só, sem
  "mão"). Na Taça de Portugal e na Taça da Liga TODAS as eliminatórias são
  jogo único, incluindo a final — nunca dupliques essas.
- "condicao": frase curta e clara do que falta acontecer ("se ficar fora do
  top 8 da fase de liga", "se vencer os oitavos-de-final").
- "data_ini"/"data_fim": tanto a UEFA (Liga dos Campeões) como a FPF/Liga
  Portugal (Taça de Portugal, Taça da Liga) publicam logo no início da época
  um comunicado com o calendário COMPLETO da prova — incluindo as datas de
  oitavos/quartos/meias/final — mesmo antes de se saber que clubes as
  disputam. Na FPF isto costuma sair numa notícia com um título do género
  "Calendário completo conhecido" (fpf.pt), com um PDF/link "calendário
  completo" em anexo. PROCURA esse comunicado da época em causa e usa as
  datas oficiais de lá — não assumas que não existem só porque a ronda ainda
  está longe. Numa fase a duas mãos (Champions), cada mão tem a sua própria
  janela (a 2.ª mão costuma ser cerca de uma semana depois da 1.ª); nas
  meias-finais da Taça de Portugal e da Taça da Liga, aviso: são jogo
  ÚNICO em campo neutro, não a duas mãos. Só se mesmo assim não encontrares
  nenhuma data oficial para essa fase (ex.: comunicado da época ainda não
  saiu) é que estimas pelo padrão das últimas 1-2 edições da prova, com uma
  janela mais larga para refletir a incerteza — e nunca por isso deixas a
  fase de fora.
- "jornada": obrigatório e identifica a fase. Na Taça de Portugal e na Taça
  da Liga, um destes: "Play-off", "Oitavos-de-final", "Quartos-de-final",
  "Meia-final", "Final". Na Liga dos Campeões, para as fases a duas mãos,
  acrescenta a mão ("Play-off · 1.ª mão", "Oitavos-de-final · 2.ª mão", …);
  "Final" fica sozinho, sem mão. Sem "jornada" a entrada é deitada fora.
- "local": null — ainda não se sabe.
- NÃO repitas aqui nada que já tenha ido para "jogos" ou "porDefinir".
- Se não houver nenhuma fase nestas condições, devolve "potenciais": [].${conhecidos.length ? `
- Se o adversário for um destes clubes já usados na app, copia EXATAMENTE a
  grafia da lista em vez de escrever uma nova:
${conhecidos.map((n) => `  · ${n}`).join("\n")}` : ""}

Responde só com o JSON, sem texto à volta e sem blocos de código.`;
};

/* Com o tool de pesquisa ligado a API recusa response_mime_type=json, por isso
   a resposta vem em texto: pode trazer blocos ``` e frases à volta. Aqui
   apanha-se o primeiro objeto JSON equilibrado do texto. */
function extrairJson(txt: string): unknown | null {
  const s = String(txt || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* segue para a extração */ }
  const semFences = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(semFences); } catch (_) { /* segue */ }
  // Varredura por chavetas equilibradas, ignorando o que está dentro de strings
  const ini = semFences.indexOf("{");
  if (ini < 0) return null;
  let nivel = 0, emString = false, escape = false;
  for (let i = ini; i < semFences.length; i++) {
    const c = semFences[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { emString = !emString; continue; }
    if (emString) continue;
    if (c === "{") nivel++;
    else if (c === "}") {
      nivel--;
      if (nivel === 0) {
        try { return JSON.parse(semFences.slice(ini, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/* Limpeza do que o modelo devolveu. Tudo o que não passa aqui é deitado fora em
   silêncio: uma linha meia lida vale menos que a confiança do admin na lista. */
function normalizarJogos(raw: unknown, epoca: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const j = janelaEpoca(epoca);
  const vistos = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const item of raw as any[]) {
    if (!item || typeof item !== "object") continue;
    const data = String(item.data ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;
    if (isNaN(new Date(`${data}T12:00:00Z`).getTime())) continue;
    if (j && (data < j.ini || data > j.fim)) continue;   // fora da época pedida
    const adversario = String(item.adversario ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!adversario) continue;
    if (/^sporting( cp| clube de portugal)?$/i.test(adversario)) continue;
    const local = ["Casa", "Fora", "Neutro"].includes(item.local) ? item.local : "Casa";
    const competicao = COMPETICOES.includes(item.competicao) ? item.competicao : "Outro";
    const hora = /^\d{2}:\d{2}$/.test(String(item.hora ?? "")) ? String(item.hora) : null;
    const jornada = item.jornada == null ? "" : String(item.jornada).replace(/\s+/g, " ").trim().slice(0, 24);
    const estadio = item.estadio == null ? null : String(item.estadio).replace(/\s+/g, " ").trim().slice(0, 80) || null;
    // Mesma data + mesmo adversário = mesmo jogo, mesmo que venha duas vezes
    const chave = `${data}|${adversario.toLowerCase()}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push({
      data, hora, adversario, local, competicao, jornada, estadio,
      confirmado: item.confirmado !== false,
    });
  }
  out.sort((a, b) => String(a.data).localeCompare(String(b.data)));
  return out;
}

/* Mesma limpeza, para as rondas ainda sem adversário sorteado. Mais apertada
   que a dos jogos de propósito: isto vai criar linhas na BD sem nome, e uma
   entrada duvidosa aqui é um jogo fantasma que alguém tem de ir apagar à mão.
     · `certeza` tem de vir "garantida" — o modelo é explicitamente instruído a
       não mandar rondas que dependam de resultados, e o que não afirmar isso
       cai aqui;
     · `jornada` é obrigatória: é ela que identifica a ronda e é por ela que a
       app volta a encontrar esta linha quando o sorteio sair;
     · janela limitada a 21 dias, para não passar uma "ronda" que afinal é uma
       competição inteira;
     · nada que colida com um jogo já devolvido em `jogos` (mesma competição e
       mesma jornada) — esse já tem adversário. */
function normalizarPorDefinir(
  raw: unknown,
  epoca: string,
  jogos: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const j = janelaEpoca(epoca);
  const chave = (c: unknown, jn: unknown) =>
    `${String(c ?? "").toLowerCase().trim()}|${
      String(jn ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
    }`;
  const vistos = new Set(jogos.map((g) => chave(g.competicao, g.jornada)));
  const out: Record<string, unknown>[] = [];
  for (const item of raw as any[]) {
    if (!item || typeof item !== "object") continue;
    if (String(item.certeza ?? "").toLowerCase() !== "garantida") continue;
    const competicao = COMPETICOES.includes(item.competicao) ? item.competicao : null;
    if (!competicao) continue;
    const jornada = String(item.jornada ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!jornada) continue;
    const ini = String(item.data_ini ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ini)) continue;
    if (isNaN(new Date(`${ini}T12:00:00Z`).getTime())) continue;
    if (j && (ini < j.ini || ini > j.fim)) continue;
    let fim = String(item.data_fim ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fim) || fim < ini) fim = ini;
    const dias = (new Date(`${fim}T12:00:00Z`).getTime() -
      new Date(`${ini}T12:00:00Z`).getTime()) / 86400000;
    if (!isFinite(dias) || dias > 21) fim = ini;
    const k = chave(competicao, jornada);
    if (vistos.has(k)) continue;
    vistos.add(k);
    const local = ["Casa", "Fora", "Neutro"].includes(item.local) ? item.local : null;
    out.push({ competicao, jornada, data_ini: ini, data_fim: fim, local, certeza: "garantida" });
    if (out.length >= 20) break;   // uma época não tem mais rondas garantidas que isto
  }
  out.sort((a, b) => String(a.data_ini).localeCompare(String(b.data_ini)));
  return out;
}

/* Mesma limpeza que `normalizarPorDefinir`, para as rondas que dependem de um
   resultado ainda por decidir. Não exige `certeza` (o oposto: isto É
   condicional, de propósito), mas exige `condicao` — sem ela a linha na app
   ficaria sem explicar porque está lá. Mesmas regras de colisão com `jogos` e
   `porDefinir`, e o mesmo tecto de 20 entradas.
   A janela aqui é mais LARGA que a do `por_definir` (45 dias em vez de 21):
   o normal é a data vir do comunicado oficial da época (UEFA ou FPF/Liga
   Portugal, ver prompt), tão certa como um `por_definir`; a janela larga é
   só para o caso raro de esse comunicado ainda não ter saído e o modelo
   estimar pelo padrão de edições anteriores — apertar demais cortava essa
   estimativa a direito e fazia-a parecer mais certa do que é. */
function normalizarPotenciais(
  raw: unknown,
  epoca: string,
  jogos: Record<string, unknown>[],
  porDefinir: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const j = janelaEpoca(epoca);
  const chave = (c: unknown, jn: unknown) =>
    `${String(c ?? "").toLowerCase().trim()}|${
      String(jn ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")
    }`;
  const vistos = new Set([
    ...jogos.map((g) => chave(g.competicao, g.jornada)),
    ...porDefinir.map((g) => chave(g.competicao, g.jornada)),
  ]);
  const out: Record<string, unknown>[] = [];
  for (const item of raw as any[]) {
    if (!item || typeof item !== "object") continue;
    const competicao = COMPETICOES.includes(item.competicao) ? item.competicao : null;
    if (!competicao) continue;
    const jornada = String(item.jornada ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (!jornada) continue;
    const condicao = String(item.condicao ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    if (!condicao) continue;
    const ini = String(item.data_ini ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ini)) continue;
    if (isNaN(new Date(`${ini}T12:00:00Z`).getTime())) continue;
    if (j && (ini < j.ini || ini > j.fim)) continue;
    let fim = String(item.data_fim ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fim) || fim < ini) fim = ini;
    const dias = (new Date(`${fim}T12:00:00Z`).getTime() -
      new Date(`${ini}T12:00:00Z`).getTime()) / 86400000;
    if (!isFinite(dias) || dias > 45) fim = ini;
    const k = chave(competicao, jornada);
    if (vistos.has(k)) continue;
    vistos.add(k);
    const local = ["Casa", "Fora", "Neutro"].includes(item.local) ? item.local : null;
    out.push({ competicao, jornada, condicao, data_ini: ini, data_fim: fim, local });
    if (out.length >= 20) break;
  }
  out.sort((a, b) => String(a.data_ini).localeCompare(String(b.data_ini)));
  return out;
}

/* Deixa rasto de cada chamada em `goals.sync_log` (migração db/sync-log.sql).
   Escreve com a SERVICE ROLE, logo passa por cima do RLS e funciona venha o
   pedido do Goals ou do SplitBill — é aqui que se apanha o que só se passa
   deste lado: o modelo que respondeu, se a pesquisa Google chegou a ser usada,
   e o erro exato do Gemini. Do lado do browser vê-se sempre a mesma coisa
   ("HTTP 502"); a causa está nesta linha.
   Nunca deita a resposta abaixo: se a tabela não existir, engole e segue. */
async function registar(
  estado: string,
  detalhe: Record<string, unknown>,
  quem: string | null,
  app: string,
): Promise<void> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/sync_log`, {
      method: "POST",
      headers: {
        apikey: SB_SRV,
        Authorization: `Bearer ${SB_SRV}`,
        "Content-Type": "application/json",
        "Content-Profile": "goals",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ origem: "function", app, acao: "calendario", estado, quem, detalhe }),
    });
    if (!r.ok) {
      console.log("CALENDARIO sync_log falhou:", r.status, (await r.text().catch(() => "")).slice(0, 200));
    }
  } catch (e) {
    console.log("CALENDARIO sync_log erro:", String((e as Error).message).slice(0, 200));
  }
}

/* Só o admin. Ao contrário da `fatura-restaurante` (que aceita qualquer
   `allowed_users` do SplitBill), esta função serve duas apps com schemas
   diferentes e escreve calendário — o email do admin é o mesmo nas duas, por
   isso é essa a verificação, feita no servidor e não na UI. */
async function ehAdmin(
  auth: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; email: string | null }> {
  if (!auth) return { ok: false, email: null };
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
    signal,
  });
  if (!u.ok) {
    console.log("CALENDARIO /user erro:", u.status, (await u.text().catch(() => "")).slice(0, 200));
    return { ok: false, email: null };
  }
  const uj = await u.json();
  const email = String(uj.email ?? "").toLowerCase();
  console.log("CALENDARIO email presente:", !!email, "admin:", email === ADMIN_EMAIL);
  return { ok: !!email && email === ADMIN_EMAIL, email: email || null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  // Criado à entrada e passado a TODOS os fetch (auth, ListModels, Gemini):
  // um único fetch sem este signal já chegou, na função irmã, para a deixar
  // pendurada sem nunca responder ao browser.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // Preenchidos assim que se souber quem chamou e de onde, para o registo de
  // erro no fim ter contexto mesmo quando a falha é logo no princípio.
  let quem: string | null = null;
  let qualApp = "goals";

  try {
    console.log("CALENDARIO start");
    const auth = await ehAdmin(req.headers.get("Authorization") ?? "", ctrl.signal);
    quem = auth.email;
    if (!auth.ok) {
      await registar("erro", { passo: "autorizacao" }, quem, qualApp);
      return json({ error: "não autorizado" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    qualApp = body?.app === "splitbill" ? "splitbill" : "goals";
    const epoca = String(body?.epoca ?? "").trim().slice(0, 12);
    if (!/^\d{4}\s*\/\s*\d{2,4}$/.test(epoca)) {
      await registar("erro", { passo: "epoca", recebido: String(body?.epoca ?? "") }, quem, qualApp);
      return json({ error: 'época em falta ou inválida (esperado "2025/26")' }, 400);
    }
    const conhecidos = lerConhecidos(body?.conhecidos);
    const hoje = new Date().toISOString().slice(0, 10);
    const texto = prompt(epoca, hoje, conhecidos);

    /* `search: true` liga o grounding com pesquisa Google — é o que faz a
       diferença entre datas reais e datas de memória. Nesse modo a API recusa
       response_mime_type, por isso o JSON só é pedido no prompt; sem pesquisa
       (fallback) já se pode exigir JSON à API. */
    const chamarGemini = (model: string, search: boolean, signal: AbortSignal) => {
      const corpo: Record<string, unknown> = {
        contents: [{ role: "user", parts: [{ text: texto }] }],
        generationConfig: search
          ? { temperature: 0 }
          : { temperature: 0, response_mime_type: "application/json" },
      };
      if (search) corpo.tools = [{ google_search: {} }];
      return fetch(`${GAPI}/models/${model}:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify(corpo),
      });
    };
    // Uma chamada, com o relógio certo consoante tem ou não o tool de pesquisa
    // ligado — devolve a Response, ou null se ficou presa sem responder a
    // tempo (nesse caso já regista o log; quem chama só decide o que fazer a
    // seguir).
    const tentar = async (model: string, search: boolean): Promise<Response | null> => {
      const { signal, limpar } = comLimiteProprio(
        ctrl.signal,
        search ? SEARCH_TENTATIVA_TIMEOUT_MS : FALLBACK_TENTATIVA_TIMEOUT_MS,
      );
      try {
        const r = await chamarGemini(model, search, signal);
        limpar();
        console.log("CALENDARIO tentativa:", model, search ? "(pesquisa)" : "(sem pesquisa)", "-> ", r.status);
        return r;
      } catch (e) {
        limpar();
        if (ctrl.signal.aborted) throw e;   // orçamento geral esgotado, sai já
        console.log("CALENDARIO tentativa presa (sem resposta):", model, search ? "(pesquisa)" : "(sem pesquisa)");
        return null;
      }
    };

    const transitorio = (s: number) => s === 429 || s === 500 || s === 503;
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

    const candidatos = await candidatosModelo(ctrl.signal);
    // A descoberta engole o AbortError (fica só com o fallback) — se o timeout
    // já disparou lá dentro, trata-se como timeout e não como 502 genérico.
    if (ctrl.signal.aborted) throw new DOMException("timeout", "AbortError");
    console.log("CALENDARIO candidatos:", candidatos.join(", "));
    let model = candidatos[0] ?? "gemini-flash-latest";
    let comPesquisa = true;
    let g: Response | null = null;

    for (let ci = 0; ci < candidatos.length && !ctrl.signal.aborted; ci++) {
      model = candidatos[ci];

      // Fase 1: COM pesquisa, uma única tentativa rápida — sem retry aqui,
      // porque uma que fica presa não fica presa "um bocadinho menos" da
      // segunda vez, e vale mais gastar esse tempo no fallback ou no
      // candidato seguinte.
      comPesquisa = true;
      g = await tentar(model, true);
      if (g && g.status === 400) {
        // Este modelo não aceita `google_search` nesta versão da API — cai já
        // para a fase 2, é exactamente o mesmo caminho de um hang.
        console.log("CALENDARIO 400:", (await g.clone().text()).slice(0, 300));
        g = null;
      }
      if (g && g.status === 404) { _models = null; g = null; continue; }   // saiu do catálogo, próximo já
      if (g && transitorio(g.status)) {
        await sleep(700);
        g = await tentar(model, true);
      }
      if (g && g.ok) break;

      if (ctrl.signal.aborted) break;

      // Fase 2: SEM pesquisa — mais lenta a admitir derrota (dá-lhe mais
      // tempo, já que sem o tool costuma responder depressa quando responde),
      // mas garante alguma coisa em vez do 504 de sempre. A app assinala bem
      // visível quando isto acontece (`pesquisa:false`).
      comPesquisa = false;
      g = await tentar(model, false);
      if (g && g.status === 404) { g = null; continue; }
      if (g && g.ok) break;
    }
    if (!g && ctrl.signal.aborted) {
      // O orçamento geral acabou entre tentativas (sem nenhum fetch a
      // abortar sozinho) — mesma mensagem legível de sempre, em vez de
      // um "gemini 502" genérico sem contexto nenhum.
      throw new DOMException("orçamento esgotado entre tentativas", "AbortError");
    }

    if (!g || !g.ok) {
      const status = g?.status ?? 502;
      const detail = g ? await g.text() : "";
      console.error("gemini", model, status, detail.slice(0, 500));
      let msg = "";
      try { msg = JSON.parse(detail)?.error?.message ?? ""; } catch (_) { /**/ }
      // O detalhe do Gemini fica REGISTADO mesmo quando a app só mostra "502":
      // é a diferença entre saber que a quota da pesquisa acabou e andar a
      // adivinhar.
      await registar("erro", {
        passo: "gemini", status, modelo: model, pesquisa: comPesquisa,
        erro: (msg || detail).slice(0, 800),
      }, quem, qualApp);
      if (transitorio(status)) {
        return json({
          error: "o serviço está com muita procura agora — espera um minuto e tenta outra vez",
        }, 503);
      }
      return json({ error: `gemini ${status} (${model})${msg ? ": " + msg.slice(0, 200) : ""}` }, 502);
    }

    const gd = await g.json();
    const cand = gd?.candidates?.[0];
    const texto2 = (cand?.content?.parts ?? [])
      .map((p: any) => p?.text ?? "")
      .join("")
      .trim();
    const parsed: any = extrairJson(texto2);
    if (!parsed) {
      console.error("CALENDARIO resposta ilegível:", texto2.slice(0, 400));
      await registar("erro", {
        passo: "json", modelo: model, pesquisa: comPesquisa, amostra: texto2.slice(0, 800),
      }, quem, qualApp);
      return json({ error: "resposta ilegível do modelo" }, 502);
    }
    const jogos = normalizarJogos(parsed.jogos, epoca);
    const porDefinir = normalizarPorDefinir(parsed.porDefinir, epoca, jogos);
    const potenciais = normalizarPotenciais(parsed.potenciais, epoca, jogos, porDefinir);
    if (!jogos.length) {
      await registar("erro", {
        passo: "vazio", modelo: model, pesquisa: comPesquisa, epoca,
        amostra: texto2.slice(0, 800),
      }, quem, qualApp);
      return json({ error: `não encontrei jogos do Sporting para a época ${epoca}` }, 404);
    }
    // As fontes que o grounding usou — a app mostra-as para o admin poder
    // conferir antes de aceitar seja o que for.
    const fontes: { titulo: string; url: string }[] = [];
    (cand?.groundingMetadata?.groundingChunks ?? []).forEach((c: any) => {
      const w = c?.web;
      if (w?.uri && !fontes.some((f) => f.url === w.uri)) {
        fontes.push({ titulo: String(w.title ?? w.uri).slice(0, 80), url: String(w.uri) });
      }
    });
    console.log(
      "CALENDARIO jogos:", jogos.length, "porDefinir:", porDefinir.length,
      "potenciais:", potenciais.length, "pesquisa:", comPesquisa, "fontes:", fontes.length,
    );
    await registar("ok", {
      epoca, jogos: jogos.length, por_definir: porDefinir.length,
      potenciais: potenciais.length, modelo: model, pesquisa: comPesquisa,
      fontes: fontes.map((f) => f.url).slice(0, 8),
    }, quem, qualApp);
    return json({
      epoca,
      jogos,
      porDefinir,
      potenciais,
      pesquisa: comPesquisa,
      fontes: fontes.slice(0, 8),
      modelo: model,
      geradoEm: new Date().toISOString(),
    });
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    await registar("erro", {
      passo: timeout ? "timeout" : "excecao",
      erro: String(err.message).slice(0, 500),
    }, quem, qualApp);
    if (timeout) {
      return json({
        error: "o modelo demorou demasiado a procurar o calendário — tenta outra vez daqui a pouco",
      }, 504);
    }
    return json({ error: err.message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
