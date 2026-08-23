-- =====================================================================
-- Goals — Migração: jogos "potenciais" (dependem de resultados por decidir).
-- Correr no SQL Editor do Supabase, DEPOIS de
-- schema.sql -> functions.sql -> policies.sql -> jogos-por-definir.sql.
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- PORQUÊ ISTO EXISTE:
-- ao contrário do `por_definir` (jogo certo, só falta o sorteio), há rondas
-- que o Sporting só chega a jogar SE vencer a anterior ou SE não ficar entre
-- os 8 primeiros da fase de liga da Champions — o play-off de acesso aos
-- oitavos, os quartos/meias/final da Taça de Portugal e da Taça da Liga.
-- Isto é o exacto oposto do que `por_definir` exige (presença garantida), por
-- isso é um flag à parte: mostra-se na listagem para não faltar nada no
-- calendário, mas NÃO conta para a Previsão nem para o total de jogos da
-- época enquanto for `potencial = true` — ao contrário do `por_definir`, que
-- já conta.
--
-- COMO FUNCIONA:
--   · `potencial` = true → jogo hipotético; `adversario` fica a '' (a coluna
--     é NOT NULL) tal como no `por_definir`, e a app mostra um selo diferente
--     ("potencial") em vez de "Adversário por definir".
--   · `condicao`         → frase curta do que falta para o jogo acontecer
--     ("se ficar fora do top 8 da fase de liga", "se vencer os oitavos"),
--     só para a UI explicar porque é que aquela linha lá está.
--   · `data`/`data_ate`  → reaproveita as colunas do `por_definir`: janela
--     oficial já publicada para essa fase da prova, mesmo que o jogo em si
--     ainda dependa de resultado.
--
-- Um jogo assim é FINANCEIRAMENTE INERTE (golos fica NULL) e fica de fora da
-- Previsão e da contagem "Total: N jogos" — só aparece na listagem para se
-- perceber que pode vir a acontecer.
--
-- Quando o calendário confirma a ronda, a linha é ACTUALIZADA no sítio
-- (nunca apagada e recriada, para não perder `pagos_jogo`/pedidos já
-- ligados):
--   · Sporting apurado, adversário sorteado → `potencial` a false, dados do
--     jogo preenchidos (é como uma promoção normal).
--   · Sporting apurado, adversário ainda por sortear → `potencial` a false,
--     `por_definir` a true (passa a contar, tal como qualquer outro
--     `por_definir`).
--   · Sporting eliminado (a leitura seguinte já não encontra esta ronda em
--     lado nenhum) → a app SUGERE apagar a linha; nunca apaga sozinha.
--
-- TOLERANTE: sem esta migração a app continua igual ao que era — a secção
-- "Jogos potenciais" do painel de sugestões diz que falta correr este
-- ficheiro e não oferece nada. Nada mais muda.
-- =====================================================================

ALTER TABLE goals.jogos
  ADD COLUMN IF NOT EXISTS potencial boolean NOT NULL DEFAULT false;

ALTER TABLE goals.jogos
  ADD COLUMN IF NOT EXISTS condicao text;

COMMENT ON COLUMN goals.jogos.potencial IS
  'true = jogo hipotético (depende de resultados por decidir); fica fora da Previsão e do total de jogos da época enquanto for true';
COMMENT ON COLUMN goals.jogos.condicao IS
  'Frase curta do que falta para este jogo potencial acontecer, só para a UI';
