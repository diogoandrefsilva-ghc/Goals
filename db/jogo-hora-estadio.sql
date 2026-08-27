-- =====================================================================
-- Goals — Migração: hora e estádio dos jogos.
-- Correr no SQL Editor do Supabase, DEPOIS de
-- schema.sql -> functions.sql -> policies.sql.
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- PORQUÊ ISTO EXISTE:
-- a Edge Function `calendario-sporting` já ia buscar a hora do jogo e o nome
-- do estádio (a informação vem de graça na mesma leitura por IA que já
-- confirma datas), mas a BD não tinha onde os guardar — a app descartava-os.
--
-- COMO FUNCIONA:
--   · `hora`    → "HH:MM", hora local do jogo. null quando ainda não é
--     conhecida (jogo por marcar, ou a fonte não a confirmou).
--   · `estadio` → nome do estádio. Nos jogos em casa é sempre o Estádio José
--     Alvalade; fora e em campo neutro varia. null se não se souber.
-- Preenchem-se de duas formas: à mão no modal de editar jogo, ou pela
-- sincronização do calendário (Config → "Calendário do Sporting") — a
-- secção "Datas diferentes" passa também a sugerir hora/estádio em falta ou
-- trocados nos jogos já gravados, além das datas.
--
-- TOLERANTE: sem esta migração a app continua igual ao que era — o `select=*`
-- de `carregar()` simplesmente não traz estas duas chaves, o detalhe do jogo
-- não mostra a linha da hora/estádio, e a sincronização do calendário não
-- oferece corrigi-las. Nada mais muda.
-- =====================================================================

ALTER TABLE goals.jogos ADD COLUMN IF NOT EXISTS hora text;
ALTER TABLE goals.jogos ADD COLUMN IF NOT EXISTS estadio text;

COMMENT ON COLUMN goals.jogos.hora IS
  'Hora local do jogo, formato ''HH:MM''; NULL = ainda não conhecida';
COMMENT ON COLUMN goals.jogos.estadio IS
  'Nome do estádio onde o jogo se realiza/realizou; NULL = não conhecido';
