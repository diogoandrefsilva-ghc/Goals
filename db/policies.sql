-- =====================================================================
-- Goals — RLS Policies (schema `goals`)
--
-- PRÉ-REQUISITO: depende das funções em functions.sql —
--   goals.is_admin(), goals.is_allowed(), goals.eh_meu_amigo(bigint)
-- Correr functions.sql ANTES deste ficheiro.
--
-- Ordem de execução geral: schema.sql -> functions.sql -> policies.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- access_requests
-- ---------------------------------------------------------------------
CREATE POLICY ar_insert ON goals.access_requests
  FOR INSERT TO authenticated
  WITH CHECK (email = auth.email());

CREATE POLICY ar_admin_sel ON goals.access_requests
  FOR SELECT TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

CREATE POLICY ar_admin_del ON goals.access_requests
  FOR DELETE TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

-- ---------------------------------------------------------------------
-- allowed_users
-- ---------------------------------------------------------------------
CREATE POLICY au_select ON goals.allowed_users
  FOR SELECT TO authenticated
  USING ((email = auth.email()) OR (auth.email() = 'diogo.andre.f.silva@gmail.com'::text));

CREATE POLICY au_admin_ins ON goals.allowed_users
  FOR INSERT TO authenticated
  WITH CHECK (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

CREATE POLICY au_admin_del ON goals.allowed_users
  FOR DELETE TO authenticated
  USING (auth.email() = 'diogo.andre.f.silva@gmail.com'::text);

-- ---------------------------------------------------------------------
-- user_amigos  (liga login -> nome de amigo; só o admin gere as ligações,
-- cada utilizador vê a sua própria)
-- ---------------------------------------------------------------------
CREATE POLICY ua_sel ON goals.user_amigos
  FOR SELECT TO authenticated
  USING ((email = auth.email()) OR goals.is_admin());

CREATE POLICY ua_admin ON goals.user_amigos
  FOR ALL TO authenticated
  USING (goals.is_admin())
  WITH CHECK (goals.is_admin());

-- ---------------------------------------------------------------------
-- config  (leitura: qualquer autenticado com acesso; escrita: só admin)
-- ---------------------------------------------------------------------
CREATE POLICY cfg_sel ON goals.config
  FOR SELECT TO authenticated
  USING (goals.is_allowed());

CREATE POLICY cfg_upd ON goals.config
  FOR UPDATE TO authenticated
  USING       (goals.is_admin())
  WITH CHECK  (goals.is_admin());

-- ---------------------------------------------------------------------
-- epocas / amigos / jogos / pagos_jogo / estouros / estouro_participantes
-- / estouro_pagos / creditos_extra: leitura para qualquer is_allowed()
-- (transparência total do pote, como no FestasBV), escrita só admin —
-- é a mesma fronteira que o roGuard() já impunha na UI.
-- ---------------------------------------------------------------------
CREATE POLICY epocas_sel ON goals.epocas
  FOR SELECT TO authenticated
  USING (goals.is_allowed());
CREATE POLICY epocas_admin ON goals.epocas
  FOR ALL TO authenticated
  USING (goals.is_admin()) WITH CHECK (goals.is_admin());

CREATE POLICY amigos_sel ON goals.amigos
  FOR SELECT TO authenticated
  USING (goals.is_allowed());
CREATE POLICY amigos_admin ON goals.amigos
  FOR ALL TO authenticated
  USING (goals.is_admin()) WITH CHECK (goals.is_admin());

CREATE POLICY jogos_sel ON goals.jogos
  FOR SELECT TO authenticated
  USING (goals.is_allowed());
CREATE POLICY jogos_admin ON goals.jogos
  FOR ALL TO authenticated
  USING (goals.is_admin()) WITH CHECK (goals.is_admin());

CREATE POLICY pagos_jogo_sel ON goals.pagos_jogo
  FOR SELECT TO authenticated
  USING (goals.is_allowed());
CREATE POLICY pagos_jogo_admin ON goals.pagos_jogo
  FOR ALL TO authenticated
  USING (goals.is_admin()) WITH CHECK (goals.is_admin());

CREATE POLICY estouros_sel ON goals.estouros
  FOR SELECT TO authenticated
  USING (goals.is_allowed());
CREATE POLICY estouros_admin ON goals.estouros
  FOR ALL TO authenticated
  USING (goals.is_admin()) WITH CHECK (goals.is_admin());

CREATE POLICY estouro_participantes_sel ON goals.estouro_participantes
  FOR SELECT TO authenticated
  USING (goals.is_allowed());
CREATE POLICY estouro_participantes_admin ON goals.estouro_participantes
  FOR ALL TO authenticated
  USING (goals.is_admin()) WITH CHECK (goals.is_admin());

CREATE POLICY estouro_pagos_sel ON goals.estouro_pagos
  FOR SELECT TO authenticated
  USING (goals.is_allowed());
CREATE POLICY estouro_pagos_admin ON goals.estouro_pagos
  FOR ALL TO authenticated
  USING (goals.is_admin()) WITH CHECK (goals.is_admin());

CREATE POLICY creditos_extra_sel ON goals.creditos_extra
  FOR SELECT TO authenticated
  USING (goals.is_allowed());
CREATE POLICY creditos_extra_admin ON goals.creditos_extra
  FOR ALL TO authenticated
  USING (goals.is_admin()) WITH CHECK (goals.is_admin());

-- ---------------------------------------------------------------------
-- pedidos_pagamento
--   sel      admin vê tudo; o amigo vê os seus
--   self_ins qualquer amigo pede, mas só por si (eh_meu_amigo)
--   self_del cancela enquanto não estiver aprovado
--   admin    tudo (é ele que aprova/rejeita)
-- Não há policy de UPDATE para o amigo, de propósito: mudar um pedido
-- depois de o admin o ter visto é reescrever o que ele está a decidir.
-- Quem se enganou apaga (self_del) e pede outra vez.
-- ---------------------------------------------------------------------
CREATE POLICY pedidos_pagamento_sel ON goals.pedidos_pagamento
  FOR SELECT TO authenticated
  USING (goals.is_admin() OR goals.eh_meu_amigo(amigo_id));

CREATE POLICY pedidos_pagamento_self_ins ON goals.pedidos_pagamento
  FOR INSERT TO authenticated
  WITH CHECK (goals.is_allowed() AND goals.eh_meu_amigo(amigo_id));

CREATE POLICY pedidos_pagamento_self_del ON goals.pedidos_pagamento
  FOR DELETE TO authenticated
  USING (goals.eh_meu_amigo(amigo_id) AND estado <> 'aprovado');

CREATE POLICY pedidos_pagamento_admin ON goals.pedidos_pagamento
  FOR ALL TO authenticated
  USING (goals.is_admin())
  WITH CHECK (goals.is_admin());
