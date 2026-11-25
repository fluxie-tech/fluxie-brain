# Implementation Plan: presets

Spec: `SPEC-presets.md`. Mapa: `CAPABILITY-MAP.md`. Tarefas detalhadas: `tasks/todo.md`.
Plano anterior (concluído): `tasks/core-graph/`.

## Visão geral

Criar o módulo `src/presets` com o tipo genérico `Preset`, o registro (`registerPresets`, `listPresets`, `getPreset`) e o Development Graph: 10 tipos de entidade e 12 relações adaptados do dev-graph do omnigraph-cookbooks. A entrega fecha com um corpus fictício PT/EN, carregado pelo core-graph real, que prova a separação por stack entre dois projetos no mesmo space. O core-graph não muda.

## Grafo de dependências

```
T1 base: tipos genéricos + registro + estrutura (repo, component, dependency, spec)
 └─ T2 conhecimento de governança: decision, principle, invariant
     └─ T3 conhecimento externo e lições: assumption, gap, learning (ontologia completa)
         └─ T4 corpus fictício + prova multiprojeto e âncoras
             └─ T5 API pública fixada, créditos, rastreabilidade, check:task
```

É uma cadeia, sem paralelismo útil: cada relação só entra quando os tipos das duas pontas existem, porque o teste de coerência exige isso.

## Decisões de arquitetura

- **Fatias por grupo de tipos:** cada tarefa entrega tipos, relações, descrições e instruções, com teste unitário e de integração, e deixa o projeto verde. Não há uma tarefa só para "todos os schemas" e outra só para "todos os testes".
- **Risco cedo (T1):** a T1 confere três coisas no `typecheck` e no primeiro teste:
  - que `Preset['ontology']` é aceito por `registerOntology` sem cast;
  - que `satisfies Preset` preserva as chaves literais;
  - que `z.toJSONSchema()` converte `z.strictObject` com `.meta()`.
  Se o tipo não for atribuível, o plano para e pergunta antes de mexer na API do core-graph.
- **Testes de unidade sem banco, integração com banco:** a coerência da ontologia e os schemas são testados como lógica pura. O caminho pelo core-graph real usa o harness existente (`tests/setup/db.ts`, `truncateAll`, `fileParallelism: false`).
- **Arquivo do preset:** começa em `src/presets/development-graph.ts`. Quando passar de 300 linhas (provável na T3, por causa das instruções), vira `src/presets/development-graph/{index,entities,relations}.ts`. Só `src/presets/index.ts` é importado de fora.
- **Corpus em JSON** (`tests/fixtures/development-graph/corpus.json`): o `embeddings` e scripts de benchmark podem lê-lo sem TypeScript. O Biome formata JSON, então o arquivo segue o formatter.
- **Commits:** um por tarefa, no branch `spec/presets`, com o e-mail noreply. O PR sai na fase Ship.

## Tarefas

Detalhes, critérios de aceite e verificação em `tasks/todo.md`.

### Fase 1: Base
- [x] T1: tipos genéricos, registro e tipos estruturais (S/M)

### Fase 2: Ontologia completa
- [x] T2: decision, principle e invariant (S)
- [x] T3: assumption, gap e learning, fechando a ontologia (M)

### Checkpoint A: ontologia completa
- [ ] 10 tipos e 12 relações do spec, coerentes, com descrição e instrução
- [ ] `pnpm check:task` verde
- [x] Revisão humana das descrições e instruções, que são o que o agente vai ler (aprovada em 2026-11-25)

### Fase 3: Corpus e fechamento
- [x] T4: corpus fictício PT/EN e prova multiprojeto (M)
- [x] T5: API pública, créditos e rastreabilidade (S)

### Checkpoint B: completo
- [ ] Os 10 critérios de sucesso do spec ligados a testes (tabela abaixo, preenchida na T5)
- [ ] `pnpm check:task` verde, com o banco no ar (`docker compose up -d --wait db`)
- [ ] Pronto para a fase Verify

## Rastreabilidade: critérios do spec → testes

| # | Critério | Testes e verificações (`tests/presets/`) |
|---|---|---|
| 1 | `registerPresets` + `createSpace` + idempotência | `integration.test.ts` (`registerPresets` chamado duas vezes; space com `development-graph`) |
| 2 | 10 tipos e 12 relações, status e campos, pontas existentes | `development-graph.test.ts` ("exactly the entity types…", "exactly the relations…", "only links entity types that exist"); campos por tipo nos exemplos válidos |
| 3 | `description` e `instruction` com convenção de key | `development-graph.test.ts` ("describes every…", "teaches the key convention…") |
| 4 | Metadata estrito, JSON Schema, `OntologyError` legível | `development-graph.test.ts` (JSON Schema fechado com descrição por campo; chave desconhecida e enum inválido recusados); `integration.test.ts` (`Invalid metadata for "repo"`, nada gravado) |
| 5 | Corpus completo, status padrão, separação por stack, âncoras | `corpus.test.ts` (cobertura de tipos, relações e idiomas; âncoras; status padrão; separação pebble × quarry nos dois sentidos) |
| 6 | Relação fora de `from × to` e tipo fora do preset recusados sem escrita | `integration.test.ts` (tipo `issue`; `part_of` invertida; `establishes` de principle; `about` para invariant) |
| 7 | `presets` só importa `core-graph/index.ts` | `pnpm check:arch` (dependency-cruiser, regras do `CAPABILITY-MAP.md`) |
| 8 | API pública fixada; core-graph intacto | `public-api.test.ts`; `git diff main -- src/core-graph tests/core-graph` vazio |
| 9 | Créditos ao omnigraph-cookbooks | cabeçalho de `src/presets/development-graph/index.ts` e seção "Créditos" do README |
| 10 | `pnpm check:task` verde | rodado no fim da T5: 148 testes, cobertura das linhas alteradas ok |

**Desvios do plano:** `public-api.test.ts` entrou na T1, porque o ratchet de cobertura exigiu. O preset foi dividido em pasta já na T3. `applies_to` ganhou `dependency` como destino, para a regra de âncora valer (spec atualizado). O corpus ganhou a anotação `project`.

## Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| `Preset['ontology']` não é atribuível ao `Ontology` do core-graph | Médio | Testado na T1 pelo `typecheck`. Se falhar, pergunto antes de mudar a API do core-graph (fronteira "perguntar antes"). |
| `z.toJSONSchema` falha em algum schema | Baixo | Teste unitário por tipo desde a T1; o spec já proíbe `Date`, `transform` e `refine`. |
| Instruções vagas fazem o agente confundir invariant, assumption e learning | Médio | A T3 escreve as três juntas, com critério de escolha explícito em cada uma. O Checkpoint A tem revisão humana. A validação real vem no dogfood do `agent-loop`. |
| O corpus vaza conhecimento entre stacks pelo grafo (ex.: o repo B aparece a 2 saltos do repo A via dependência compartilhada) | Baixo | O critério é sobre conhecimento: só `learning`, `decision` etc. específicos do B não podem aparecer. O repo B em si pode. O teste verifica exatamente isso. |
| Cobertura das linhas alteradas abaixo de 80% | Baixo | O preset é quase todo dado, coberto pela importação. As funções do registro têm teste direto. |
| Arquivos acima de 300 linhas (src) ou 400 (tests) | Baixo | Divisão prevista do preset; testes por grupo de tipos. O corpus é JSON, fora dessa regra. |

## Perguntas em aberto

- Nenhuma bloqueante. As duas do spec (`supersedes` entre tipos e a fronteira invariant × assumption × learning) são tratadas por instrução e revistas no Checkpoint A.
