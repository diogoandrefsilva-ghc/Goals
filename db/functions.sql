-- =====================================================================
-- Goals — Funções (schema `goals`)
-- Ordem: schema.sql -> functions.sql -> policies.sql
--
-- Nota de segurança: a maioria corre como o utilizador chamador (sem
-- SECURITY DEFINER), apoiando-se no RLS das próprias tabelas. `eh_meu_amigo`
-- precisa de ver para lá do RLS de `user_amigos`, por isso é SECURITY DEFINER
-- com search_path fixo — o mesmo padrão do `meu_amigo` do FestasBV.
-- =====================================================================

-- Admin? (compara email autenticado com o admin fixo)
CREATE OR REPLACE FUNCTION goals.is_admin()
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT auth.email() = 'diogo.andre.f.silva@gmail.com';
$$;

-- Utilizador tem acesso? (email consta em allowed_users)
CREATE OR REPLACE FUNCTION goals.is_allowed()
  RETURNS boolean LANGUAGE sql STABLE
AS $$
  SELECT auth.email() IN (SELECT email FROM goals.allowed_users);
$$;

-- Este amigo (por id) é a pessoa ligada ao login autenticado? Vai pelo NOME
-- (goals.user_amigos.amigo), não pelo id — o id é por época, o nome é a
-- identidade estável. Sem conceito de cônjuge (ao contrário do FestasBV):
-- um login liga-se a um amigo só.
CREATE OR REPLACE FUNCTION goals.eh_meu_amigo(p_amigo_id bigint)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'goals', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM goals.amigos a
    JOIN goals.user_amigos u ON u.amigo = a.nome
    WHERE a.id = p_amigo_id
      AND u.email = auth.email()
  );
$$;

-- ---------------------------------------------------------------------
-- Guarda de inserção dos pedidos de pagamento: o que a app manda no pedido
-- não decide nada — nasce sempre 'pendente', sem decisão, carimbado por
-- quem o fez. Só o admin (via UPDATE, policy própria) aprova/rejeita.
-- Mesmo padrão do festasbv.pagpend_guard_ins.
--
-- Também é aqui que se recusa o MESMO pedido duas vezes: um pedido
-- pendente não marca nada como pago (pendente não é dinheiro), por isso
-- os jogos ficam na lista "por pagar" na mesma e quem enviou pensa que
-- não foi e carrega outra vez (aconteceu, 2026-08-31). A UI já não deixa
-- (renderMeuPedidoBox mostra-os como "aguarda confirmação"), mas dois
-- dispositivos ao mesmo tempo só param aqui.
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

  -- jogos repetidos DENTRO do mesmo pedido: o bloco do membro está
  -- montado duas vezes (Resumo e Contas) e o cliente lê as checkboxes
  -- dos dois de uma vez.
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
