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
             │   └─ T8 neighbors (CTE recursiva)
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
- [ ] T1: Scaffold do projeto e tooling
- [ ] T2: Banco, migrações e harness de testes

### Checkpoint A: Fundação
- [ ] `docker compose up -d db && pnpm db:migrate` do zero, com a extensão `vector` ativa (critério 1)
- [ ] `pnpm test`, `pnpm typecheck` e `pnpm lint` verdes
- [ ] Versões escolhidas registradas (PG19 ou PG18), revisão humana

### Fase 2: Entidades
- [ ] T3: Ontologia e spaces
- [ ] T4: Criar e atualizar entidades, com change_log
- [ ] T5: Status, uso e isolamento por space

### Checkpoint B: Entidades
- [ ] Critérios 2, 3, 5, 6, 8, 9 e 11 cobertos por testes verdes
- [ ] Revisão humana

### Fase 3: Curadoria e grafo
- [ ] T6: Propostas sobre entidades aprovadas
- [ ] T7: Relações (link e unlink)
- [ ] T8: Vizinhança até 2 saltos

### Checkpoint C: Curadoria e grafo
- [ ] Critérios 4, 7 e 12 cobertos por testes verdes
- [ ] Revisão humana

### Fase 4: Histórico e fechamento
- [ ] T9: Histórico e revert
- [ ] T10: API pública e verificação final

### Checkpoint final
- [ ] Os 13 critérios do spec mapeados para testes verdes
- [ ] `pnpm test`, `pnpm typecheck` e `pnpm lint` verdes
- [ ] Pronto para a fase Verify/Review

## Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| Não há imagem `pgvector/pgvector:pg19` nem pgvector estável para PG19 | Médio | Regra do spec: cair para PG18 na última minor. Decidido na T2 e registrado. |
| drizzle-kit ou Vitest com problema no Node 26 | Médio | Detectado na T1/T2 antes de qualquer lógica. Fallback: Node 24 LTS, perguntando antes. |
| Drizzle sem tipo nativo para `tsvector` ou colunas geradas com expressão | Baixo | `customType` para `tsvector` e `generatedAlwaysAs(sql...)`. Se não der, SQL na migração custom. |
| CTE recursiva de `neighbors` entra em loop em ciclos | Médio | Controle de caminho visitado na CTE e teste com ciclo explícito (T8). |
| Docker Desktop no Windows: volumes e portas | Baixo | Volume nomeado (não bind mount) e porta só em `127.0.0.1` localmente. |
| Truncagem entre testes deixa estado residual com testes em paralelo | Baixo | Testes de banco em série (`fileParallelism: false`) até isso virar gargalo. |

## Perguntas em aberto

- Nenhuma bloqueante. A versão do Postgres é decidida na T2 pela regra do spec.
