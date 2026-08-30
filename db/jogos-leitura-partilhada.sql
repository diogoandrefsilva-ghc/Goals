-- =====================================================================
-- Goals — Migração: `goals.jogos` legível por qualquer conta autenticada
-- (é o que deixa o SplitBill ler o calendário daqui em vez de manter
-- uma segunda lista de jogos futuros só dele).
-- Correr no SQL Editor do Supabase, DEPOIS de
-- schema.sql -> functions.sql -> policies.sql.
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- PORQUÊ ISTO EXISTE:
-- o SplitBill vive no MESMO projeto Supabase, noutro schema (`splitbill`),
-- e mostra "Próximos Jogos em Alvalade" — os mesmos jogos que já estão aqui,
-- com hora, competição, jornada e estádio. Sem isto teria de os voltar a
-- pedir à IA e a guardar por sua conta: duas listas do mesmo calendário,
-- que divergem no dia em que uma delas é sincronizada e a outra não.
--
-- PORQUE É SEGURO:
-- `goals.jogos` NÃO tem nenhuma coluna de dinheiro — isso vive à parte, em
-- pagos_jogo/estouros/creditos_extra/config/pedidos_pagamento, e nenhuma
-- dessas ganha policy nova aqui. A tabela inteira JÁ é legível pelo role
-- `anon` desde o acesso de convidado (db/acesso-convidado.sql): quem quer
-- ver estes dados sem sessão nenhuma já os vê. Continuar a exigir
-- `goals.is_allowed()` a quem TEM sessão só barrava os utilizadores do
-- SplitBill que não estão na lista do Goals — não protegia nada.
--
-- Escrita continua exclusiva do admin do Goals (`jogos_admin`, inalterada):
-- isto é só SELECT.
-- =====================================================================

DROP POLICY IF EXISTS jogos_sel_partilhado ON goals.jogos;
CREATE POLICY jogos_sel_partilhado ON goals.jogos
  FOR SELECT TO authenticated
  USING (true);
-- =====================================================================
