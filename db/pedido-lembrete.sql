-- =====================================================================
-- Goals — Migração: pedido de pagamento à espera de confirmação
-- (goals.pedidos_pagamento.lembrado_em + goals.relembrar_pedido)
-- e trava contra o MESMO pedido duas vezes.
-- Correr no SQL Editor do Supabase, DEPOIS de
-- schema.sql -> functions.sql -> policies.sql.
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- PORQUÊ: um pedido pendente NÃO marca o jogo como pago (de propósito —
-- pendente não é dinheiro), por isso os jogos continuavam na lista "por
-- pagar" exatamente como antes de o enviar. Do lado de quem envia parece
-- que não foi, e carrega outra vez: foi assim que o Rogélio criou dois
-- pedidos iguais com 17 segundos de intervalo (ids 18 e 19, 2026-08-31).
-- Nem o browser nem a BD tinham nada a impedi-lo.
--
-- Duas peças:
--   1) `lembrado_em` + `relembrar_pedido()` — em vez de repetir o pedido,
--      volta-se a tocar à campainha do admin. É por RPC porque o amigo
--      NÃO tem policy de UPDATE em pedidos_pagamento (ver policies.sql:
--      mudar um pedido que o admin está a decidir é reescrever a decisão)
--      — a função escreve só esta coluna, e só num pedido dele e ainda
--      pendente. O intervalo mínimo é verificado no SERVIDOR, não na UI:
--      caso contrário bastava recarregar a página para tocar de novo.
--   2) `pedpag_guard_ins` (o trigger que já existia, aqui substituído)
--      passa a recusar um pedido pendente que repita jogos de outro
--      pendente do mesmo amigo. É a única camada que aguenta dois
--      dispositivos ao mesmo tempo — esconder o botão é só a UI.
--
-- Tolerante: sem esta migração a app avisa que falta correr o ficheiro
-- quando se carrega em "Relembrar" e mais nada muda.
-- =====================================================================

ALTER TABLE goals.pedidos_pagamento
  ADD COLUMN IF NOT EXISTS lembrado_em timestamptz;

-- ---------------------------------------------------------------------
-- Guarda de inserção (substitui a de functions.sql, que fica igual a
-- esta — este ficheiro é só para quem já tem a BD criada).
-- Além do que já fazia (o estado nasce sempre 'pendente', carimbado por
-- quem o fez), agora:
--   · tira jogos repetidos DENTRO do mesmo pedido — o bloco do membro
--     está montado duas vezes (Resumo e Contas) e o cliente lê as
--     checkboxes dos dois de uma vez;
--   · recusa um pedido que repita jogos de outro pendente do mesmo amigo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION goals.pedpag_guard_ins()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'goals', 'public'
AS $$
DECLARE
  v_dup bigint;
BEGIN
  IF NOT goals.is_admin() THEN
    NEW.estado       := 'pendente';
    NEW.decidido_por := NULL;
    NEW.decidido_em  := NULL;
    NEW.motivo       := NULL;
  END IF;
  NEW.criado_por_email := COALESCE(auth.email(), '');
  NEW.criado_em        := now();
  NEW.lembrado_em      := NULL;

  NEW.jogo_ids := ARRAY(SELECT DISTINCT unnest(NEW.jogo_ids));

  -- && é "os arrays têm algum elemento em comum": basta UM jogo repetido
  -- para o pedido ser um duplicado do que já está à espera de decisão.
  IF NEW.estado = 'pendente' THEN
    SELECT p.id INTO v_dup
      FROM goals.pedidos_pagamento p
     WHERE p.amigo_id = NEW.amigo_id
       AND p.epoca_nome = NEW.epoca_nome
       AND p.estado = 'pendente'
       AND p.jogo_ids && NEW.jogo_ids
     LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RAISE EXCEPTION 'Já tens um pedido à espera de confirmação com esses jogos.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pedidos_pagamento_guard_ins ON goals.pedidos_pagamento;
CREATE TRIGGER pedidos_pagamento_guard_ins
  BEFORE INSERT ON goals.pedidos_pagamento
  FOR EACH ROW EXECUTE FUNCTION goals.pedpag_guard_ins();

-- ---------------------------------------------------------------------
-- "Relembrar o admin": carimba lembrado_em no pedido, se for meu, se
-- ainda estiver pendente e se já tiver passado tempo suficiente desde o
-- último toque (o próprio pedido conta como o primeiro — criá-lo já
-- manda um push ao admin, não faz sentido relembrar logo a seguir).
-- SECURITY DEFINER: o amigo não tem UPDATE nesta tabela e não pode
-- ganhar um — a função é a única porta, e escreve só esta coluna.
-- O push em si é do cliente (Edge Function push-notificar-goals), como
-- em todos os outros avisos; isto é a parte que não se pode falsificar.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION goals.relembrar_pedido(p_id bigint)
  RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'goals', 'public'
AS $$
DECLARE
  v_espera constant interval := interval '12 hours';
  v_ped    goals.pedidos_pagamento;
  v_ultimo timestamptz;
BEGIN
  SELECT * INTO v_ped FROM goals.pedidos_pagamento WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido não encontrado.';
  END IF;
  IF NOT goals.eh_meu_amigo(v_ped.amigo_id) THEN
    RAISE EXCEPTION 'Só podes relembrar um pedido teu.';
  END IF;
  IF v_ped.estado <> 'pendente' THEN
    RAISE EXCEPTION 'Este pedido já foi decidido.';
  END IF;

  v_ultimo := COALESCE(v_ped.lembrado_em, v_ped.criado_em);
  IF v_ultimo > now() - v_espera THEN
    RAISE EXCEPTION 'O admin já foi avisado há pouco — podes voltar a tocar daqui a %.',
      to_char(v_ultimo + v_espera - now(), 'HH24"h"MI"m"');
  END IF;

  UPDATE goals.pedidos_pagamento
     SET lembrado_em = now()
   WHERE id = p_id
   RETURNING lembrado_em INTO v_ultimo;

  RETURN v_ultimo;
END;
$$;

REVOKE ALL ON FUNCTION goals.relembrar_pedido(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION goals.relembrar_pedido(bigint) TO authenticated;
