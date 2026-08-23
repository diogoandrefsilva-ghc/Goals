# Goals — Base de dados (Supabase)

Fonte de verdade do schema `goals` no **mesmo projeto Supabase do FestasBV**
(`diogoandrefsilva-personalapps-database`, `https://gjweqwfbnkgnibhajldc.supabase.co`).
`goals` é um schema à parte de `festasbv` — tabelas, RLS e admin próprios,
não mexe em nada do FestasBV.

## Regra de ouro

**O repo é a fonte; o Supabase segue atrás.** Quando há uma alteração ao
schema, funções ou policies, edita-se primeiro o ficheiro `.sql` aqui e só
depois se cola no SQL Editor do Supabase.

## Ordem de execução

Numa BD limpa (ou pela primeira vez, neste projeto):

1. `schema.sql` — schema `goals`, tabelas, constraints, GRANTs e `ENABLE ROW LEVEL SECURITY`.
   Inclui o `GRANT USAGE ON SCHEMA goals TO service_role` (+ tabelas/sequences):
   sem isto a `service_role` (as Edge Functions de push) não consegue ler
   nem escrever NADA em `goals.*` — falha com "permission denied for
   schema goals" (42501). **Foi a causa real de as notificações push nunca
   chegarem** (2026-08-15): a função reportava sucesso (HTTP 200) porque
   apanhava o erro e seguia em frente com 0 subscrições, sem nunca chegar
   a mandar nada. RLS bypass (`BYPASSRLS`) só ignora policies — GRANTs
   continuam a ser precisos à mesma, e só ficam automáticos no schema
   `public`, nunca num schema à parte como este.
2. `functions.sql` — `is_admin`, `is_allowed`, `eh_meu_amigo` + o trigger de
   `pedidos_pagamento`
3. `policies.sql` — RLS policies (dependem das funções)
4. `admin_pass_temp.sql` — opcional mas recomendado: dá ao admin uma forma
   de gerar uma password temporária para alguém sem depender de email
   nenhum (ver "Recuperação de password" abaixo). Idempotente, tolerante:
   sem ela, o botão em Definições › Utilizadores diz que falta correr o
   ficheiro e mais nada muda.
5. `push-subscriptions.sql` — opcional: ativa as notificações Web Push
   (pedido de acesso, pagamento declarado, resultado de jogo fechado — ver
   `push-notificar-goals.ts` na raiz do repo, deploy à parte no Supabase).
   Idempotente, tolerante: sem ela, PUSH_COL fica false e o botão "Ativar
   notificações" em Definições › Conta esconde-se.
6. `push-notificacoes.sql` — opcional (mas recomendado se usares o passo
   5): outbox das notificações push + retry de 30 em 30 min via pg_cron,
   para o que falhar da primeira vez (ver `push-retry-goals.ts` na raiz do
   repo, deploy à parte). Idempotente, tolerante: sem ela, o envio imediato
   continua a funcionar exatamente como antes, só sem rede de segurança
   para o que falhar. Requer o passo manual 5 abaixo (secret na Vault) para
   o retry em si funcionar — sem esse secret o SQL corre à mesma, só o
   `cron.job` fica sem credenciais válidas até o criares.
7. `sync-log.sql` — opcional: `goals.sync_log`, o rasto de cada tentativa do
   botão "Procurar jogos" (browser → Edge Function → Gemini). Idempotente,
   tolerante: sem ela o botão funciona na mesma, só sem diagnóstico.
8. `jogos-por-definir.sql` — opcional: as colunas `por_definir`/`data_ate` em
   `goals.jogos`, que são o que permite gravar os jogos que o Sporting joga de
   certeza mas ainda sem adversário sorteado (fase de liga da Champions, a
   eliminatória da Taça em que a I Liga entra). Idempotente, tolerante: sem
   ela essa secção do painel de sugestões diz que falta correr o ficheiro e
   nada mais muda. **Numa BD limpa não é preciso** — as colunas já vão no
   `schema.sql`; isto é só para as BD que já existiam antes.
9. `aprovar_pedido_pagamento.sql` — recomendado: `goals.aprovar_pedido_pagamento`,
   que junta numa função só (uma transação) marcar o pedido como aprovado e
   lançar o pagamento em `pagos_jogo` — antes eram dois pedidos HTTP
   separados, e uma queda de rede a meio deixava o pedido "aprovado" sem o
   pagamento correspondente, sem forma de recuperar pela UI. Idempotente,
   tolerante: sem ela, `aprovarPedidoPagamento()` cai no comportamento antigo
   de duas escritas (o mesmo risco de antes, mas nada parte).
10. `jogos-potenciais.sql` — opcional: as colunas `potencial`/`condicao` em
    `goals.jogos`, o oposto do `jogos-por-definir.sql` — rondas que o Sporting
    só chega a jogar SE vencer a anterior ou SE não ficar no top 8 da fase de
    liga da Champions (play-off de acesso aos oitavos, quartos/meias/final da
    Taça de Portugal e da Taça da Liga). Ficam de fora da Previsão e do total
    de jogos da época enquanto `potencial=true`. Idempotente, tolerante: sem
    ela essa secção do painel de sugestões diz que falta correr o ficheiro e
    nada mais muda.

## Passos manuais (fora do SQL Editor)

Estes não se fazem por SQL — são configuração do projeto Supabase:

1. **Expor o schema `goals` na API**: Project Settings → API → Data API →
   "Exposed schemas" → acrescentar `goals` ao lado de `festasbv`. Sem isto o
   PostgREST devolve 404 a tudo.
2. **Redirect URL**: Authentication → URL Configuration → Redirect URLs →
   acrescentar o URL onde o Goals fica servido (ex.
   `https://diogoandrefsilva-ghc.github.io/Goals/`). Sem isto o login por
   link/código falha com "requested path is invalid".
3. **Template de email "Reset Password"**: ⚠️ **não editável neste projeto**
   sem SMTP próprio configurado (o Supabase bloqueia a edição de templates
   até se ligar um serviço de SMTP externo) — por isso o "Esqueci-me da
   password" do login fica com o template genérico do Supabase (sem o
   código de 6 dígitos) e pode falhar se o scanner de segurança do email do
   destinatário abrir o link primeiro. **Não é preciso resolver isto**: a
   app tem a alternativa que já usas no FestasBV — ver "Recuperação de
   password" abaixo.
4. **Secret na Vault para o retry de notificações** (só se correres
   `push-notificacoes.sql`): Project Settings → Vault → "New secret" →
   nome `service_role_key`, valor a tua service_role key (Project
   Settings → API → service_role). É o que o pg_cron usa para autenticar
   a chamada à `push-retry-goals` de 30 em 30 min — nunca fica em texto no
   repo nem em código, só na Vault. Sem este passo o retry não tem efeito
   (a função responde 403), mas nada mais é afetado.
5. **Bootstrap inicial** (uma vez, depois das tabelas criadas):
   ```sql
   INSERT INTO goals.allowed_users (email) VALUES ('diogo.andre.f.silva@gmail.com');
   -- opcional, só se quiseres aparecer também como jogador:
   INSERT INTO goals.user_amigos (email, amigo) VALUES ('diogo.andre.f.silva@gmail.com', 'O TEU NOME NA LISTA DE AMIGOS');
   ```
   `is_admin()` sozinho não chega para entrar na app — `sbAposLogin` exige
   sempre uma linha em `allowed_users`, admin incluído (mesma regra do
   FestasBV).

## Recuperação de password (sem depender de email)

Sem SMTP próprio, o email de recuperação não é fiável — é a mesma
limitação que o FestasBV já documenta, e a solução é a mesma:
**Definições › Utilizadores › "Password temporária"**. Escolhes a conta,
a app gera uma password legível (ex. `sporting-4821`), dita-la-lhe por
telefone/WhatsApp, e a pessoa entra e troca-a em Definições › Conta
("Alterar password"). Não passa pelo email em nenhum momento.

- Requer `admin_pass_temp.sql` corrido (passo 4 da ordem de execução).
- Do lado do servidor: só o admin pode chamar a função
  (`goals.is_admin()`), só para contas já em `allowed_users`, nunca para
  a conta do próprio admin (essa muda-se no Supabase). Esconder o botão
  na UI não seria proteção nenhuma — a função verifica por si.
- Se um dia ligares SMTP próprio a este projeto, o "Esqueci-me da
  password" do login passa a funcionar normalmente (com o link+código),
  sem precisar de tocar em nada disto — as duas vias coexistem.

## Conteúdo

- **schema.sql** — `allowed_users`, `access_requests`, `user_amigos`,
  `config`, e o núcleo por época (`epocas` → `amigos`, `jogos`, `pagos_jogo`,
  `estouros`, `estouro_participantes`, `estouro_pagos`, `creditos_extra`,
  `pedidos_pagamento`), tudo `ON DELETE CASCADE` a partir de `epocas`. IDs
  `bigint GENERATED BY DEFAULT AS IDENTITY` — cada mutação é uma linha de
  cada vez (POST/PATCH/DELETE), a app lê o id de volta da resposta do POST,
  nunca o inventa.
- **functions.sql** — `is_admin()`, `is_allowed()`, `eh_meu_amigo(bigint)`
  (liga um `amigos.id` ao login autenticado via `user_amigos.amigo`, por
  NOME — o id é por época, o nome é a identidade estável) e o trigger
  `pedidos_pagamento_guard_ins` (um pedido nasce sempre `pendente`, carimbado
  por quem o fez).
- **policies.sql** — leitura para `is_allowed()` em tudo (transparência total
  do pote, como o FestasBV), escrita total só para `is_admin()`, e as regras
  "self" de `pedidos_pagamento` (o amigo só pede/cancela o que é seu).
- **admin_pass_temp.sql** — `goals.admin_pass_temp(email, password)`
  (SECURITY DEFINER): a rede de segurança da recuperação de password sem
  SMTP próprio, ver secção acima. Opcional.
- **push-subscriptions.sql** / **push-notificacoes.sql** — notificações Web
  Push (dispositivo ↔ conta) e a outbox+retry do que falhar a enviar.
  Opcionais, tolerantes. Ver `push-notificar-goals.ts` e
  `push-retry-goals.ts` na raiz do repo.
- **aprovar_pedido_pagamento.sql** — `goals.aprovar_pedido_pagamento(id)`:
  marcar `aprovado` + lançar `pagos_jogo` numa única transação, para uma
  falha de rede a meio não deixar as duas escritas dessincronizadas.
  Recomendado, tolerante.

## Modelo de permissões

| Ação | Admin | Amigo ligado (`user_amigos`) | Conta sem `allowed_users` |
|---|---|---|---|
| Ver tudo (jogos, dívidas, estouro) | ✅ | ✅ | ❌ (ecrã "sem acesso") |
| Adicionar/editar jogos e resultados | ✅ | ❌ | ❌ |
| Gerir amigos, épocas, valor por golo | ✅ | ❌ | ❌ |
| Marcar um jogo como pago | ✅ direto | ❌ (só pedir, ver abaixo) | ❌ |
| Pedir "já paguei os jogos X, Y" | ✅ | ✅ só o seu (`eh_meu_amigo`) | ❌ |
| Aprovar/rejeitar um pedido de pagamento | ✅ | ❌ | ❌ |
| Cancelar o próprio pedido (enquanto pendente) | ✅ | ✅ | ❌ |
| Estouro (eventos, quem levantou o pote) | ✅ | ❌ | ❌ |
| Aprovar pedidos de acesso | ✅ | ❌ | ❌ |
| Ligar um email a um amigo (`user_amigos`) | ✅ | ❌ | ❌ |

Quem pode mexer no quê resolve-se por NOME via `user_amigos` (`eh_meu_amigo`)
— não há conceito de cônjuge/casal no Goals, ao contrário do FestasBV.

## ⚠️ Segredos — nunca commitar

- A **service_role key** ignora todo o RLS — nunca entra em ficheiro nenhum
  do repo.
- A **anon key** que vive em `app.js` é pública por design (protegida por RLS
  + login), tal como no FestasBV — não é bug, não se esconde.

## Recriar do zero

```sql
-- no SQL Editor do Supabase, por ordem:
--   1) schema.sql
--   2) functions.sql
--   3) policies.sql
```

Antes: expor o schema `goals` em Project Settings → API → Data API →
Exposed schemas (senão os GRANTs não chegam e dá HTTP 403 / código 42501).
