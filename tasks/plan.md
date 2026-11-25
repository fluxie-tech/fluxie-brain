# Implementation Plan: core-graph

Spec: `SPEC-core-graph.md`. Mapa: `CAPABILITY-MAP.md`. Tarefas detalhadas: `tasks/todo.md`.

## Visão geral

Construir o núcleo de armazenamento do fluxie-brain: spaces, entidades, propostas, relações e histórico, em Postgres via Drizzle. Toda escrita é validada pela ontologia do space e registrada no change_log. Ao final, os 13 critérios de sucesso do spec passam em testes de integração.

## Grafo de dependências

```
T1 scaffold (Node, pnpm, Biome, Vitest, git)
 └─ T2 banco + migrações + harness de teste (compose, roles, extensão vector)
     └─ T3 ontologia + spaces
         └─ T4 entidades: upsert/get + change_log
             ├─ T5 setStatus, recordUsage, escopo por space
             │   └─ T6 propostas (precisa do status approved)
             ├─ T7 relações: link/unlink
             │   └─ T8 neighbors (BFS de 2 níveis)
             └─ T9 history + revert (precisa do change_log; testa com propostas)
                 └─ T10 API pública + varredura final dos 13 critérios
```

## Decisões de arquitetura

- **Fatias verticais por capacidade da API:** cada tarefa entrega schema, função, testes e export juntos, e deixa o projeto verde.
- **Migrações incrementais:** cada tarefa que mexe no schema gera sua migração com `drizzle-kit generate`. Como nada foi aplicado fora do ambiente local, pode-se consolidar tudo numa migração inicial antes da v1, se ficar mais limpo.
- **Dois roles no Postgres:** `fluxie_migrator` é dono do schema e roda as migrações; `fluxie_app` só tem DML e é usado pela API e pelos testes. A truncagem entre testes usa a conexão do migrator no setup.
- **Risco cedo:** T1 e T2 validam primeiro a combinação de versões (Node 26 + drizzle-kit + Vitest + PG19/pgvector), antes de qualquer lógica.
- **Repositório:** `git init` local na T1, um commit por tarefa. Criar o repositório público `fluxie-tech/fluxie-brain` e dar push é ação externa e fica para a fase Ship, com confirmação.

## Lista de tarefas

### Fase 1: Fundação
- [x] T1: Scaffold do projeto e tooling
- [x] T2: Banco, migrações e harness de testes

### Checkpoint A: Fundação
- [ ] `docker compose up -d db && pnpm db:migrate` do zero, com a extensão `vector` ativa (critério 1)
- [ ] `pnpm test`, `pnpm typecheck` e `pnpm lint` verdes
- [ ] Versões escolhidas registradas (PG19 ou PG18), revisão humana

### Fase 2: Entidades
- [x] T3: Ontologia e spaces
- [x] T4: Criar e atualizar entidades, com change_log
- [x] T5: Status, uso e isolamento por space

### Checkpoint B: Entidades
- [ ] Critérios 2, 3, 5, 6, 8, 9 e 11 cobertos por testes verdes
- [ ] Revisão humana

### Fase 3: Curadoria e grafo
- [x] T6: Propostas sobre entidades aprovadas
- [x] T7: Relações (link e unlink)
- [x] T8: Vizinhança até 2 saltos

### Checkpoint C: Curadoria e grafo
- [ ] Critérios 4, 7 e 12 cobertos por testes verdes
- [ ] Revisão humana

### Fase 4: Histórico e fechamento
- [x] T9: Histórico e revert
- [x] T10: API pública e verificação final

### Checkpoint final
- [x] Os 14 critérios do spec mapeados para testes verdes
- [x] `pnpm test`, `pnpm typecheck` e `pnpm lint` verdes
- [ ] Pronto para a fase Verify/Review

## Rastreabilidade: critérios do spec → testes

| # | Critério | Testes (`tests/core-graph/`) |
|---|---|---|
| 1 | Banco sobe do zero com `vector` | `database.test.ts` (extensão, DDL negado ao app) + fluxo `down -v → up → migrate → test` |
| 2 | Tipo/metadata inválidos ou key com outro tipo → `OntologyError`, nada gravado | `entities.test.ts` (unknown type, invalid metadata, key with different type), `ontology.test.ts` |
| 3 | Status padrão; mesmo key atualiza; outro space separa | `entities.test.ts` |
| 4 | Edição de `approved` vira proposta; aceite, rejeição, desatualizada | `proposals.test.ts` |
| 5 | `rejected`/`deprecated` voltam para `draft` | `status.test.ts` |
| 6 | `content_hash` muda com title/content, não com metadata | `entities.test.ts`, `proposals.test.ts` |
| 7 | Relação fora da ontologia/entre spaces recusada; idempotente | `relations.test.ts` |
| 8 | Ids de outro space → `NotFoundError` | `status.test.ts`, `proposals.test.ts`, `relations.test.ts`, `neighbors.test.ts`, `history.test.ts` |
| 9 | Uma linha de change_log por escrita; `recordUsage` sem log | `history.test.ts` (varredura completa), `status.test.ts` |
| 10 | Revert restaura conteúdo, preserva key/type/status | `history.test.ts` |
| 11 | `expectedVersion` desatualizado → `VersionConflictError` | `entities.test.ts` |
| 12 | `neighbors` 1–2 saltos, sem duplicatas, termina em ciclos | `neighbors.test.ts` |
| 13 | test, typecheck e lint verdes | verificação final da T10 |
| 14 | Upsert sem mudança não grava; metadata omitida preservada; proposta idêntica não duplica | `entities.test.ts`, `proposals.test.ts`, `status.test.ts` |

Superfície pública fixada por `public-api.test.ts`.

**Verify (fase 4):** `edge-cases.test.ts` cobre corridas de create e de aceite, `confidence` fora de 0..1 (bug encontrado e corrigido), ids repetidos em `recordUsage` e `spaceId` malformado.

## Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| Não há imagem `pgvector/pgvector:pg19` nem pgvector estável para PG19 | Médio | Regra do spec: cair para PG18 na última minor. Decidido na T2 e registrado. |
| drizzle-kit ou Vitest com problema no Node 26 | Médio | Detectado na T1/T2 antes de qualquer lógica. Fallback: Node 24 LTS, perguntando antes. |
| Drizzle sem tipo nativo para `tsvector` ou colunas geradas com expressão | Baixo | `customType` para `tsvector` e `generatedAlwaysAs(sql...)`. Se não der, SQL na migração custom. |
| `neighbors` entra em loop em ciclos | Médio | BFS com conjunto de visitados e teste com ciclo explícito (T8). |
| Docker Desktop no Windows: volumes e portas | Baixo | Volume nomeado (não bind mount) e porta só em `127.0.0.1` localmente. |
| Truncagem entre testes deixa estado residual com testes em paralelo | Baixo | Testes de banco em série (`fileParallelism: false`) até isso virar gargalo. |

## Perguntas em aberto

- Nenhuma bloqueante. A versão do Postgres é decidida na T2 pela regra do spec.
