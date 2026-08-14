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
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION goals.pedpag_guard_ins()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'goals', 'public'
AS $$
BEGIN
  IF NOT goals.is_admin() THEN
    NEW.estado       := 'pendente';
    NEW.decidido_por := NULL;
    NEW.decidido_em  := NULL;
    NEW.motivo       := NULL;
  END IF;
  NEW.criado_por_email := COALESCE(auth.email(), '');
  NEW.criado_em        := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pedidos_pagamento_guard_ins ON goals.pedidos_pagamento;
CREATE TRIGGER pedidos_pagamento_guard_ins
  BEFORE INSERT ON goals.pedidos_pagamento
  FOR EACH ROW EXECUTE FUNCTION goals.pedpag_guard_ins();
