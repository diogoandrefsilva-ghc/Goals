-- =====================================================================
-- Goals — Migração: jogos certos mas ainda sem adversário sorteado.
-- Correr no SQL Editor do Supabase, DEPOIS de
-- schema.sql -> functions.sql -> policies.sql.
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- PORQUÊ ISTO EXISTE:
-- há jogos que o Sporting VAI jogar de certeza muito antes de se saber
-- contra quem — as 8 jornadas da fase de liga da Champions (o sorteio é só
-- no fim de agosto) e a eliminatória da Taça de Portugal em que os clubes
-- da I Liga entram. Sem eles a época fica curta na app: a Previsão divide
-- pelo número de jogos que lá estão (`db.jogos.length`), por isso 35 jogos
-- em vez dos ~44 reais dá uma previsão do pote muito abaixo da verdade, e a
-- barra de "% da época" no Resumo mente pelo mesmo motivo.
--
-- COMO FUNCIONA:
--   · `por_definir` = true  → o jogo existe, o adversário ainda não se sabe.
--     `adversario` fica a '' (a coluna é NOT NULL) e a app escreve
--     "Adversário por definir" no lugar do nome.
--   · `data_ate`            → fim da janela oficial ("8 a 10 de setembro").
--     `data` leva sempre o PRIMEIRO dia da janela, porque é `NOT NULL` e é
--     o que mantém o jogo ordenado no sítio certo; `data_ate` é o que
--     permite dizer na UI que a data ainda não está fechada e o que evita
--     sugerir uma "data diferente" quando a data real cai dentro da janela.
--
-- Um jogo assim é FINANCEIRAMENTE INERTE enquanto não tiver resultado:
-- `golos` fica NULL, e `jogoTemDivida()`/`gJ()` já ignoram esses. Só conta
-- para a Previsão e para a contagem da época — que é exactamente o objetivo.
--
-- Quando o sorteio sai, a linha é ACTUALIZADA no sítio (PATCH do adversário
-- + data + local, `por_definir` a false) — nunca apagada e recriada. É de
-- propósito: o `id` mantém-se, e com ele os `pagos_jogo` e os
-- `pedidos_pagamento` que já lhe estejam ligados.
--
-- TOLERANTE: sem esta migração a app continua igual ao que era — a secção
-- "Jogos ainda sem adversário" do painel de sugestões diz que falta correr
-- este ficheiro e não oferece nada. Nada mais muda.
-- =====================================================================

ALTER TABLE goals.jogos
  ADD COLUMN IF NOT EXISTS por_definir boolean NOT NULL DEFAULT false;

ALTER TABLE goals.jogos
  ADD COLUMN IF NOT EXISTS data_ate date;

-- A janela só faz sentido para a frente: `data` é sempre o primeiro dia.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jogos_data_ate_chk'
  ) THEN
    ALTER TABLE goals.jogos
      ADD CONSTRAINT jogos_data_ate_chk CHECK (data_ate IS NULL OR data_ate >= data);
  END IF;
END $$;

COMMENT ON COLUMN goals.jogos.por_definir IS
  'true = jogo certo mas adversário ainda por sortear (adversario fica a '''')';
COMMENT ON COLUMN goals.jogos.data_ate IS
  'Último dia da janela oficial quando a data ainda não está fechada; NULL = data certa';
