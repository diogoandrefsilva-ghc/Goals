// supabase/functions/push-notificar-goals/index.ts
// Goals — Envia notificações Web Push (Notification/Push API, sem Telegram).
// Cinco momentos, todos chamados pela app:
//   'pedido_acesso'       sbSolicitarAcesso() → avisa o ADMIN_EMAIL quando
//                          alguém pede acesso à app pela primeira vez
//                          (fire-and-forget)
//   'pagamento_declarado' submeterPedidoPagamento() → avisa o ADMIN_EMAIL
//                          quando um amigo diz que já pagou um conjunto de
//                          jogos (fire-and-forget)
//   'pagamento_aprovado'  aprovarPedidoPagamento() → avisa só o amigo que
//                          fez o pedido, quando o admin o aprova
//                          (fire-and-forget)
//   'resultado_jogo'      guardarEdicao() → avisa TODOS os dispositivos
//                          subscritos quando o resultado de um jogo fecha
//                          pela primeira vez (fire-and-forget)
//   'pagamento_marcado'   pjSet()/marcarTodos()/desmarcarTodos()/
//                          toggleEstouroPago() → avisa cada amigo quando o
//                          admin marca/desmarca um pagamento DIRETAMENTE
//                          (golos ou estouro), sem pedido dele. Vem em lote
//                          (`mudancas`, um item por amigo — o cliente já
//                          debounça vários amigos marcados seguidos numa
//                          chamada só) e o email de cada um resolve-se aqui
//                          por `goals.user_amigos` (o cliente só conhece o
//                          NOME do amigo, que é a identidade estável).
//
// Nome diferente de `push-notificar` (SplitBill) DE PROPÓSITO: vivem no
// MESMO projeto Supabase (gjweqwfbnkgnibhajldc), cada Edge Function precisa
// de um slug único no projeto — não é specific ao schema.
//
// 'pagamento_declarado' vai sempre para o admin (é quem gere o pote/
// pagamentos no Goals — não há um "pagador" por evento como no SplitBill).
// 'pagamento_aprovado' é o inverso: sai do admin para UM amigo específico
// (quem fez o pedido). 'resultado_jogo' é o único tipo que sai para todos os
// subscritos. 'pagamento_aprovado' e 'resultado_jogo' só podem ser
// disparados pelo admin — a Edge Function confirma isso do lado do servidor,
// não confia só no `isAdmin()`/roGuard() da UI.
//
// Chamada pelo browser com o JWT do utilizador (verify_jwt fica LIGADO no
// deploy). Por cima disso confirma-se que o email consta de
// `goals.allowed_users` — EXCETO em 'pedido_acesso': é precisamente quem
// ainda NÃO está em allowed_users que tem de poder chamar isto (é o próprio
// pedido de acesso a disparar o aviso), por isso aí só se exige um JWT
// válido.
//
// FIABILIDADE (2026-08-15): este projeto Supabase é partilhado com o
// FestasBV/SplitBill e o PostgREST sofre picos de "Thread killed by
// timeout manager" com frequência (dezenas por hora, todas as horas) —
// nada de raro. Um desses picos, mesmo que dure só um instante, era
// suficiente para o pedido interno a `allowed_users` falhar e esta função
// devolver 403 "não autorizado" a um utilizador legítimo, perdendo a
// notificação sem deixar rasto (foi o que aconteceu a um pedido de
// pagamento da Barrona). Duas camadas contra isto:
//   1) `fetchComRetry` — as chamadas internas críticas (validar o JWT,
//      confirmar allowed_users) tentam até 3x com backoff curto antes de
//      desistir, para sobreviver a um pico passageiro.
//   2) outbox `goals.push_notificacoes` — cada notificação fica registada
//      ANTES de se tentar enviar e só passa a `enviado=true` se pelo menos
//      um dispositivo confirmar a entrega. O que ficar por enviar (ex.: o
//      próprio envio do Web Push falhar) é reencaminhado pela
//      `push-retry-goals`, chamada de 30 em 30 min por um pg_cron — ver
//      db/push-notificacoes.sql.
//
// Secrets: os secrets de Edge Function no Supabase são por PROJETO, não por
// function — este app está no MESMO projeto do SplitBill, por isso reusa o
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT já configurados lá (Edge
// Functions -> Secrets). Nada a criar de novo aqui.
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são injetados automaticamente.)
//
// Deploy: supabase functions deploy push-notificar-goals

import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@goals.app";
// Mesmo valor do ADMIN_EMAIL em app.js — não é secret (já vai no código
// público do frontend), só se mantém aqui para saber a quem mandar os
// pushes de 'pedido_acesso' e 'pagamento_declarado'.
const ADMIN_EMAIL = "diogo.andre.f.silva@gmail.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const sbHeaders = {
  apikey: SB_SRV,
  Authorization: `Bearer ${SB_SRV}`,
  "Content-Profile": "goals",
  "Accept-Profile": "goals",
  "Content-Type": "application/json",
};

// Tenta 3x com backoff curto (300ms, 600ms) antes de desistir — sobrevive a
// um pico passageiro do PostgREST sem fazer o utilizador esperar demasiado.
// Um 4xx é definitivo (não é rede, é o próprio pedido) e não vale a pena repetir.
async function fetchComRetry(url: string, opts: RequestInit, tentativas = 3): Promise<Response> {
  let ultimoErro: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok || (r.status >= 400 && r.status < 500)) return r;
      ultimoErro = new Error(`HTTP ${r.status}`);
    } catch (e) {
      ultimoErro = e;
    }
    if (i < tentativas - 1) await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  throw ultimoErro;
}

type Sub = { endpoint: string; email: string; p256dh: string; auth_key: string };

async function emailDoToken(auth: string): Promise<string | null> {
  try {
    const u = await fetchComRetry(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_SRV, Authorization: auth },
    });
    if (!u.ok) return null;
    const email = ((await u.json()).email ?? "").toLowerCase();
    return email || null;
  } catch {
    return null;
  }
}

// Resolve o email ligado a um amigo (por NOME — a identidade estável entre
// épocas, ver goals.user_amigos). O cliente só manda o nome, nunca o email,
// para 'pagamento_marcado' — quem sabe a ligação é o servidor.
async function emailDoAmigo(amigo: string): Promise<string | null> {
  try {
    const r = await fetchComRetry(
      `${SB_URL}/rest/v1/user_amigos?amigo=eq.${encodeURIComponent(amigo)}&select=email`,
      { headers: sbHeaders },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows?.[0]?.email ?? "").toLowerCase() || null;
  } catch {
    return null;
  }
}

// Frase para uma mudança de pagamento de UM amigo (golos e/ou estouro,
// marcado e/ou desmarcado — junta tudo o que mudou no mesmo lote/debounce).
function corpoMudancaPagamento(m: Mudanca): string | null {
  const partes: string[] = [];
  if (m.jogosPagos?.length) partes.push(`marcado como pago: ${m.jogosPagos.map((a) => `vs ${a}`).join(", ")}`);
  if (m.jogosDespagos?.length) partes.push(`desmarcado como pago: ${m.jogosDespagos.map((a) => `vs ${a}`).join(", ")}`);
  if (m.estouro === true) partes.push("estouro dos golos marcado como acertado");
  if (m.estouro === false) partes.push("estouro dos golos reaberto");
  return partes.length ? partes.join(" · ") : null;
}

async function estaAutorizado(email: string): Promise<boolean> {
  try {
    const r = await fetchComRetry(
      `${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,
      { headers: sbHeaders },
    );
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

async function subscriptionsDe(emails: string[]): Promise<Sub[]> {
  if (!emails.length) return [];
  const orEmails = emails.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
  try {
    const r = await fetchComRetry(
      `${SB_URL}/rest/v1/push_subscriptions?email=in.(${orEmails})&select=endpoint,email,p256dh,auth_key`,
      { headers: sbHeaders },
    );
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}

async function todasAsSubscricoes(): Promise<Sub[]> {
  try {
    const r = await fetchComRetry(
      `${SB_URL}/rest/v1/push_subscriptions?select=endpoint,email,p256dh,auth_key`,
      { headers: sbHeaders },
    );
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}

async function apagarSubsMortas(endpoints: string[]) {
  if (!endpoints.length) return;
  const orMortos = endpoints.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
  await fetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=in.(${orMortos})`, {
    method: "DELETE",
    headers: sbHeaders,
  }).catch(() => {});
}

// Manda o mesmo payload a uma lista de subscriptions; devolve {enviados,
// falhados} e apaga as que já não existem do lado do browser (404/410).
async function enviarParaSubs(subs: Sub[], payload: string) {
  let enviados = 0;
  let falhados = 0;
  const mortos: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
        );
        enviados++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) mortos.push(s.endpoint);
        falhados++;
      }
    }),
  );
  await apagarSubsMortas(mortos);
  return { enviados, falhados };
}

type Audiencia = "admin" | "todos" | "amigo";

// Regista a intenção de notificar ANTES de tentar enviar — é o que permite
// à push-retry-goals reencaminhar isto mais tarde se o envio falhar agora.
// Se a própria inserção falhar (tabela ausente por não teres corrido
// db/push-notificacoes.sql, ou outro pico do PostgREST), devolve null e o
// envio imediato segue na mesma — só fica sem rede de segurança para retry.
async function registarNotificacao(
  tipo: Tipo,
  audiencia: Audiencia,
  payload: Record<string, unknown>,
): Promise<number | null> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/push_notificacoes`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ tipo, audiencia, payload }),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function marcarEnviado(id: number | null) {
  if (id == null) return;
  await fetch(`${SB_URL}/rest/v1/push_notificacoes?id=eq.${id}`, {
    method: "PATCH",
    headers: sbHeaders,
    body: JSON.stringify({ enviado: true, enviado_em: new Date().toISOString() }),
  }).catch(() => {});
}

type Tipo =
  | "pedido_acesso"
  | "pagamento_declarado"
  | "pagamento_aprovado"
  | "resultado_jogo"
  | "pagamento_marcado";

type Mudanca = {
  amigo?: string;
  jogosPagos?: string[];
  jogosDespagos?: string[];
  estouro?: boolean | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    const emailChamador = await emailDoToken(auth);
    if (!emailChamador) return json({ error: "não autorizado" }, 403);

    const { tipo, email, amigo, valor, jogos, adversario, resultado, golos, mudancas } =
      (await req.json()) as {
        tipo?: Tipo;
        email?: string;
        amigo?: string;
        valor?: number;
        jogos?: string;
        adversario?: string;
        resultado?: string;
        golos?: number;
        mudancas?: Mudanca[];
      };

    // 'pedido_acesso': único caso em que NÃO se exige allowed_users — é
    // precisamente quem ainda não tem acesso que dispara isto.
    if (tipo === "pedido_acesso") {
      const payload = {
        title: "🆕 Novo pedido de acesso",
        body: `${email || emailChamador} pediu acesso ao Goals — aprova nas Definições`,
        url: "/Goals/",
      };
      const notifId = await registarNotificacao(tipo, "admin", payload);
      const subs = await subscriptionsDe([ADMIN_EMAIL]);
      const res = await enviarParaSubs(subs, JSON.stringify(payload));
      if (res.enviados > 0) await marcarEnviado(notifId);
      return json(res);
    }

    if (!(await estaAutorizado(emailChamador))) return json({ error: "não autorizado" }, 403);

    if (tipo === "pagamento_declarado") {
      const val = (Number(valor) || 0).toFixed(2);
      const payload = {
        title: "Pagamento declarado",
        body: `${amigo || "Alguém"} diz que já pagou ${jogos || "uns jogos"} — €${val}`,
        url: "/Goals/",
      };
      const notifId = await registarNotificacao(tipo, "admin", payload);
      const subs = await subscriptionsDe([ADMIN_EMAIL]);
      const res = await enviarParaSubs(subs, JSON.stringify(payload));
      if (res.enviados > 0) await marcarEnviado(notifId);
      return json(res);
    }

    if (tipo === "pagamento_aprovado") {
      // só o admin aprova pedidos — se chegar aqui de outra conta, ignora-se
      if (emailChamador !== ADMIN_EMAIL) return json({ error: "não autorizado" }, 403);
      const emailAlvo = (email || "").toLowerCase();
      if (!emailAlvo) return json({ enviados: 0, falhados: 0 });
      const val = (Number(valor) || 0).toFixed(2);
      const payload = {
        title: "Pagamento confirmado",
        body: `Diogo confirma que já pagaste ${jogos || "uns jogos"} — €${val}`,
        url: "/Goals/",
        emailAlvo,
      };
      const notifId = await registarNotificacao(tipo, "amigo", payload);
      const subs = await subscriptionsDe([emailAlvo]);
      const res = await enviarParaSubs(subs, JSON.stringify(payload));
      if (res.enviados > 0) await marcarEnviado(notifId);
      return json(res);
    }

    if (tipo === "resultado_jogo") {
      // só o admin fecha jogos — se chegar aqui de outra conta, ignora-se
      if (emailChamador !== ADMIN_EMAIL) return json({ error: "não autorizado" }, 403);
      const g = Number(golos);
      const golosTxt = Number.isFinite(g) && g > 0 ? ` — ${g} golo${g === 1 ? "" : "s"} do Sporting` : "";
      const payload = {
        title: "⚽ Resultado fechado",
        body: `${adversario || "Jogo"}: ${resultado || "?"}${golosTxt}`,
        url: "/Goals/",
      };
      const notifId = await registarNotificacao(tipo, "todos", payload);
      const subs = await todasAsSubscricoes();
      const res = await enviarParaSubs(subs, JSON.stringify(payload));
      if (res.enviados > 0) await marcarEnviado(notifId);
      return json(res);
    }

    if (tipo === "pagamento_marcado") {
      // só o admin marca pagamentos diretamente — se chegar aqui de outra conta, ignora-se
      if (emailChamador !== ADMIN_EMAIL) return json({ error: "não autorizado" }, 403);
      let enviados = 0;
      let falhados = 0;
      for (const m of Array.isArray(mudancas) ? mudancas : []) {
        const nomeAmigo = m?.amigo;
        if (!nomeAmigo) continue;
        const corpo = corpoMudancaPagamento(m);
        if (!corpo) continue;
        // amigo sem conta ligada (goals.user_amigos): nada a notificar, não é erro
        const emailAlvo = await emailDoAmigo(nomeAmigo);
        if (!emailAlvo) continue;
        const payload = { title: "Pagamento atualizado", body: corpo, url: "/Goals/", emailAlvo };
        const notifId = await registarNotificacao("pagamento_marcado", "amigo", payload);
        const subs = await subscriptionsDe([emailAlvo]);
        const res = await enviarParaSubs(subs, JSON.stringify(payload));
        if (res.enviados > 0) await marcarEnviado(notifId);
        enviados += res.enviados;
        falhados += res.falhados;
      }
      return json({ enviados, falhados });
    }

    return json({ enviados: 0, falhados: 0 });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
