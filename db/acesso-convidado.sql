-- =====================================================================
-- Goals — Migração: acesso de Convidado (sem login, sem EUR).
-- Correr no SQL Editor do Supabase, DEPOIS de
-- schema.sql -> functions.sql -> policies.sql.
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- PORQUÊ ISTO EXISTE:
-- há amigos Sportinguistas que só querem ver o calendário/resultados, sem
-- entrar na parte do pote/dívidas. "Entrar como convidado" no ecrã de login
-- salta o Supabase Auth por completo — a app usa a `anon` key diretamente
-- (sem sessão), exactamente como já fazia antes do login existir.
--
-- A FRONTEIRA É NA BD, NÃO NO JS: até agora todas as policies de SELECT são
-- `TO authenticated`, por isso um pedido sem sessão (role `anon`) já ficava
-- bloqueado em tudo — é isso que faz o convidado precisar destas duas
-- policies novas, e só destas duas. `goals.jogos` não tem nenhuma coluna de
-- dinheiro (isso vive à parte, em pagos_jogo/estouros/creditos_extra/config/
-- pedidos_pagamento — nenhuma dessas fica acessível ao role `anon`), por
-- isso não precisa de uma view a filtrar colunas: a tabela inteira já é
-- segura para o convidado ver. `goals.epocas` só para o seletor de época
-- funcionar como para um utilizador normal.
-- =====================================================================

DROP POLICY IF EXISTS jogos_sel_convidado ON goals.jogos;
CREATE POLICY jogos_sel_convidado ON goals.jogos
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS epocas_sel_convidado ON goals.epocas;
CREATE POLICY epocas_sel_convidado ON goals.epocas
  FOR SELECT TO anon
  USING (true);
-- =====================================================================
