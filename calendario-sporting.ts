// supabase/functions/calendario-sporting/index.ts
// Calendário oficial do Sporting CP (futebol masculino, equipa principal), para
// as DUAS apps que dependem do mesmo calendário:
//   · Goals     — todos os jogos oficiais (casa, fora, campo neutro)
//   · SplitBill — só os que se jogam em Alvalade (filtro do lado da app)
//
// ── DUAS FONTES, DOIS MODOS (05/11/2026) ──
//   · `modo: "confirmados"` — os jogos JÁ MARCADOS (adversário conhecido) vêm
//     do calendário ICS que o FotMob publica para o Sporting (o mesmo que o
//     "Sincronizar calendário" do site deles dá a quem o quer no telemóvel).
//     Um GET, sem IA, sem custo, resposta em ~1 s — ver `jogosDoFotmob`.
//     Antes isto eram 11-13 chamadas ao Gemini com pesquisa por toque, com
//     leituras parciais e datas "plausíveis" de memória quando a pesquisa
//     falhava; o FotMob bateu certo jogo a jogo com o que já estava gravado.
//   · `modo: "potenciais"` — as rondas que o FotMob não pode ter, porque ainda
//     não têm adversário: `porDefinir` e `potenciais` (abaixo). Essas ficam
//     com o Gemini + pesquisa Google, em 2 chamadas (Taças / Europa). Os jogos
//     do FotMob vão na mesma resposta (é grátis), para a app saber que rondas
//     já passaram a jogo a sério.
//   · sem `modo`: o SplitBill fica com "confirmados" (só quer jogos); o Goals
//     antigo, de antes dos dois botões, fica com "potenciais" — que traz tudo
//     o que ele sabe tratar.
//
// A função devolve SEMPRE a época inteira, sem filtrar por local nem por
// competição: quem filtra é cada app, conforme o que lhe interessa. Assim há
// uma só resposta para manter, e o SplitBill nunca fica com uma visão
// diferente da do Goals.
//
// A resposta tem TRÊS arrays:
//   · `jogos`      — jogos com adversário conhecido (do FotMob)
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
// A parte do Gemini é irmã da `fatura-restaurante` do SplitBill (mesmo
// projeto Supabase), mas com duas diferenças importantes:
//   1) usa GROUNDING com pesquisa Google (`tools:[{google_search:{}}]`) — sem
//      isso o modelo responde com o calendário que "lembra" do treino, que para
//      datas futuras é adivinhação pura;
//   2) com o tool de pesquisa ligado a API RECUSA `response_mime_type: json`,
//      por isso o JSON vem dentro de texto e é extraído aqui (ver extrairJson).
//
// O resultado é SEMPRE uma SUGESTÃO: nenhuma das apps grava seja o que for sem
// o admin confirmar jogo a jogo. É de propósito — mesmo o FotMob tem datas
// provisórias (ver `jogosDoFotmob`), a IA engana-se, e as datas aqui mexem em
// dinheiro.
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

/* ══ OS JOGOS CONFIRMADOS — o calendário ICS do FotMob ══════════════════════
   O FotMob publica um calendário por equipa para subscrever no telemóvel
   (www.fotmob.com/teams/9768/synccalendar → "Ics"). É um ficheiro iCalendar
   normal, com a época corrente inteira — amigáveis, Liga, Taças, Europa —,
   cada jogo com início em UTC, estádio, competição e "Casa - Fora". Testado a
   05/11/2026 contra o `goals.jogos` de 2026/27: todos os jogos confirmados
   batiam na data e na hora.
   Porquê este e não o site do Sporting: o sporting.pt só põe no HTML o
   próximo jogo; a lista vem de uma função interna do site deles, que recusa
   pedidos de fora e muda de endereço a cada deploy. Este feed existe para ser
   lido por programas (calendários) — o próprio ficheiro pede para ser lido no
   máximo de 6 em 6 horas, e um toque do admin de vez em quando fica muito
   abaixo disso.

   O que o feed NÃO tem, e como se trata:
     · HORA POR MARCAR: a Liga marca as horas 2-3 semanas antes (TV). Até lá o
       FotMob põe 17:00 (hora de Lisboa) e o estádio só com o nome, sem a
       morada. Um jogo assim vai com `hora: null` e `confirmado: false` — a
       data também é a provisória (o domingo da jornada);
     · JORNADA: não vem. Conta-se (`numerar`) na Liga (J1…J34) e na fase de
       liga da Champions (J1…J8), e só quando o número de jogos bate certo com
       o da prova — senão vai vazia, que é melhor do que errada;
     · RONDAS SEM ADVERSÁRIO (`porDefinir`/`potenciais`): não existem lá até o
       sorteio sair — isso continua com o Gemini (modo "potenciais");
     · NOMES: vêm à maneira do FotMob ("FC Porto", "Casa Pia AC"). A app já
       emparelha nomes diferentes (`_calSim`), e nos jogos novos a grafia do
       FotMob serve.
   FALHA À VISTA: um feed que mude de formato tem de dar erro ("0 jogos
   lidos"), nunca "não há diferenças" — é por isso que um calendário vazio ou
   sem VEVENT é erro e não uma lista vazia. */
const FOTMOB_EQUIPA = 9768;   // Sporting CP no FotMob
const FOTMOB_ICS = `https://pub.fotmob.com/prod/pub/api/v2/calendar/team/${FOTMOB_EQUIPA}.ics`;
const FOTMOB_PAGINA = `https://www.fotmob.com/teams/${FOTMOB_EQUIPA}/fixtures/sporting-cp`;
const FOTMOB_TIMEOUT_MS = 15_000;
const JORNADAS_LIGA = 34;       // 18 clubes
const JORNADAS_CHAMPIONS = 8;   // fase de liga
// Nome da competição no FotMob → o da app. Amigáveis ficam de fora; o que não
// estiver aqui vai como "Outro", com o nome original em `competicaoFonte`.
const COMP_FOTMOB: [RegExp, string][] = [
  [/^liga portugal|primeira liga/i, "Liga Portugal"],
  [/champions league/i, "Liga dos Campeões"],
  [/ta[cç]a de portugal/i, "Taça de Portugal"],
  [/league cup|ta[cç]a da liga/i, "Taça da Liga"],
  [/super ?cup|superta[cç]a/i, "Supertaça"],
];
const AMIGAVEL = /friendl|amig[aá]v/i;
// Estádios onde o Sporting joga em campo neutro (finais, Final Four).
const NEUTRO = /est[aá]dio nacional|jamor|algarve|magalh[aã]es pessoa|leiria|municipal de aveiro/i;
const EH_SPORTING = /^sporting( cp| clube de portugal)?$/i;

type PropIcs = { params: string; valor: string };
// Texto iCalendar → um objecto por VEVENT (propriedade → valor ainda escapado).
// Os VALARM (o aviso "começa daqui a 15 minutos") têm SUMMARY/DESCRIPTION
// próprios e são tirados antes, para não se sobreporem aos do jogo.
function lerIcs(txt: string): Record<string, PropIcs>[] {
  const desdobrado = String(txt).replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");
  const out: Record<string, PropIcs>[] = [];
  const re = /BEGIN:VEVENT\n([\s\S]*?)\nEND:VEVENT/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(desdobrado))) {
    const corpo = m[1].replace(/BEGIN:VALARM[\s\S]*?END:VALARM\n?/g, "");
    const ev: Record<string, PropIcs> = {};
    for (const linha of corpo.split("\n")) {
      const p = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(linha);
      if (!p) continue;
      const k = p[1].toUpperCase();
      if (!(k in ev)) ev[k] = { params: p[2], valor: p[3] };
    }
    out.push(ev);
  }
  return out;
}
const desescapar = (s: string) =>
  s.replace(/\\([\\,;nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
const semAcentos = (s: string) =>
  String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// "20261107T203000Z" (UTC) → data e hora de Lisboa. Sem "Z" assume-se que já
// é hora local; só com a data (VALUE=DATE) fica sem hora.
function quandoIcs(v: string): { data: string; hora: string | null } | null {
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    const p: Record<string, string> = {};
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(v.trim());
  if (m) return { data: `${m[1]}-${m[2]}-${m[3]}`, hora: `${m[4]}:${m[5]}` };
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v.trim());
  if (m) return { data: `${m[1]}-${m[2]}-${m[3]}`, hora: null };
  return null;
}
// "⚽️ Sporting CP - 🇲🇨 Monaco  (2-0)" → "Monaco": sem emojis/bandeiras.
const limparEquipa = (s: string) =>
  s.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ").trim();

/* VEVENTs → jogos no formato que as apps já consomem (o mesmo que o Gemini
   devolvia): {data, hora, adversario, local, competicao, jornada, estadio,
   confirmado}. Pura (sem rede), para se poder testar com um ficheiro. */
function jogosDoIcs(txt: string, epoca: string): {
  jogos: Record<string, unknown>[]; eventos: number; amigaveis: number; ignorados: number;
} {
  const j = janelaEpoca(epoca);
  const eventos = lerIcs(txt);
  const vistos = new Set<string>();
  const jogos: Record<string, unknown>[] = [];
  let amigaveis = 0, ignorados = 0;
  for (const ev of eventos) {
    const quando = ev.DTSTART ? quandoIcs(ev.DTSTART.valor) : null;
    if (!quando) { ignorados++; continue; }
    if (j && (quando.data < j.ini || quando.data > j.fim)) continue;   // outra época
    // A competição é a última linha da DESCRIPTION que não é o link do jogo.
    const linhas = desescapar(ev.DESCRIPTION?.valor ?? "").split("\n").map((s) => s.trim())
      .filter((s) => s && !/^https?:\/\//i.test(s));
    const compFonte = linhas[linhas.length - 1] ?? "";
    if (AMIGAVEL.test(compFonte)) { amigaveis++; continue; }
    const competicao = COMP_FOTMOB.find(([re]) => re.test(compFonte))?.[1] ?? "Outro";
    // "Casa - Fora (resultado)": tira-se o resultado e parte-se no " - ".
    const resumo = desescapar(ev.SUMMARY?.valor ?? "").replace(/\s*\([^)]*\d[^)]*\)\s*$/, "");
    const lados = resumo.split(/\s+[-–]\s+/).map(limparEquipa);
    if (lados.length !== 2) { ignorados++; continue; }
    const emCasa = EH_SPORTING.test(lados[0]), fora = EH_SPORTING.test(lados[1]);
    if (emCasa === fora) { ignorados++; continue; }   // nenhum (ou os dois) é o Sporting
    const adversario = (emCasa ? lados[1] : lados[0]).slice(0, 60);
    if (!adversario) { ignorados++; continue; }
    // LOCATION "Nome\, Rua\, Cidade\, PAÍS" quando o FotMob já tem o jogo
    // fechado; só "Nome" (e sem acentos) quando ainda é provisório.
    const partes = (ev.LOCATION?.valor ?? "").split(/\\,/).map((s) => desescapar(s).trim()).filter(Boolean);
    const temMorada = partes.length > 1;
    const nomeEstadio = partes[0] ?? "";
    const ehAlvalade = /alvalade/.test(semAcentos(nomeEstadio));
    // Neutro: uma final/Final Four (mesmo com o Sporting listado como
    // visitante), ou um "jogo em casa" que não é em Alvalade. O NEUTRO só vale
    // nas Taças — na Liga um desses estádios pode ser a casa do adversário.
    const taca = competicao === "Taça de Portugal" || competicao === "Taça da Liga" || competicao === "Supertaça";
    const local = (taca && NEUTRO.test(semAcentos(nomeEstadio))) ? "Neutro"
      : fora ? "Fora"
      : (nomeEstadio && !ehAlvalade) ? "Neutro" : "Casa";
    // 17:00 sem morada = hora por marcar (ver o comentário de cima).
    const provisoria = !temMorada && quando.hora === "17:00";
    const estadio = temMorada ? nomeEstadio.slice(0, 80) : (ehAlvalade ? "Estádio José Alvalade" : null);
    const uid = ev.UID?.valor || `${quando.data}|${adversario}`;
    if (vistos.has(uid)) continue;
    vistos.add(uid);
    jogos.push({
      data: quando.data, hora: provisoria ? null : quando.hora, adversario, local,
      competicao, jornada: "", estadio, confirmado: !provisoria,
      ...(competicao === "Outro" && compFonte ? { competicaoFonte: compFonte.slice(0, 60) } : {}),
    });
  }
  jogos.sort((a, b) => `${a.data} ${a.hora ?? ""}`.localeCompare(`${b.data} ${b.hora ?? ""}`));
  // Jornada por contagem — só quando o total bate com o da prova. Um jogo
  // adiado para depois de outros troca a ordem; como a jornada só se escreve
  // em jogos NOVOS (e a época inteira entra logo no início, antes de haver
  // adiamentos), o risco fica pequeno.
  const numerar = (filtro: (g: Record<string, unknown>) => boolean, total: number) => {
    const sel = jogos.filter(filtro);
    if (sel.length === total) sel.forEach((g, i) => { g.jornada = `J${i + 1}`; });
  };
  numerar((g) => g.competicao === "Liga Portugal", JORNADAS_LIGA);
  if (j) {
    const ano = parseInt(j.ini.slice(0, 4), 10);
    numerar((g) => g.competicao === "Liga dos Campeões" &&
      String(g.data) >= `${ano}-09-01` && String(g.data) <= `${ano + 1}-01-31`, JORNADAS_CHAMPIONS);
  }
  return { jogos, eventos: eventos.length, amigaveis, ignorados };
}

type ResFotmob =
  | { ok: true; jogos: Record<string, unknown>[] }
  | { ok: false; status: number; erro: string };
// O GET ao FotMob, com relógio próprio, e uma linha no `goals.sync_log` (só
// lá: não é uma chamada à IA, não vai para o `ia_uso`).
async function jogosDoFotmob(
  epoca: string, signal: AbortSignal, quem: string | null, qualApp: string,
): Promise<ResFotmob> {
  const t0 = Date.now();
  const { signal: sinal, limpar } = comLimiteProprio(signal, FOTMOB_TIMEOUT_MS);
  let status = 0, txt = "";
  try {
    const r = await fetch(FOTMOB_ICS, {
      headers: { Accept: "text/calendar", "User-Agent": "Goals-calendario/1.0" },
      signal: sinal,
    });
    status = r.status;
    txt = await r.text();
  } catch (e) {
    limpar();
    const erro = `o FotMob não respondeu (${String((e as Error)?.message ?? e).slice(0, 120)})`;
    await registar("erro", { passo: "fotmob", fonte: FOTMOB_ICS, erro, ms: Date.now() - t0, epoca }, quem, qualApp, false);
    return { ok: false, status: 504, erro };
  }
  limpar();
  const falha = async (erro: string, st = 502): Promise<ResFotmob> => {
    await registar("erro", {
      passo: "fotmob", fonte: FOTMOB_ICS, status, erro, amostra: txt.slice(0, 300), ms: Date.now() - t0, epoca,
    }, quem, qualApp, false);
    return { ok: false, status: st, erro };
  };
  if (status < 200 || status >= 300) return falha(`o FotMob respondeu HTTP ${status} ao pedir o calendário`);
  if (!/BEGIN:VCALENDAR/.test(txt)) return falha("o FotMob não devolveu um calendário (o formato pode ter mudado)");
  const r = jogosDoIcs(txt, epoca);
  if (!r.eventos) return falha("o calendário do FotMob veio sem jogos nenhuns (o formato pode ter mudado)");
  await registar(r.jogos.length ? "ok" : "erro", {
    passo: "fotmob", fonte: FOTMOB_ICS, status, epoca, ms: Date.now() - t0,
    eventos: r.eventos, jogos: r.jogos.length, amigaveis: r.amigaveis, ignorados: r.ignorados,
  }, quem, qualApp, false);
  if (!r.jogos.length) {
    return {
      ok: false, status: 404,
      erro: `o FotMob não tem jogos oficiais do Sporting para a época ${epoca} ` +
        "(o calendário dele só cobre a época corrente)",
    };
  }
  return { ok: true, jogos: r.jogos };
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

/* Limpeza do que o modelo devolveu, para as rondas ainda sem adversário
   sorteado (os jogos já marcados vêm do FotMob, e o que o modelo ainda mande
   em "jogos" é ignorado). Tudo o que não passa aqui é deitado fora em
   silêncio: uma linha meia lida vale menos que a confiança do admin na lista.
   Apertada de propósito: isto vai criar linhas na BD sem nome, e uma
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
   Desde 05/11/2026 o Gemini só procura as RONDAS SEM ADVERSÁRIO — os jogos
   marcados vêm do FotMob. Ficam dois blocos (Taças / Europa), em paralelo,
   em vez das 11-13 chamadas de quando também lia a Liga jornada a jornada.
   Histórico, para não se repetir: com o `gemini-flash-latest` a época inteira
   numa pergunta só não respondia em 140s, e com o lite uma pergunta larga
   vinha CURTA (J1-J17 deu 5 jogos). Se as rondas vierem curtas, parte-se
   mais (ex.: Europa em porDefinir / potenciais) — não se volta ao flash.
   Um bloco que falhe NÃO deita o outro abaixo: a app só sugere rondas novas
   (nunca apaga por não vir na resposta sem o admin confirmar), por isso uma
   resposta parcial é segura. Os que faltaram vão em `blocosEmFalta`.
   `jaMarcados` são os jogos dessas provas que o FotMob já tem — vão no
   pedido para o modelo saber em que ronda o Sporting está e não devolver
   como "potencial" uma ronda que já é jogo marcado. */
type Bloco = { id: string; ambito: string };

function blocosRondas(jaMarcados: Record<string, unknown>[]): Bloco[] {
  const lista = (comps: string[]) => {
    const sel = jaMarcados.filter((g) => comps.includes(String(g.competicao)));
    if (!sel.length) return "";
    return `\nJogos destas provas JÁ MARCADOS (vêm de outra fonte — não os repitas em lado
nenhum; servem para saberes em que ronda o Sporting já está):
${sel.map((g) => `  · ${g.data} ${g.adversario} (${g.competicao}${g.jornada ? " " + g.jornada : ""})`).join("\n")}`;
  };
  const ambito = (quais: string, comps: string[]) =>
    `ÂMBITO DESTE PEDIDO (sobrepõe-se ao INCLUI de cima): responde APENAS com
"porDefinir" e "potenciais" de ${quais}, como descrito acima. "jogos" vai
SEMPRE vazio ([]) — os jogos já marcados vêm de outra fonte. Todas as outras
competições ficam de fora — há outro pedido a tratar delas.${lista(comps)}`;
  return [
    {
      id: "Taças (rondas)",
      ambito: ambito("a Taça de Portugal, a Taça da Liga e a Supertaça",
        ["Taça de Portugal", "Taça da Liga", "Supertaça"]),
    },
    {
      id: "Europa (rondas)",
      ambito: ambito(
        "a Liga dos Campeões, a Liga Europa e a Liga Conferência (incluindo pré-eliminatórias e play-off)",
        ["Liga dos Campeões", "Outro"],
      ),
    },
  ];
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
  /* Os jogos marcados vêm do FotMob ANTES do Gemini (~1 s, grátis): vão na
     resposta, para a app ver que rondas já passaram a jogo a sério, e vão no
     pedido ao modelo (`blocosRondas`). Se o FotMob falhar, segue-se só com o
     Gemini e a resposta diz `jogosEmFalta` — a app deixa então de sugerir
     apagar potenciais (sem os jogos não distingue "eliminado" de "já marcado"). */
  const fm = await jogosDoFotmob(epoca, signal, quem, qualApp);
  const jogos = fm.ok ? fm.jogos : [];
  const blocos = blocosRondas(jogos);
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
  // entre blocos). O que o modelo ainda tenha mandado em "jogos" fica de fora:
  // os jogos são os do FotMob.
  const porDefinir = normalizarPorDefinir(bons.flatMap((r) => r.porDefinir), epoca, jogos);
  const potenciais = normalizarPotenciais(bons.flatMap((r) => r.potenciais), epoca, jogos, porDefinir);
  const fontes: { titulo: string; url: string }[] = [];
  if (fm.ok) fontes.push({ titulo: "FotMob (jogos marcados)", url: FOTMOB_PAGINA });
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
      modo: "potenciais",
      fonte: fm.ok ? "fotmob+gemini" : "gemini",
      jogos,
      // Aditivo: o FotMob falhou nesta procura — `jogos` vem vazio e a app não
      // pode concluir que uma ronda potencial desapareceu.
      ...(fm.ok ? {} : { jogosEmFalta: true, erroJogos: fm.erro }),
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
    // O modo (ver o topo do ficheiro). Sem ele: SplitBill → só jogos; Goals de
    // antes dos dois botões → "potenciais", que traz tudo o que ele trata.
    const modo = body?.modo === "confirmados" || body?.modo === "potenciais"
      ? body.modo
      : (qualApp === "splitbill" ? "confirmados" : "potenciais");

    /* ── MODO CONFIRMADOS: só o FotMob ──
       Síncrono (~1 s), sem Gemini, sem teto diário (não gasta nada), sem
       `calendario_analises`. O contrato da resposta é o de sempre — `jogos`
       com a mesma forma, `porDefinir`/`potenciais` vazios. */
    if (modo === "confirmados") {
      const fm = await jogosDoFotmob(epoca, ctrl.signal, quem, qualApp);
      if (!fm.ok) return json({ error: fm.erro }, fm.status);
      return json({
        epoca, modo, fonte: "fotmob", jogos: fm.jogos, porDefinir: [], potenciais: [],
        fontes: [{ titulo: "FotMob — calendário do Sporting CP", url: FOTMOB_PAGINA }],
        geradoEm: new Date().toISOString(),
      });
    }

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
