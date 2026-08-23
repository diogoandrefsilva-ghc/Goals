-- =====================================================================
-- Goals — Migração: aprovar pedido de pagamento, de forma atómica
-- (goals.aprovar_pedido_pagamento)
-- Correr no SQL Editor do Supabase, DEPOIS de
-- schema.sql -> functions.sql -> policies.sql.
-- É IDEMPOTENTE: pode ser corrida mais que uma vez sem erro.
--
-- PORQUÊ: aprovarPedidoPagamento() no app.js fazia duas escritas HTTP
-- separadas — PATCH pedidos_pagamento (estado='aprovado') e depois POST
-- pagos_jogo (um por jogo). Com rede instável, a primeira pode chegar ao
-- servidor e a segunda cair a meio: o pedido fica 'aprovado' mas o
-- pagamento nunca é lançado em pagos_jogo — e sem forma de recuperar pela
-- UI, porque o pedido já não aparece como 'pendente' (foi assim que
-- aconteceu com o pagamento do Alverca do João Hélder em 2026-08-23).
--
-- Esta função junta as duas escritas numa função só: corre numa
-- transação implícita do Postgres, portanto ou fica tudo gravado (estado
-- + pagamentos) ou nada fica — uma falha a meio (rede, RAISE EXCEPTION)
-- desfaz tudo o que a função já tinha feito. O app.js passa a chamar só
-- este RPC em vez das duas escritas.
--
-- Sem SECURITY DEFINER: quem chama já tem de ser admin para isto
-- funcionar, e as policies *_admin de pedidos_pagamento e pagos_jogo já
-- dão ao admin acesso total a ambas — não há RLS de outra pessoa para
-- saltar (ao contrário do eh_meu_amigo, que precisa de ver para lá do
-- RLS de user_amigos).
--
-- Tolerante: sem esta migração, a app cai no aviso "falta correr o
-- ficheiro" e o comportamento antigo (duas escritas separadas) mantém-se
-- até correres isto — nada parte.
-- =====================================================================

CREATE OR REPLACE FUNCTION goals.aprovar_pedido_pagamento(p_id bigint)
  RETURNS goals.pedidos_pagamento
  LANGUAGE plpgsql
AS $$
DECLARE
  v_pedido  goals.pedidos_pagamento;
  v_jogo_id bigint;
BEGIN
  IF NOT goals.is_admin() THEN
    RAISE EXCEPTION 'Apenas o admin pode aprovar pedidos de pagamento';
  END IF;

  -- mesma trava do PATCH …&estado=eq.pendente de antes: contra duplo
  -- toque ou duas sessões a decidir o mesmo pedido ao mesmo tempo.
  UPDATE goals.pedidos_pagamento
     SET estado       = 'aprovado',
         decidido_por = auth.email(),
         decidido_em  = now()
   WHERE id = p_id AND estado = 'pendente'
   RETURNING * INTO v_pedido;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Este pedido já tinha sido decidido.';
  END IF;

  FOREACH v_jogo_id IN ARRAY v_pedido.jogo_ids LOOP
    INSERT INTO goals.pagos_jogo (jogo_id, amigo_id)
    VALUES (v_jogo_id, v_pedido.amigo_id)
    ON CONFLICT (jogo_id, amigo_id) DO NOTHING;
  END LOOP;

  RETURN v_pedido;
END;
$$;

-- Anon nunca precisa disto (é sempre pós-login); is_admin() já filtra lá
-- dentro, isto é só mais uma camada.
REVOKE ALL ON FUNCTION goals.aprovar_pedido_pagamento(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION goals.aprovar_pedido_pagamento(bigint) TO authenticated;
