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
// É irmã da `fatura-restaurante` do SplitBill (mesmo projeto Supabase), mas
// com duas diferenças importantes:
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
//   ADMIN_EMAIL      (opcional) sobrepõe-se ao email de admin por omissão
// O `GEMINI_MODEL` (partilhado com outras funções) é IGNORADO de propósito: o
// modelo desta função é o `MODELO`, mais abaixo, e não muda sozinho.
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy calendario-sporting

// Só tipos — dá o global `EdgeRuntime` ao compilador (usado no modo assíncrono).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") ?? "diogo.andre.f.silva@gmail.com").toLowerCase();
const GAPI = "https://generativelanguage.googleapis.com/v1beta";
// ── DOIS MODOS ──
// `assincrono: true` no pedido (é o que o Goals manda) → a função cria uma
// linha em `goals.calendario_analises`, responde JÁ com o `id`, e faz o
// trabalho a sério em segundo plano com `EdgeRuntime.waitUntil`; a app faz
// polling a essa linha. Sem esse campo mantém-se o contrato ANTIGO (resposta
// completa de uma vez) — é por isso que o SplitBill não parte com esta
// mudança.
// Isto existe porque a procura com pesquisa Google passou a demorar MAIS do
// que um pedido HTTP aguenta: os logs mostram o Gemini a levar mais de um
// minuto neste prompt, e o browser/iOS corta por volta dos 60s. Enquanto foi
// tudo síncrono, nenhum limite nosso resolvia — o tecto não era nosso. É a
// mesma solução que a `sugerir-vinho` (WineSelection) já usa aqui ao lado.
/* ── O MODELO: um só, e o barato (03/11/2026) ──
   O `gemini-flash-lite-latest`, o mesmo que a Garrafeira usa no modo barato
   da `vinho-info`. Até à v26 isto descobria "o melhor flash" e, se um falhasse,
   passava ao seguinte; com o `gemini-flash-latest` a pensar 3-12 mil tokens e
   a pesquisar dezenas de fontes por chamada, até 8 blocos em paralelo e uma
   chamada cortada do nosso lado paga na mesma (a Google acaba-a do lado
   dela), um toque no botão chegou a 8-16 chamadas caras. Entre 02/11 e 03/11
   o calendário gastou ~11 € e esgotou o crédito pré-pago. Por isso:
     · NUNCA outro modelo. Num 429/500/503 tenta-se UMA vez mais com este,
       ao fim de 2 s; se falhar, o bloco falha (vai em `blocosEmFalta`);
     · sem `thinkingConfig` (o lite pensa ~0 por si);
     · 30 s por chamada (o lite responde em 2-6 s: uma que chegue aos 30 está
       presa, e não vale a pena pagar mais);
     · num 402 (crédito esgotado) param TODOS os blocos;
     · no máximo `MAX_POR_DIA` procuras em 24 h, contadas na BD.
   A pesquisa Google fica, e uma resposta sem ela continua a ser recusada:
   sem pesquisa o modelo dá datas de memória. */
const MODELO = "gemini-flash-lite-latest";
const CHAMADA_TIMEOUT_MS = 30_000;
const MAX_POR_DIA = 3;
const MSG_SEM_CREDITO =
  "acabou o crédito do Gemini (Google AI Studio) — é preciso carregar saldo na conta da chave";
/* Estimativa por chamada COM pesquisa — não é um preço publicado. É o que o
   painel AI-API-Control mediu (saldo real a 30 dias) numa chamada do lite com
   pesquisa: ~0,0066 €. Serve para dar ordem de grandeza ao `ia_uso`; o euro a
   sério é o painel que o reparte pelos tokens. Os tokens somam-se por cima,
   aos preços do lite (`custoEstimado`). */
const CUSTO_CALENDARIO_EUR = 0.006;
const EUR_ENTRADA_1M = 0.10;
const EUR_SAIDA_1M = 0.40;
function custoEstimado(usage: UsageMetadata | null, pesquisou: boolean): number {
  const tokens = usage
    ? (usage.promptTokenCount * EUR_ENTRADA_1M +
      (usage.candidatesTokenCount + usage.thoughtsTokenCount) * EUR_SAIDA_1M) / 1e6
    : 0;
  return Math.round(((pesquisou ? CUSTO_CALENDARIO_EUR : 0) + tokens) * 1e6) / 1e6;
}

type UsageMetadata = {
  promptTokenCount: number; candidatesTokenCount: number; thoughtsTokenCount: number;
  totalTokenCount: number; cachedContentTokenCount: number;
};
function usageMetadata(raw: any): UsageMetadata | null {
  const toInt = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const src = raw?.usageMetadata;
  if (!src || typeof src !== "object") return null;
  const out = {
    promptTokenCount: toInt(src.promptTokenCount),
    candidatesTokenCount: toInt(src.candidatesTokenCount),
    thoughtsTokenCount: toInt(src.thoughtsTokenCount),
    totalTokenCount: toInt(src.totalTokenCount),
    cachedContentTokenCount: toInt(src.cachedContentTokenCount),
  };
  return (out.promptTokenCount || out.candidatesTokenCount || out.totalTokenCount) ? out : null;
}

const TIMEOUT_MS = 55_000;        // modo antigo (síncrono), preso ao browser
// Segundo plano. O plano GRATUITO do Supabase corta uma execução aos 150s
// (relógio de parede, contando com o EdgeRuntime.waitUntil) — 140s é o que
// cabe com margem para ainda fechar a linha em `calendario_analises`. Não
// adianta subir isto sem mudar de plano: é o tecto da plataforma.
const PROC_TIMEOUT_MS = 140_000;
// Sinal derivado com relógio próprio, que também aborta se `sinalPai` abortar
// primeiro — usado para não deixar UMA chamada ao Gemini gastar sozinha todo o
// orçamento partilhado quando fica presa sem responder.
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

Confirma as datas em fontes fiáveis e atuais, por esta ORDEM DE PRIORIDADE
quando houver desacordo entre elas — usa a informação da fonte mais alta
nesta lista que tiver dados sobre esse jogo, e ignora as de baixo nesse caso:
  1. flashscore.pt e soccerway.com (mesmo conteúdo um do outro — trata-os
     como a mesma fonte, um a confirmar o outro) — para jogos de competições
     europeias (Liga dos Campeões, Liga Europa, Liga Conferência), a UEFA
     (uefa.com) empata em prioridade com estes dois.
  2. Liga Portugal (ligaportugal.pt) e o sítio oficial do Sporting CP
  3. zerozero.pt, Federação Portuguesa de Futebol e outras fontes
Só te afastas desta ordem se a fonte de prioridade mais alta estiver
claramente desatualizada (ex.: data de uma edição anterior da prova).

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
- "hora": jogos da Liga Portugal só costumam ter horário oficial fixado 2-3
  semanas antes da jornada (depende da escolha da TV) — antes disso, é normal
  e preferível deixar "hora": null a arriscar um valor que ainda pode mudar.
  Só preenches "hora" quando tiveres a certeza de que é a hora JÁ CONFIRMADA:
  ou uma fonte de prioridade 1 (flashscore.pt / soccerway.com / UEFA, ver
  ordem acima) diz isso claramente, ou pelo menos duas fontes independentes
  de prioridade mais baixa e recentes estão de acordo. Um valor "por
  omissão" tipo 20:30 não chega.
- Datas: se achares que a data de um jogo já esperado MUDOU (adiado/antecipado)
  em relação ao que seria óbvio pela jornada, só o reportes com uma fonte clara
  e recente a confirmar essa mudança (comunicado da Liga Portugal ou do
  Sporting CP). Na dúvida, mantém a data mais plausível em vez de arriscar uma
  "correção" errada — sugerir uma data errada é pior do que não sugerir nada.

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
  // false nos RESUMOS de várias chamadas: cada chamada ao Gemini já deixou a
  // sua própria linha no ia_uso, e o resumo contava-as a dobrar.
  espelhar = true,
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
  if (espelhar) await registarIaUso(estado, detalhe, quem, app);
}

/* Espelho em `ia_uso.registos` — schema à parte, no MESMO projeto Supabase,
   partilhado pelas cinco apps (ver o CLAUDE.md da WineCatalog, "O registo
   central de acessos ao Gemini"). Mesmo `detalhe` de cima, com
   tokens/modelo/custo também em colunas.

   A `app` é a de QUEM CHAMOU (`goals` ou `splitbill`, o `qualApp`) e não um
   "calendario-sporting" fixo: esta função é a única das nove que serve duas
   apps, e a pergunta a que o `ia_uso` existe para responder é quanto custa
   cada APP — não quanto custa este ficheiro.

   O contrato (db/README.md do AI-API-Control, "O contrato do registo"):
     · UMA linha por chamada ao Gemini, sempre — ok, erro, vazia, sem
       pesquisa, ilegível e CORTADA por tempo (essa sem tokens, mas com
       `cortada: true` e `pesquisa: true`: paga-se na mesma, e sem a linha o
       painel nem sabia que tinha havido uma chamada). Os resumos de uma
       procura ficam só no `sync_log` (`espelhar=false`);
     · nada de linhas `pedido` aqui;
     · `detalhe.pesquisa` (booleano) diz se a chamada pesquisou; o número de
       consultas vai em `detalhe.consultas_google` e NUNCA em
       `detalhe.pesquisas` — esse é a regra do Claude (paga por pesquisa), e a
       `ia_uso.pesquisas()` multiplicava-o pelo preço de uma pesquisa;
     · uma recusa antes de chegar ao Gemini (sem autorização, época inválida,
       o teto diário) grava a funcionalidade `entrada`.

   Nunca deita a chamada principal abaixo por isto falhar: é registo, não é
   o trabalho. */
const PASSOS_ENTRADA = new Set(["autorizacao", "epoca", "teto_diario", "teto_sem_contagem"]);
async function registarIaUso(
  estado: string,
  detalhe: Record<string, unknown>,
  quem: string | null,
  app: string,
): Promise<void> {
  if (estado === "pedido") return;   // o contrato: só usos que chegaram ao fim
  try {
    const usage = (detalhe.usageMetadata ?? null) as
      | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number }
      | null;
    const pesquisa = detalhe.pesquisa as unknown;
    await fetch(`${SB_URL}/rest/v1/registos`, {
      method: "POST",
      headers: {
        apikey: SB_SRV,
        Authorization: `Bearer ${SB_SRV}`,
        "Content-Type": "application/json",
        "Content-Profile": "ia_uso",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        app,
        funcao: "calendario-sporting",
        // Uma funcionalidade só, venha do Goals ou do SplitBill. O painel de
        // custos (AI-API-Control) conta o custo médio por funcionalidade.
        funcionalidade: PASSOS_ENTRADA.has(String(detalhe.passo ?? "")) ? "entrada" : "calendario",
        estado: estado === "erro" ? "erro" : "ok",
        modelo: (detalhe.modelo as string | undefined) ?? null,
        pesquisa_web: typeof pesquisa === "boolean" ? pesquisa : null,
        tokens_entrada: usage?.promptTokenCount ?? null,
        tokens_saida: usage?.candidatesTokenCount ?? null,
        tokens_pensamento: usage?.thoughtsTokenCount ?? null,
        tokens_total: usage?.totalTokenCount ?? null,
        custo_estimado_eur: (detalhe.custo_estimado_eur as number | undefined) ?? null,
        duracao_ms: (detalhe.ms as number | undefined) ?? null,
        quem,
        erro: estado === "erro"
          ? (String((detalhe.erro as string | undefined) ?? (detalhe.passo as string | undefined) ?? "").slice(0, 500) || null)
          : null,
        detalhe,
      }),
    });
  } catch (_e) {
    // nunca deita a chamada principal abaixo
  }
}

/* ── O TETO POR DIA ──
   Cada procura (um toque no botão, ou um pedido do SplitBill) deixa no
   `sync_log` uma linha `pedido` com `passo: "execucao"`, escrita ANTES de se
   chamar o Gemini; antes de começar outra contam-se as das últimas 24 h, e
   com `MAX_POR_DIA` já não se chama nada. Falha FECHADA: sem conseguir contar
   (ou marcar), não se procura — é dinheiro, e foi às cegas que se gastou. */
const SB_SRV_HEADERS = {
  apikey: SB_SRV,
  Authorization: `Bearer ${SB_SRV}`,
  "Accept-Profile": "goals",
  "Content-Profile": "goals",
  "Content-Type": "application/json",
};
async function execucoesRecentes(): Promise<string[] | null> {
  try {
    const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
    const r = await fetch(
      `${SB_URL}/rest/v1/sync_log?select=criado_em&acao=eq.calendario&origem=eq.function` +
        `&estado=eq.pedido&detalhe->>passo=eq.execucao&criado_em=gte.${encodeURIComponent(desde)}` +
        `&order=criado_em.asc`,
      { headers: SB_SRV_HEADERS },
    );
    if (!r.ok) {
      console.log("CALENDARIO contar execuções falhou:", r.status, (await r.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const rows = await r.json();
    return Array.isArray(rows) ? rows.map((x: any) => String(x?.criado_em ?? "")) : null;
  } catch (e) {
    console.log("CALENDARIO contar execuções erro:", String((e as Error).message).slice(0, 200));
    return null;
  }
}
async function marcarExecucao(
  detalhe: Record<string, unknown>,
  quem: string | null,
  app: string,
): Promise<boolean> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/sync_log`, {
      method: "POST",
      headers: { ...SB_SRV_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({
        origem: "function", app, acao: "calendario", estado: "pedido", quem,
        detalhe: { passo: "execucao", ...detalhe },
      }),
    });
    if (!r.ok) console.log("CALENDARIO marcar execução falhou:", r.status);
    return r.ok;
  } catch (_) {
    return false;
  }
}
// "hoje às 09:22", "amanhã às 09:22" ou "05/11 às 09:22", na hora de Lisboa.
function quandoLisboa(d: Date): string {
  const dia = (x: Date) =>
    new Intl.DateTimeFormat("pt-PT", {
      timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(x);
  const hora = new Intl.DateTimeFormat("pt-PT", {
    timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  const alvo = dia(d);
  if (alvo === dia(new Date())) return `hoje às ${hora}`;
  if (alvo === dia(new Date(Date.now() + 86400_000))) return `amanhã às ${hora}`;
  return `${alvo.slice(0, 5)} às ${hora}`;
}

/* Cria a linha em `goals.calendario_analises` (estado 'pendente' por omissão)
   com o PRÓPRIO JWT de quem carregou — assim a RLS corre normalmente e não é
   preciso confiar em nada que o cliente mande. Devolve o id, ou null se a
   migração `db/calendario-analises.sql` ainda não tiver sido corrida (nesse
   caso quem chama cai para o modo síncrono de sempre). */
async function criarAnalise(
  auth: string,
  epoca: string,
  quem: string,
  signal: AbortSignal,
): Promise<number | null> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/calendario_analises`, {
      method: "POST",
      headers: {
        apikey: SB_SRV,
        Authorization: auth,
        "Content-Type": "application/json",
        "Content-Profile": "goals",
        Prefer: "return=representation",
      },
      signal,
      body: JSON.stringify({ epoca, quem }),
    });
    if (!r.ok) {
      console.log("CALENDARIO criar analise erro:", r.status, (await r.text().catch(() => "")).slice(0, 300));
      return null;
    }
    const rows = await r.json();
    const id = rows?.[0]?.id;
    return typeof id === "number" ? id : null;
  } catch (e) {
    console.log("CALENDARIO criar analise excecao:", String((e as Error).message).slice(0, 200));
    return null;
  }
}

/* Fecha a linha (concluído ou erro) — SERVICE ROLE, porque isto corre em
   segundo plano, depois do pedido original (e do seu JWT) já ter respondido.
   O `quem=eq.` no WHERE garante que só mexe na linha do próprio dono, mesmo
   com a service role a ter acesso a tudo — não confia só no `id`. */
async function fecharAnalise(
  id: number,
  quem: string,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/calendario_analises?id=eq.${id}&quem=eq.${encodeURIComponent(quem)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SB_SRV,
          Authorization: `Bearer ${SB_SRV}`,
          "Content-Type": "application/json",
          "Content-Profile": "goals",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(patch),
      },
    );
    if (!r.ok) console.log("CALENDARIO fechar analise falhou:", r.status);
  } catch (e) {
    console.log("CALENDARIO fechar analise erro:", String((e as Error).message).slice(0, 200));
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


/* ── O TRABALHO A SÉRIO ──
   Toda a conversa com o Gemini num só sítio (os blocos, a chamada e a sua
   repetição, ler o JSON, normalizar, registar), para poder correr nos DOIS
   modos: à espera (contrato antigo, SplitBill) ou em segundo plano (Goals).
   Nunca escreve na resposta HTTP — devolve o corpo final, ou o erro já com o
   status certo. É isso que a torna reutilizável pelos dois caminhos. */
type ResCal =
  | { ok: true; corpo: Record<string, unknown> }
  | { ok: false; status: number; erro: string };

/* ── A pergunta, partida em BLOCOS que correm em paralelo ──
   Medido a 03/11/2026 (função de diagnóstico, `goals.sync_log` app='diag'):
   com o `gemini-flash-latest` de hoje, a época INTEIRA numa pergunta só não
   devolvia um byte ao fim de 140s — e o plano gratuito do Supabase corta uma
   execução em segundo plano aos 150s, por isso nenhum orçamento nosso a
   salvava. A mesma pergunta só sobre um pedaço (umas 6-9 jornadas da Liga, ou
   só as Taças, ou só a Europa) respondia em 35-80s, com as datas certas.
   Daí:
     · a Liga é partida em janelas de datas (~6 semanas cada, no máximo 5,
       só entre 20/jul e 31/mai — fora disso não há Liga), as Taças vão num
       bloco e a Europa em DOIS (jogos / potenciais: as eliminatórias a duas
       mãos e o comunicado da UEFA sozinhos levavam a Europa aos 128s) — tudo
       AO MESMO TEMPO, no máximo 8 chamadas;
     · só se pergunta a partir de há 2 semanas (`RECUO_DIAS`): o que já se
       jogou não muda de data e os resultados nunca foram importados. Quanto
       mais a época avança, menos há para procurar. Época que ainda não
       começou ou que já acabou: pergunta-se por ela toda;
     · um bloco que falhe NÃO deita os outros abaixo — a app só sugere jogos
       novos e datas diferentes (nunca apaga nada por não vir na resposta),
       por isso uma resposta parcial é útil e segura. Os que faltaram vão em
       `blocosEmFalta` e a app avisa.
   Com o lite (03/11/2026) as janelas da Liga passaram de ~6 para ~4 semanas:
   no diagnóstico desse dia, o lite com J1-J17 numa pergunta só devolveu 5
   jogos (o flash, 17). Numa janela de 4 semanas cabem ~4 jornadas, e o pedido
   diz quantas esperar. São mais chamadas (até 10 da Liga + 3 das provas), mas
   cada uma do lite com pesquisa custa ~0,7 cêntimos — uma procura inteira
   fica perto dos 10 cêntimos, contra os ~2 € de um toque com o flash. */
const RECUO_DIAS = 14;
const JANELA_LIGA_DIAS = 28;
const MAX_BLOCOS_LIGA = 10;
type Bloco = { id: string; ambito: string };
const somaDias = (d: string, n: number) =>
  new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function blocosDaEpoca(epoca: string, hoje: string): Bloco[] {
  const j = janelaEpoca(epoca);
  if (!j) return [{ id: "época inteira", ambito: "" }];
  let desde = somaDias(hoje, -RECUO_DIAS);
  if (desde < j.ini || desde > j.fim) desde = j.ini;   // ainda não começou, ou já acabou: toda
  // A Liga só se joga entre o fim de julho e o fim de maio.
  const ano = parseInt(j.ini.slice(0, 4), 10);
  const ligaIni = desde > `${ano}-07-20` ? desde : `${ano}-07-20`;
  const ligaFim = `${ano + 1}-05-31`;
  const dias = Math.max(1, Math.round(
    (Date.parse(`${ligaFim}T12:00:00Z`) - Date.parse(`${ligaIni}T12:00:00Z`)) / 86400000,
  ) + 1);
  const n = Math.min(MAX_BLOCOS_LIGA, Math.max(1, Math.ceil(dias / JANELA_LIGA_DIAS)));
  const passo = Math.ceil(dias / n);
  const out: Bloco[] = [];
  for (let i = 0; i < n; i++) {
    const a = somaDias(ligaIni, i * passo);
    if (a > ligaFim) break;
    const b0 = somaDias(ligaIni, (i + 1) * passo - 1);
    const b = b0 > ligaFim ? ligaFim : b0;
    const jornadas = Math.max(1, Math.round(
      ((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000 + 1) / 7,
    ));
    out.push({
      id: `Liga ${a} a ${b}`,
      ambito: `ÂMBITO DESTE PEDIDO (sobrepõe-se ao INCLUI de cima): responde APENAS sobre
os jogos da Liga Portugal com data entre ${a} e ${b} (inclusive) — e só isso.
Nesta janela cabem cerca de ${jornadas} jornada(s) (a Liga joga-se quase todas
as semanas): devolve TODOS os jogos do Sporting que encontrares nela, uma
entrada por jornada, e não só alguns.
Todas as outras competições e datas ficam de fora, e "porDefinir" e
"potenciais" vão vazios ([]) — há outros pedidos a tratar disso.`,
    });
  }
  const provas = (id: string, quais: string): Bloco => ({
    id,
    ambito: `ÂMBITO DESTE PEDIDO (sobrepõe-se ao INCLUI de cima): responde APENAS sobre
${quais} — em "jogos" só os que têm data a partir de ${desde}; "porDefinir" e
"potenciais" destas provas como descrito acima. Todas as outras competições
ficam de fora — há outros pedidos a tratar delas.`,
  });
  const europa = "a Liga dos Campeões, a Liga Europa e a Liga Conferência (incluindo pré-eliminatórias e play-off)";
  out.push(
    provas("Taças", "a Taça de Portugal, a Taça da Liga e a Supertaça"),
    {
      id: "Europa (jogos)",
      ambito: `ÂMBITO DESTE PEDIDO (sobrepõe-se ao INCLUI de cima): responde APENAS sobre
${europa} — em "jogos" só os que têm data a partir de ${desde}, e "porDefinir"
destas provas como descrito acima. "potenciais" vai vazio ([]) e todas as
outras competições ficam de fora — há outros pedidos a tratar disso.`,
    },
    {
      id: "Europa (potenciais)",
      ambito: `ÂMBITO DESTE PEDIDO (sobrepõe-se ao INCLUI de cima): responde APENAS com os
"potenciais" da Liga dos Campeões, da Liga Europa e da Liga Conferência
(incluindo o play-off), como descrito acima. "jogos" e "porDefinir" vão
vazios ([]) e todas as outras competições ficam de fora — há outros pedidos
a tratar disso.`,
    },
  );
  return out;
}

type ResBloco =
  | {
    ok: true; bloco: string; modelo: string;
    jogos: unknown[]; porDefinir: unknown[]; potenciais: unknown[];
    fontes: { titulo: string; url: string }[];
  }
  | { ok: false; bloco: string; erro: string; status?: number };

async function produzirCalendario(
  epoca: string,
  conhecidos: string[],
  quem: string | null,
  qualApp: string,
  signal: AbortSignal,
  budgetMs: number,
  // Quantas procuras já houve nas últimas 24 h (esta incluída), para a app o
  // dizer — e para quem lê um erro saber se ainda pode tentar.
  procuras: { feitas: number; max: number },
): Promise<ResCal> {
  const inicio = Date.now();
  // O que sobra do orçamento, com margem para ainda fechar as contas.
  const restante = () => budgetMs - (Date.now() - inicio) - 3_000;
  const hoje = new Date().toISOString().slice(0, 10);
  const base = prompt(epoca, hoje, conhecidos);
  const blocos = blocosDaEpoca(epoca, hoje);
  const transitorio = (s: number) => s === 429 || s === 500 || s === 503;
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  /* Um interruptor comum a TODOS os blocos: num 402 (crédito esgotado) um
     bloco desliga-o e os outros param — em vez de cada um continuar a mandar
     pedidos (e a tentar outra vez) a uma conta que já não tem saldo. Também
     dispara se o orçamento de fora (`signal`) acabar. */
  const geral = new AbortController();
  let semCredito = false;
  const pararTudo = () => geral.abort();
  if (signal.aborted) pararTudo();
  else signal.addEventListener("abort", pararTudo, { once: true });
  console.log("CALENDARIO modelo:", MODELO, "| blocos:", blocos.map((b) => b.id).join(" · "));

  /* Sempre COM pesquisa e sem `thinkingConfig`. Uma resposta sem sinal de
     pesquisa (`groundingMetadata` vazio) é recusada: sem pesquisa o modelo
     devolve datas "plausíveis" de memória, que a app ia sugerir como "datas
     que mudaram". */
  const chamar = (texto: string, sinal: AbortSignal) =>
    fetch(`${GAPI}/models/${MODELO}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: sinal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: texto }] }],
        generationConfig: { temperature: 0 },
        tools: [{ google_search: {} }],
      }),
    });
  const msgErro = (corpo: string) => {
    let msg = "";
    try { msg = JSON.parse(corpo)?.error?.message ?? ""; } catch (_) { /**/ }
    return (msg || corpo).slice(0, 800);
  };

  // Um bloco: UMA chamada ao modelo, e só mais uma se a Google disser que está
  // sobrecarregada (429/500/503). Nunca outro modelo. Cada chamada deixa a sua
  // linha (sync_log + ia_uso): cada uma custa.
  const correrBloco = async (b: Bloco): Promise<ResBloco> => {
    const texto = base + (b.ambito ? "\n\n" + b.ambito : "");
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      if (semCredito) return { ok: false, bloco: b.id, status: 402, erro: MSG_SEM_CREDITO };
      if (geral.signal.aborted || restante() < 5_000) {
        return { ok: false, bloco: b.id, erro: "acabou o tempo antes de perguntar" };
      }
      const ms = Math.min(CHAMADA_TIMEOUT_MS, restante());
      const t0 = Date.now();
      const { signal: sinal, limpar } = comLimiteProprio(geral.signal, ms);
      let status = 0, corpo = "";
      try {
        const g = await chamar(texto, sinal);
        status = g.status;
        corpo = await g.text();   // o corpo também fica debaixo do relógio
      } catch (_) {
        limpar();
        /* CORTADA do nosso lado. A Google acaba-a do lado dela e cobra-a, por
           isso fica uma linha com `pesquisa: true` e o custo estimado, sem
           tokens (não se sabem). Não se tenta outra vez: uma chamada que chega
           aos 30 s está presa, e repetir era pagar duas. */
        const porque = semCredito ? "sem_credito_noutro_bloco"
          : signal.aborted ? "orcamento" : `limite_${Math.round(ms / 1000)}s`;
        await registar("erro", {
          passo: "cortada", bloco: b.id, modelo: MODELO, pesquisa: true, cortada: true, porque,
          tentativa, ms: Date.now() - t0, custo_estimado_eur: custoEstimado(null, true),
        }, quem, qualApp);
        return semCredito
          ? { ok: false, bloco: b.id, status: 402, erro: MSG_SEM_CREDITO }
          : { ok: false, bloco: b.id, erro: "o Gemini não respondeu a tempo" };
      }
      limpar();
      console.log("CALENDARIO bloco:", b.id, `#${tentativa}`, "->", status, `${Date.now() - t0}ms`);

      if (status === 402) {
        // Acabou o crédito pré-pago da chave (Google AI Studio). A Google recusa
        // à porta (não cobra), mas a linha fica: mostra no painel quando acabou.
        semCredito = true;
        pararTudo();
        await registar("erro", {
          passo: "sem_credito", bloco: b.id, status, modelo: MODELO, pesquisa: false,
          erro: msgErro(corpo), tentativa, ms: Date.now() - t0, custo_estimado_eur: 0,
        }, quem, qualApp);
        return { ok: false, bloco: b.id, status: 402, erro: MSG_SEM_CREDITO };
      }
      if (status < 200 || status >= 300) {
        // Um pedido recusado pela Google não pesquisou nem se paga.
        const erro = msgErro(corpo);
        await registar("erro", {
          passo: "gemini", bloco: b.id, status, modelo: MODELO, pesquisa: false,
          erro, tentativa, ms: Date.now() - t0, custo_estimado_eur: 0,
        }, quem, qualApp);
        if (transitorio(status) && tentativa === 1) { await sleep(2_000); continue; }
        return {
          ok: false, bloco: b.id, status: transitorio(status) ? 503 : 502,
          erro: status === 404
            ? `o modelo ${MODELO} deixou de existir na API do Gemini — é preciso mudar o MODELO no código`
            : `gemini ${status}${erro ? ": " + erro.slice(0, 200) : ""}`,
        };
      }

      let gd: any = null;
      try { gd = JSON.parse(corpo); } catch (_) { /**/ }
      const cand = gd?.candidates?.[0];
      const usage = usageMetadata(gd);
      const motivo = String(cand?.finishReason ?? "");
      const texto2 = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("").trim();
      const gm = cand?.groundingMetadata;
      const consultas = Array.isArray(gm?.webSearchQueries) ? gm.webSearchQueries.length : 0;
      const nFontes = Array.isArray(gm?.groundingChunks) ? gm.groundingChunks.length : 0;
      const pesquisou = consultas > 0 || nFontes > 0;
      const comum = {
        bloco: b.id, modelo: MODELO, pesquisa: pesquisou, consultas_google: consultas,
        fontes_n: nFontes, finishReason: motivo || null, tentativa,
        ms: Date.now() - t0, ...(usage ? { usageMetadata: usage } : {}),
        custo_estimado_eur: custoEstimado(usage, pesquisou),
      };
      /* Um 200 com o corpo VAZIO não é o mesmo que uma resposta que não se
         entendeu (ver o CLAUDE.md da WineCatalog, "O 200 vazio"). Nenhum dos
         três casos se repete: o bloco falha e a app diz que a leitura é parcial. */
      if (!texto2) {
        await registar("erro", { passo: "gemini_vazio", ...comum }, quem, qualApp);
        return { ok: false, bloco: b.id, erro: `o modelo não devolveu resposta (${motivo || "vazia"})` };
      }
      if (!pesquisou) {
        await registar("erro", { passo: "sem-pesquisa", amostra: texto2.slice(0, 400), ...comum }, quem, qualApp);
        return { ok: false, bloco: b.id, erro: "o modelo respondeu sem pesquisar (datas de memória, recusadas)" };
      }
      const parsed: any = extrairJson(texto2);
      if (!parsed) {
        await registar("erro", { passo: "json", amostra: texto2.slice(0, 800), ...comum }, quem, qualApp);
        return { ok: false, bloco: b.id, erro: "resposta ilegível do modelo" };
      }
      const fontes: { titulo: string; url: string }[] = [];
      (gm?.groundingChunks ?? []).forEach((c: any) => {
        const w = c?.web;
        if (w?.uri && !fontes.some((f) => f.url === w.uri)) {
          fontes.push({ titulo: String(w.title ?? w.uri).slice(0, 80), url: String(w.uri) });
        }
      });
      const arr = (v: unknown) => (Array.isArray(v) ? v : []);
      await registar("ok", {
        ...comum,
        jogos: arr(parsed.jogos).length, por_definir: arr(parsed.porDefinir).length,
        potenciais: arr(parsed.potenciais).length,
      }, quem, qualApp);
      return {
        ok: true, bloco: b.id, modelo: MODELO,
        jogos: arr(parsed.jogos), porDefinir: arr(parsed.porDefinir), potenciais: arr(parsed.potenciais),
        fontes,
      };
    }
    return { ok: false, bloco: b.id, erro: "o Gemini continuou sobrecarregado" };
  };

  const res = await Promise.all(blocos.map((b) =>
    correrBloco(b).catch((e) => ({ ok: false as const, bloco: b.id, erro: String((e as Error)?.message ?? e) }))
  ));
  signal.removeEventListener("abort", pararTudo);
  const bons = res.filter((r) => r.ok) as Extract<ResBloco, { ok: true }>[];
  const maus = res.filter((r) => !r.ok) as Extract<ResBloco, { ok: false }>[];
  const resumo = {
    epoca, modelo: MODELO, blocos: blocos.length, ok: bons.map((r) => r.bloco),
    falharam: maus.map((r) => `${r.bloco}: ${r.erro}`.slice(0, 200)), ms: Date.now() - inicio,
    sem_credito: semCredito, procuras,
  };
  const contas = `(procuras nas últimas 24 h: ${procuras.feitas} de ${procuras.max})`;

  if (!bons.length) {
    // Resumo só no sync_log: cada chamada ao Gemini já deixou a sua linha no ia_uso.
    await registar("erro", { passo: "todos-os-blocos", ...resumo }, quem, qualApp, false);
    if (semCredito) return { ok: false, status: 402, erro: MSG_SEM_CREDITO };
    const primeiro = maus[0];
    const tudoTempo = maus.every((r) => r.erro === "o Gemini não respondeu a tempo");
    // Sem o convite "tenta outra vez daqui a pouco": foi ele que, a 03/11,
    // levou a várias tentativas seguidas — e cada uma paga-se.
    return {
      ok: false,
      status: tudoTempo ? 504 : (maus.find((r) => r.status)?.status ?? 502),
      erro: `${tudoTempo ? "o Gemini não respondeu a tempo" : (primeiro?.erro ?? "a procura falhou")} ${contas}`,
    };
  }

  // Juntar os blocos e limpar TUDO junto (é aqui que se tiram os repetidos
  // entre blocos — um jogo na fronteira de duas janelas, por exemplo).
  const jogos = normalizarJogos(bons.flatMap((r) => r.jogos), epoca);
  const porDefinir = normalizarPorDefinir(bons.flatMap((r) => r.porDefinir), epoca, jogos);
  const potenciais = normalizarPotenciais(bons.flatMap((r) => r.potenciais), epoca, jogos, porDefinir);
  const fontes: { titulo: string; url: string }[] = [];
  bons.flatMap((r) => r.fontes).forEach((f) => {
    if (!fontes.some((x) => x.url === f.url)) fontes.push(f);
  });
  if (!jogos.length && !porDefinir.length && !potenciais.length) {
    await registar("erro", { passo: "vazio", ...resumo }, quem, qualApp, false);
    return { ok: false, status: 404, erro: `não encontrei jogos do Sporting para a época ${epoca} ${contas}` };
  }
  console.log("CALENDARIO jogos:", jogos.length, "porDefinir:", porDefinir.length,
    "potenciais:", potenciais.length, "blocos ok:", bons.length, "/", blocos.length);
  await registar("ok", {
    passo: "resumo", ...resumo, jogos: jogos.length, por_definir: porDefinir.length,
    potenciais: potenciais.length, fontes: fontes.map((f) => f.url).slice(0, 8),
  }, quem, qualApp, false);
  return {
    ok: true,
    corpo: {
      epoca,
      jogos,
      porDefinir,
      potenciais,
      pesquisa: true,
      fontes: fontes.slice(0, 8),
      modelo: [...new Set(bons.map((r) => r.modelo))].join(", "),
      // Aditivo: blocos que não responderam (a app avisa que a leitura é parcial).
      blocosEmFalta: maus.map((r) => r.bloco),
      // Aditivo: quantas procuras já houve em 24 h, e o teto (a app mostra-o).
      procuras,
      geradoEm: new Date().toISOString(),
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  const authHeader = req.headers.get("Authorization") ?? "";
  // Criado à entrada e passado a TODOS os fetch (auth, Gemini):
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
    const auth = await ehAdmin(authHeader, ctrl.signal);
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

    /* ── O teto por dia, ANTES de qualquer chamada ao Gemini ── */
    const recentes = await execucoesRecentes();
    if (recentes == null) {
      await registar("erro", { passo: "teto_sem_contagem", epoca }, quem, qualApp);
      return json({
        error: "não consegui confirmar quantas procuras já houve hoje, por isso não procurei " +
          "(para não gastar às cegas). Vê o goals.sync_log.",
      }, 503);
    }
    if (recentes.length >= MAX_POR_DIA) {
      const livre = new Date(Date.parse(recentes[recentes.length - MAX_POR_DIA]) + 24 * 3600_000);
      await registar("erro", {
        passo: "teto_diario", epoca, feitas: recentes.length, max: MAX_POR_DIA,
        livre_em: livre.toISOString(),
      }, quem, qualApp);
      return json({
        error: `o calendário já foi procurado ${recentes.length} vezes nas últimas 24 horas ` +
          `(o limite é ${MAX_POR_DIA}, porque cada procura gasta crédito do Gemini). ` +
          `Podes voltar a procurar ${quandoLisboa(livre)}.`,
        teto: { feitas: recentes.length, max: MAX_POR_DIA, livreEm: livre.toISOString() },
      }, 429);
    }
    if (!(await marcarExecucao({ epoca, modelo: MODELO }, quem, qualApp))) {
      await registar("erro", { passo: "teto_sem_contagem", epoca, marcar: false }, quem, qualApp);
      return json({
        error: "não consegui registar esta procura no goals.sync_log, por isso não procurei " +
          "(sem esse registo o limite diário deixava de contar).",
      }, 503);
    }
    const procuras = { feitas: recentes.length + 1, max: MAX_POR_DIA };

    /* ── MODO ASSÍNCRONO (só quem o pedir) ──
       Responde já com o `id` e faz o trabalho a sério depois, com muito mais
       tempo do que um pedido HTTP aguenta. Quem não mandar `assincrono` fica
       com o contrato de sempre — é o que mantém o SplitBill a funcionar sem
       lhe tocar. Se a migração ainda não tiver sido corrida, `criarAnalise`
       devolve null e cai-se para o modo síncrono em vez de rebentar. */
    if (body?.assincrono === true) {
      const analiseId = await criarAnalise(authHeader, epoca, quem!, ctrl.signal);
      if (analiseId != null) {
        const dono = quem!;
        // NÃO faz await — o trabalho pesado continua depois de já se ter
        // respondido, e sobrevive ao pedido original terminar.
        EdgeRuntime.waitUntil((async () => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), PROC_TIMEOUT_MS);
          try {
            const res = await produzirCalendario(
              epoca, conhecidos, dono, qualApp, c.signal, PROC_TIMEOUT_MS, procuras,
            );
            await fecharAnalise(analiseId, dono, res.ok
              ? { estado: "concluido", resultado: res.corpo }
              : { estado: "erro", erro: res.erro });
          } catch (e) {
            const err = e as Error;
            const timeout = err.name === "AbortError";
            // Só no sync_log: as chamadas ao Gemini já deixaram a sua linha no ia_uso.
            await registar("erro", {
              passo: timeout ? "timeout" : "excecao",
              erro: String(err.message).slice(0, 500),
            }, dono, qualApp, false);
            await fecharAnalise(analiseId, dono, {
              estado: "erro",
              erro: timeout
                ? "o modelo demorou demasiado a procurar o calendário"
                : (err.message || "erro inesperado"),
            });
          } finally {
            clearTimeout(t);
          }
        })());
        return json({ id: analiseId, estado: "pendente" }, 202);
      }
      console.log("CALENDARIO sem tabela de análises — cai para o modo síncrono");
    }

    // ── MODO SÍNCRONO (contrato antigo) ──
    const res = await produzirCalendario(
      epoca, conhecidos, quem, qualApp, ctrl.signal, TIMEOUT_MS, procuras,
    );
    return res.ok ? json(res.corpo) : json({ error: res.erro }, res.status);
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError";
    // Só no sync_log: uma chamada ao Gemini que tenha chegado a sair já deixou
    // a sua linha no ia_uso.
    await registar("erro", {
      passo: timeout ? "timeout" : "excecao",
      erro: String(err.message).slice(0, 500),
    }, quem, qualApp, false);
    if (timeout) {
      return json({ error: "o modelo demorou demasiado a procurar o calendário" }, 504);
    }
    return json({ error: err.message }, 500);
  } finally {
    clearTimeout(timer);
  }
});
