// supabase/functions/push-retry-goals/index.ts
// Goals — Reencaminha notificações Web Push que ficaram por enviar na
// outbox `goals.push_notificacoes`. Chamada de 30 em 30 min por um pg_cron
// (ver db/push-notificacoes.sql), NUNCA pelo browser — por isso não tem
// CORS nem lê o JWT do utilizador: a única credencial aceite é a própria
// service_role key, que o pg_cron manda no Authorization (guardada em
// Vault, nunca em código nem no repo). Ver db/README.md para o passo
// manual de a lá pôr.
//
// PORQUÊ ISTO EXISTE: `push-notificar-goals` é fire-and-forget — mesmo com
// retry nas chamadas internas, o envio do próprio Web Push (ou uma
// indisponibilidade mais longa do PostgREST deste projeto partilhado) pode
// falhar sem mais nenhuma tentativa. Esta função varre o que ficou
// `enviado=false` e tenta outra vez, até 10x (~5h de janela a cada 30 min).
//
// Deploy: supabase functions deploy push-retry-goals

import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@goals.app";
const ADMIN_EMAIL = "diogo.andre.f.silva@gmail.com";

// Desiste ao fim disto — tempo mais que suficiente para o PostgREST
// recuperar de qualquer pico razoável; passado isto assume-se perdido.
const MAX_TENTATIVAS = 10;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const sbHeaders = {
  apikey: SB_SRV,
  Authorization: `Bearer ${SB_SRV}`,
  "Content-Profile": "goals",
  "Accept-Profile": "goals",
  "Content-Type": "application/json",
};

type Sub = { endpoint: string; email: string; p256dh: string; auth_key: string };
type Pendente = {
  id: number;
  tipo: string;
  audiencia: "admin" | "todos" | "amigo";
  payload: Record<string, unknown>;
  tentativas: number;
};

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

async function enviarParaSubs(subs: Sub[], payload: string): Promise<number> {
  let enviados = 0;
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
      }
    }),
  );
  await apagarSubsMortas(mortos);
  return enviados;
}

async function buscarPendentes(): Promise<Pendente[]> {
  const r = await fetch(
    `${SB_URL}/rest/v1/push_notificacoes?enviado=eq.false&tentativas=lt.${MAX_TENTATIVAS}` +
      `&select=id,tipo,audiencia,payload,tentativas&order=criado_em.asc`,
    { headers: sbHeaders },
  );
  return r.ok ? await r.json() : [];
}

async function marcarTentativa(id: number, enviado: boolean, tentativas: number) {
  await fetch(`${SB_URL}/rest/v1/push_notificacoes?id=eq.${id}`, {
    method: "PATCH",
    headers: sbHeaders,
    body: JSON.stringify({
      tentativas: tentativas + 1,
      ultima_tentativa: new Date().toISOString(),
      ...(enviado ? { enviado: true, enviado_em: new Date().toISOString() } : {}),
    }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // Único chamador legítimo: o pg_cron, com a service_role key no
  // Authorization (guardada em Vault — ver db/push-notificacoes.sql).
  const auth = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (auth !== SB_SRV) return json({ error: "não autorizado" }, 403);

  const pendentes = await buscarPendentes();
  let reenviados = 0;
  for (const p of pendentes) {
    const subs =
      p.audiencia === "todos"
        ? await todasAsSubscricoes()
        : p.audiencia === "amigo"
          ? await subscriptionsDe([String(p.payload?.emailAlvo || "")].filter(Boolean))
          : await subscriptionsDe([ADMIN_EMAIL]);
    const enviados = await enviarParaSubs(subs, JSON.stringify(p.payload));
    if (enviados > 0) reenviados++;
    await marcarTentativa(p.id, enviados > 0, p.tentativas);
  }
  return json({ verificados: pendentes.length, reenviados });
});
