# Tarefas: core-graph

Plano: `tasks/plan.md` · Spec: `SPEC-core-graph.md`.

Valem para toda tarefa: `pnpm test`, `pnpm typecheck` e `pnpm lint` verdes, e um commit local ao final.

---

## Fase 1: Fundação

### T1: Scaffold do projeto e tooling

**Descrição:** Criar o esqueleto do repositório com as versões estáveis mais recentes, conferidas no dia: Node 26 LTS, TypeScript strict/ESM, pnpm, Biome e Vitest, além de `git init`, licença MIT e `.gitignore`.

**Critérios de aceite:**
- [x] `package.json` com versões exatas, `engines.node` em 26 e os scripts `test`, `typecheck`, `lint`, `db:generate`, `db:migrate`
- [x] Um teste trivial roda com `pnpm test`; `pnpm typecheck` e `pnpm lint` passam
- [x] `.gitignore` cobre `.env`, `node_modules` e saídas de build; `.env.example` sem segredos

**Verificação:**
- [x] `pnpm install && pnpm test && pnpm typecheck && pnpm lint`
- [x] `git status` limpo após o commit, sem `.env`

**Dependências:** nenhuma

**Arquivos:** `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `LICENSE`, `README.md`

**Escopo:** M (só configuração)

---

### T2: Banco, migrações e harness de testes

**Descrição:**
- **Versão do Postgres:** decidir PG19 ou PG18 pela regra do spec e fixar a tag.
- **Compose:** `docker-compose.yml` com `scram-sha-256`, volume nomeado, porta só em `127.0.0.1` e script de init que cria os roles `fluxie_migrator` e `fluxie_app` e o banco de teste.
- **Drizzle:** `drizzle.config.ts` apontando para `src/core-graph/schema.ts`, e uma migração custom que roda `CREATE EXTENSION vector`.
- **Testes:** um `globalSetup` do Vitest que migra o banco de teste, mais um helper de truncagem.

**Critérios de aceite:**
- [x] `docker compose up -d db && pnpm db:migrate` funciona do zero e `vector` aparece em `pg_extension` (critério 1)
- [x] `fluxie_app` consegue fazer DML, mas não DDL (teste comprova que `CREATE TABLE` falha)
- [x] A versão do Postgres escolhida e o motivo estão registrados no `README.md`

**Verificação:**
- [x] `docker compose down -v && docker compose up -d db && pnpm db:migrate && pnpm test`

**Dependências:** T1

**Arquivos:** `docker-compose.yml`, `docker/init-db.sql`, `drizzle.config.ts`, `migrations/0000_*.sql`, `tests/setup/global-setup.ts`, `tests/setup/db.ts`

**Escopo:** M

---

### Checkpoint A: Fundação
- [ ] Critério 1 verde; test, typecheck e lint verdes
- [ ] Versões registradas; revisão humana antes de seguir

---

## Fase 2: Entidades

### T3: Ontologia e spaces

**Descrição:**
- **Ontologia:** tipo `Ontology`, `registerOntology` e validação de tipo e `metadata` com Zod.
- **Erros:** os tipados `OntologyError`, `NotFoundError` e `VersionConflictError`.
- **Spaces:** tabela `spaces` e `createSpace`, que falha se o preset não estiver registrado.
- **Fixture:** a ontologia fictícia `project`, `learning` (draft) e `rule` (approved).

**Critérios de aceite:**
- [x] `createSpace` com preset não registrado falha com `OntologyError`; com preset registrado, cria o space
- [x] Os testes unitários da validação cobrem tipo inexistente, `metadata` inválido e `metadata` válido
- [x] `slug` duplicado é recusado

**Verificação:**
- [x] `pnpm test tests/core-graph/ontology tests/core-graph/spaces`

**Dependências:** T2

**Arquivos:** `src/core-graph/ontology.ts`, `src/core-graph/errors.ts`, `src/core-graph/schema.ts`, `src/core-graph/spaces.ts`, `tests/fixtures/ontology.ts`, testes

**Escopo:** M

---

### T4: Criar e atualizar entidades, com change_log

**Descrição:**
- **Tabelas:** `entities` (com `content_hash` e `tsv` gerados) e `change_log`, mais o helper `logChange`.
- **`upsertEntity`:** caminhos de criação e de atualização de draft, recusa de `key` com outro `type` e checagem de `expectedVersion`. Cada escrita grava no change_log na mesma transação.
- **`getEntity`:** versão básica, sem relações e sem propostas.

**Critérios de aceite:**
- [x] Critério 2: inválido, `OntologyError` e nada gravado, nem no change_log
- [x] Critério 3: nasce com `defaultStatus`; mesmo `key` atualiza e sobe `version`; o mesmo `key` em outro space cria outra entidade
- [x] Critérios 6 e 11: `content_hash` muda com `title`/`content` e não com `metadata`; `expectedVersion` desatualizado dá `VersionConflictError`

**Verificação:**
- [x] `pnpm test tests/core-graph/entities`
- [x] Migração gerada por `pnpm db:generate` e revisada

**Dependências:** T3

**Arquivos:** `src/core-graph/schema.ts`, `src/core-graph/entities.ts`, `src/core-graph/history.ts` (só `logChange`), `migrations/*`, `tests/core-graph/entities.test.ts`

**Escopo:** M

---

### T5: Status, uso e isolamento por space

**Descrição:**
- **`setStatus`:** muda o status com log no change_log.
- **`recordUsage`:** incrementa uso sem subir `version` e sem log.
- **Upsert sobre `rejected` ou `deprecated`:** aplica a mudança e volta para `draft`.
- **Escopo:** um helper comum que garante que todo id pertence ao `spaceId` informado.

**Critérios de aceite:**
- [x] Critério 5: upsert em entidade `rejected` ou `deprecated` aplica e volta para `draft`
- [x] Critério 8: `getEntity`, `setStatus` e `recordUsage` com id de outro space dão `NotFoundError`
- [x] Critério 9 (parcial): `setStatus` gera exatamente 1 linha com `before` e `after`; `recordUsage` não altera `version` nem o change_log

**Verificação:**
- [x] `pnpm test tests/core-graph/status`

**Dependências:** T4

**Arquivos:** `src/core-graph/entities.ts`, `src/core-graph/scope.ts`, `tests/core-graph/status.test.ts`

**Escopo:** S

---

### Checkpoint B: Entidades
- [ ] Critérios 2, 3, 5, 6, 8, 9 (parcial) e 11 verdes
- [ ] Revisão humana

---

## Fase 3: Curadoria e grafo

### T6: Propostas sobre entidades aprovadas

**Descrição:**
- **Tabela:** `entity_proposals`.
- **Upsert sobre `approved`:** cria uma proposta `pending` e não altera a entidade.
- **Funções:** `listProposals`, `acceptProposal` (aplica a proposta, falhando se `base_version` estiver desatualizado) e `rejectProposal`, todas com log no change_log.
- **`getEntity`:** passa a incluir as propostas pendentes.

**Critérios de aceite:**
- [x] Critério 4 completo: proposta criada; aceite aplica; rejeição descarta; os dois ficam registrados com `actor`; proposta desatualizada dá `VersionConflictError`
- [x] Aceitar uma proposta que muda `content` altera o `content_hash`
- [x] Ids de proposta de outro space dão `NotFoundError`

**Verificação:**
- [x] `pnpm test tests/core-graph/proposals`

**Dependências:** T5

**Arquivos:** `src/core-graph/schema.ts`, `src/core-graph/proposals.ts`, `src/core-graph/entities.ts`, `migrations/*`, `tests/core-graph/proposals.test.ts`

**Escopo:** M

---

### T7: Relações (link e unlink)

**Descrição:**
- **Tabela:** `relations`.
- **`linkEntities`:** valida o tipo de relação contra a ontologia, recusa ligação entre spaces diferentes e é idempotente.
- **`unlink`:** remove com o estado anterior gravado no change_log.
- **`getEntity`:** passa a incluir as relações.

**Critérios de aceite:**
- [x] Critério 7: relação fora da ontologia é recusada; relação entre spaces é recusada; repetir a ligação não duplica
- [x] `unlink` gera 1 linha no change_log com `before` preenchido e `after` nulo
- [x] Ids de outro space dão `NotFoundError`

**Verificação:**
- [x] `pnpm test tests/core-graph/relations`

**Dependências:** T4 (pode correr em paralelo com T5 e T6)

**Arquivos:** `src/core-graph/schema.ts`, `src/core-graph/relations.ts`, `src/core-graph/entities.ts`, `migrations/*`, `tests/core-graph/relations.test.ts`

**Escopo:** M

---

### T8: Vizinhança até 2 saltos

**Descrição:** `neighbors(spaceId, entityId, depth, opts)` com busca em largura (BFS) de até 2 níveis em TypeScript. Percorre os dois sentidos, controla os nós já visitados e aceita filtro por tipo de relação e por status.

**Critérios de aceite:**
- [x] Critério 12: os saltos 1 e 2 são retornados sem duplicatas
- [x] Um grafo com ciclo (A→B→C→A) termina e não repete nós
- [x] Os filtros `relationTypes` e `statuses` funcionam

**Verificação:**
- [x] `pnpm test tests/core-graph/neighbors`

**Dependências:** T7

**Arquivos:** `src/core-graph/relations.ts`, `tests/core-graph/neighbors.test.ts`

**Escopo:** S

---

### Checkpoint C: Curadoria e grafo
- [ ] Critérios 4, 7 e 12 verdes
- [ ] Revisão humana

---

## Fase 4: Histórico e fechamento

### T9: Histórico e revert

**Descrição:**
- **`history`:** devolve as entradas do change_log da entidade, em ordem.
- **`revertEntity`:** restaura `title`, `content`, `metadata` e `confidence` a partir do `after` da mudança escolhida. Preserva `key`, `type` e `status`, sobe `version` e registra a ação `revert`.

**Critérios de aceite:**
- [ ] Critério 10 completo
- [ ] Critério 9 completo: um teste percorre create, update, status, propose, accept, reject, unlink e revert e confere exatamente 1 linha por escrita, com `actor`, `before` e `after`
- [ ] Revert com `changeId` de outra entidade ou de outro space dá `NotFoundError`

**Verificação:**
- [ ] `pnpm test tests/core-graph/history`

**Dependências:** T6, T7

**Arquivos:** `src/core-graph/history.ts`, `tests/core-graph/history.test.ts`

**Escopo:** S

---

### T10: API pública e verificação final

**Descrição:**
- **`index.ts`:** exporta somente a API pública do spec. Um teste importa tudo só por `src/core-graph/index.ts`.
- **README:** seção de uso do módulo.
- **Rastreabilidade:** uma tabela no `tasks/plan.md` liga cada um dos 13 critérios aos seus testes.

**Critérios de aceite:**
- [ ] Nenhum teste importa arquivos internos, exceto os testes unitários de ontologia
- [ ] Os 13 critérios aparecem mapeados para testes verdes
- [ ] `docker compose down -v` seguido do fluxo completo (subir, migrar, testar) passa do zero

**Verificação:**
- [ ] `docker compose down -v && docker compose up -d db && pnpm db:migrate && pnpm test && pnpm typecheck && pnpm lint`

**Dependências:** T8, T9

**Arquivos:** `src/core-graph/index.ts`, `README.md`, `tasks/plan.md`, `tests/core-graph/public-api.test.ts`

**Escopo:** S

---

### Checkpoint final
- [ ] Os 13 critérios verdes; tudo verde a partir de um banco zerado
- [ ] Pronto para a fase 4 do lifecycle (`agent-skills:test`) e depois a Review
