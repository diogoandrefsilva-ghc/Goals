-- =====================================================================
-- Goals — Migração: notificações push (Web Push, sem Telegram).
-- Correr no SQL Editor do Supabase (mesmo projeto do FestasBV), DEPOIS de
-- schema.sql -> functions.sql -> policies.sql.
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- O QUE FAZ:
-- guarda a "push subscription" que o browser gera quando o utilizador ativa
-- notificações (Definições → Ativar notificações). Cada linha é um par
-- endpoint+chaves ligado à conta (email) que o gerou — o mesmo utilizador
-- pode ter várias linhas (um por telemóvel/instalação da PWA).
--
-- QUEM ENVIA: a Edge Function `push-notificar-goals` (service role, bypassa
-- RLS). Nome diferente do `push-notificar` do SplitBill de propósito — vivem
-- no MESMO projeto Supabase, cada Edge Function precisa de um slug único.
-- Três momentos, todos chamados pela app:
--   'pedido_acesso'       sbSolicitarAcesso() → avisa o admin
--   'pagamento_declarado' submeterPedidoPagamento() → avisa o admin
--   'resultado_jogo'      guardarEdicao() → avisa TODOS os subscritos
--
-- Sem esta migração a app funciona à mesma: PUSH_COL fica false, o botão
-- "Ativar notificações" esconde-se, e a consola avisa. Nada rebenta.
-- =====================================================================

CREATE TABLE IF NOT EXISTS goals.push_subscriptions (
  endpoint   text PRIMARY KEY,
  email      text NOT NULL,
  p256dh     text NOT NULL,
  auth_key   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_email_idx
  ON goals.push_subscriptions (lower(email));

ALTER TABLE goals.push_subscriptions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON goals.push_subscriptions TO authenticated;

-- Cada um só vê/gere as próprias subscriptions (a Edge Function usa a
-- service role e não passa por aqui).
DROP POLICY IF EXISTS push_subscriptions_select_propria ON goals.push_subscriptions;
CREATE POLICY push_subscriptions_select_propria ON goals.push_subscriptions
  FOR SELECT TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- INSERT/UPDATE cobrem o upsert que a app faz (Prefer: resolution=merge-duplicates
-- pela PK `endpoint`) sempre que subscreve neste dispositivo.
DROP POLICY IF EXISTS push_subscriptions_insert_propria ON goals.push_subscriptions;
CREATE POLICY push_subscriptions_insert_propria ON goals.push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

DROP POLICY IF EXISTS push_subscriptions_update_propria ON goals.push_subscriptions;
CREATE POLICY push_subscriptions_update_propria ON goals.push_subscriptions
  FOR UPDATE TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  WITH CHECK (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

DROP POLICY IF EXISTS push_subscriptions_delete_propria ON goals.push_subscriptions;
CREATE POLICY push_subscriptions_delete_propria ON goals.push_subscriptions
  FOR DELETE TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
-- =====================================================================
