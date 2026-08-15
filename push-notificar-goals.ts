// supabase/functions/push-notificar-goals/index.ts
// Goals — Envia notificações Web Push (Notification/Push API, sem Telegram).
// Três momentos, todos chamados pela app:
//   'pedido_acesso'       sbSolicitarAcesso() → avisa o ADMIN_EMAIL quando
//                          alguém pede acesso à app pela primeira vez
//                          (fire-and-forget)
//   'pagamento_declarado' submeterPedidoPagamento() → avisa o ADMIN_EMAIL
//                          quando um amigo diz que já pagou um conjunto de
//                          jogos (fire-and-forget)
//   'resultado_jogo'      guardarEdicao() → avisa TODOS os dispositivos
//                          subscritos quando o resultado de um jogo fecha
//                          pela primeira vez (fire-and-forget)
//
// Nome diferente de `push-notificar` (SplitBill) DE PROPÓSITO: vivem no
// MESMO projeto Supabase (gjweqwfbnkgnibhajldc), cada Edge Function precisa
// de um slug único no projeto — não é specific ao schema.
//
// 'pagamento_declarado' e 'resultado_jogo' vão sempre para o admin (é quem
// gere o pote/pagamentos no Goals — não há um "pagador" por evento como no
// SplitBill). 'resultado_jogo' é o único tipo que sai para todos os
// subscritos, e só o admin o pode disparar (só o admin fecha jogos).
//
// Chamada pelo browser com o JWT do utilizador (verify_jwt fica LIGADO no
// deploy). Por cima disso confirma-se que o email consta de
// `goals.allowed_users` — EXCETO em 'pedido_acesso': é precisamente quem
// ainda NÃO está em allowed_users que tem de poder chamar isto (é o próprio
// pedido de acesso a disparar o aviso), por isso aí só se exige um JWT
// válido.
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

type Sub = { endpoint: string; email: string; p256dh: string; auth_key: string };

async function emailDoToken(auth: string): Promise<string | null> {
  const u = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_SRV, Authorization: auth },
  });
  if (!u.ok) return null;
  const email = ((await u.json()).email ?? "").toLowerCase();
  return email || null;
}

async function estaAutorizado(email: string): Promise<boolean> {
  const r = await fetch(
    `${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,
    { headers: sbHeaders },
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function subscriptionsDe(emails: string[]): Promise<Sub[]> {
  if (!emails.length) return [];
  const orEmails = emails.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(",");
  const r = await fetch(
    `${SB_URL}/rest/v1/push_subscriptions?email=in.(${orEmails})&select=endpoint,email,p256dh,auth_key`,
    { headers: sbHeaders },
  );
  return r.ok ? await r.json() : [];
}

async function todasAsSubscricoes(): Promise<Sub[]> {
  const r = await fetch(
    `${SB_URL}/rest/v1/push_subscriptions?select=endpoint,email,p256dh,auth_key`,
    { headers: sbHeaders },
  );
  return r.ok ? await r.json() : [];
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

type Tipo = "pedido_acesso" | "pagamento_declarado" | "resultado_jogo";

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

    const { tipo, email, amigo, valor, jogos, adversario, resultado, golos } =
      (await req.json()) as {
        tipo?: Tipo;
        email?: string;
        amigo?: string;
        valor?: number;
        jogos?: string;
        adversario?: string;
        resultado?: string;
        golos?: number;
      };

    // 'pedido_acesso': único caso em que NÃO se exige allowed_users — é
    // precisamente quem ainda não tem acesso que dispara isto.
    if (tipo === "pedido_acesso") {
      const subs = await subscriptionsDe([ADMIN_EMAIL]);
      const payload = JSON.stringify({
        title: "🆕 Novo pedido de acesso",
        body: `${email || emailChamador} pediu acesso ao Goals — aprova nas Definições`,
        url: "/Goals/",
      });
      return json(await enviarParaSubs(subs, payload));
    }

    if (!(await estaAutorizado(emailChamador))) return json({ error: "não autorizado" }, 403);

    if (tipo === "pagamento_declarado") {
      const subs = await subscriptionsDe([ADMIN_EMAIL]);
      const val = (Number(valor) || 0).toFixed(2);
      const payload = JSON.stringify({
        title: "✅ Pagamento declarado",
        body: `${amigo || "Alguém"} diz que já pagou ${jogos || "uns jogos"} — €${val} — confirma na app`,
        url: "/Goals/",
      });
      return json(await enviarParaSubs(subs, payload));
    }

    if (tipo === "resultado_jogo") {
      // só o admin fecha jogos — se chegar aqui de outra conta, ignora-se
      if (emailChamador !== ADMIN_EMAIL) return json({ error: "não autorizado" }, 403);
      const subs = await todasAsSubscricoes();
      const g = Number(golos);
      const golosTxt = Number.isFinite(g) && g > 0 ? ` — ${g} golo${g === 1 ? "" : "s"} do Sporting` : "";
      const payload = JSON.stringify({
        title: "⚽ Resultado fechado",
        body: `${adversario || "Jogo"}: ${resultado || "?"}${golosTxt}`,
        url: "/Goals/",
      });
      return json(await enviarParaSubs(subs, payload));
    }

    return json({ enviados: 0, falhados: 0 });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
