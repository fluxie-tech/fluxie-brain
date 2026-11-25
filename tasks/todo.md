# Tarefas: embeddings

Plano: `tasks/plan.md` · Spec: `SPEC-embeddings.md`.

**Definição de pronto para toda tarefa:**
- `pnpm check:fast` verde depois de cada edição (o hook roda);
- `pnpm check:task` verde antes de marcar a tarefa, com o banco no ar (`docker compose up -d --wait db`);
- um commit por tarefa no branch `spec/embeddings`, com o e-mail noreply;
- nada no `CONSTRAINTS.md` enfraquecido; nenhum teste pulado por falta de Ollama.

## Fase 1: Vetores

### T1: Ollama no compose + spike

**Descrição:** adiciona ao `docker-compose.yml` o serviço `ollama`, só CPU:
- tag exata, a mais nova com mais de 1 dia;
- porta em `127.0.0.1:11434`;
- volume para os modelos;
- `cpus: 4`, `mem_limit: 3g` e `OLLAMA_KEEP_ALIVE=-1`;
- healthcheck;
- o pull do modelo no entrypoint do `ollama`, com o healthcheck só verde com o modelo presente (achado 9 do spike).

Depois, roda o spike que fecha as perguntas em aberto do spec e registra os achados em `tasks/plan.md`. Não há código de produção.

**Critérios de aceite:**
- [x] `docker compose up -d --wait` sobe `db` e `ollama`, baixa o modelo e `curl 127.0.0.1:11434/v1/embeddings` responde para os dois candidatos. `docker compose up -d --wait db` continua subindo só o banco, como no CI.
- [x] Achados registrados:
  - dimensão real de cada modelo;
  - template de consulta do Qwen3 no model card;
  - se o Ollama aplica prefixo próprio (similaridade com prefixo dobrado × único);
  - comportamento acima do contexto;
  - `vector` sem dimensão aceito pelo pgvector (inserir 3 e 4 dims numa tabela temporária);
  - se o Drizzle tem o tipo ou se vai precisar de `customType`;
  - `--wait` com o pull que termina;
  - CPUs e memória que o Docker Desktop enxerga.
- [x] Se algum achado contradisser o spec, parar e voltar à fase 1.

**Verificação:** comandos e saídas no registro do spike; `pnpm check:task` verde, porque nada de `src` muda.

**Dependências:** nenhuma.

**Arquivos:** `docker-compose.yml`, `.env.example` (`EMBEDDINGS_*`), `tasks/plan.md`.

**Tamanho:** S.

### T2: provedor, catálogo e erros

**Descrição:** cria `src/embeddings` com:
- o catálogo dos dois modelos (dimensão, template de documento e de consulta);
- o cliente `POST {base}/embeddings` com `fetch`, em lote e com `Bearer` opcional, que valida a resposta por Zod (contagem, dimensão, finitos);
- a leitura da configuração do ambiente por chamada;
- `EmbeddingProviderError` e `EmbeddingConfigError`, derivados de `CoreGraphError`.

Inclui o stub HTTP de teste.

**Critérios de aceite:**
- [x] Contagem, dimensão ou NaN errados, HTTP de erro, JSON inválido ou conexão recusada geram `EmbeddingProviderError`, com mensagem legível e sem o corpo cru da resposta.
- [x] Um modelo fora do catálogo gera `EmbeddingConfigError`. Os templates de documento e de consulta saem como os achados da T1 mandam.
- [x] `public-api.test.ts` do embeddings fixa os exports. Nada é lido do ambiente na importação.

**Verificação:** `pnpm vitest run tests/embeddings`; `pnpm check:task`.

**Dependências:** T1.

**Arquivos:** `src/embeddings/{models,provider,errors,index}.ts`, `tests/embeddings/{stub-provider,provider.test,public-api.test}.ts`.

**Tamanho:** M.

### T3: tabela, GIN e exports do core-graph

**Descrição:**
- `src/embeddings/schema.ts` com `entity_embeddings`;
- migração gerada para a tabela e migração custom para o GIN em `entities.tsv`;
- `drizzle.config.ts` com os dois schemas;
- o core-graph exporta `db`, `entities` e `relations`.

**Critérios de aceite:**
- [ ] `pnpm db:migrate` do zero cria a tabela e os dois índices. Um teste com o `fluxie_app` insere, lê, atualiza e apaga uma linha. O GIN aparece em `pg_indexes`.
- [ ] `tests/core-graph/public-api.test.ts` passa a listar `db`, `entities` e `relations`, e `git diff main -- src/core-graph` mostra só o `index.ts`. O comentário de `tests/core-graph/db.test.ts` é atualizado.
- [ ] `on delete cascade` e a PK `(entity_id, model)` conferidos no teste.

**Verificação:** `pnpm vitest run tests/embeddings tests/core-graph`; `pnpm check:task`.

**Dependências:** T2.

**Arquivos:** `src/embeddings/schema.ts`, `migrations/0006_*.sql` e `0007_*.sql` (+ snapshot), `drizzle.config.ts`, `src/core-graph/index.ts`, `tests/core-graph/public-api.test.ts`, `tests/core-graph/db.test.ts`, `tests/embeddings/schema.test.ts`.

**Tamanho:** M. A maioria das mudanças é de uma linha.

### T4: syncEmbeddings

**Descrição:** `syncEmbeddings(spaceId, { batchSize })` embute, em lotes, as entidades do space sem vetor do modelo ativo ou com `source_hash ≠ content_hash`, e faz upsert por `(entity_id, model)`.

**Critérios de aceite:**
- [ ] A primeira chamada gera tudo (`remaining: 0`), e a segunda não chama o provedor.
- [ ] Mudar `content`, aceitar uma proposta ou fazer revert regenera só aquela entidade. Mudar só `metadata` não regenera.
- [ ] Um modelo não toca nos vetores do outro. Duas chamadas concorrentes não duplicam. Se o provedor falha no meio, os lotes já gravados ficam, o lote que falhou não é gravado e o erro sobe.

**Verificação:** `pnpm vitest run tests/embeddings/sync.test.ts`; `pnpm check:task`.

**Dependências:** T3.

**Arquivos:** `src/embeddings/{sync,index}.ts`, `tests/embeddings/sync.test.ts`.

**Tamanho:** S.

### Checkpoint A: vetores gerados
- [ ] Critérios 1–4 do spec cobertos.
- [ ] `pnpm check:task` verde.
- [ ] Achados do spike revisados pelo dono.

## Fase 2: Busca

### T5: busca híbrida sem âncora

**Descrição:**
- `search` com perna vetorial (busca exata por cosseno, 50 candidatos) e perna de texto (tsquery com OU, `ts_rank_cd`, 50 candidatos);
- `fuse` (RRF k=60, desempate pelo id);
- filtros de status (padrão `approved` + `draft`) e tipo;
- validação da consulta e do `limit`;
- fallback para só texto quando o provedor falha.

O contexto vem vazio até a T8.

**Critérios de aceite:**
- [ ] Unitário:
  - `fuse` (ordem, desempate, uma lista vazia);
  - montagem da tsquery: OU, acentos, símbolos, consulta só com símbolos, que pula a perna de texto sem erro.
- [ ] Integração:
  - consulta por termo exato acha pela perna de texto;
  - com o mapa do stub, consulta sem palavra em comum acha pela perna vetorial;
  - `ranks` por perna;
  - filtros de status e tipo;
  - `limit` fora de 1–50 e consulta fora de 1–2000 caracteres recusados;
  - provedor fora do ar dá `vector: 'unavailable'` e hits do texto.
- [ ] Entidades sem vetor ainda aparecem pela perna de texto, e uma entidade de outro space nunca aparece.

**Verificação:** `pnpm vitest run tests/embeddings`; `pnpm check:task`.

**Dependências:** T4.

**Arquivos:** `src/embeddings/{search,fusion,index}.ts`, `tests/embeddings/{fusion,search}.test.ts`.

**Tamanho:** M.

### T6: campo `scope` no presets

**Descrição:** `Preset` ganha `scope?: { containment: string[]; usage: string[] }`, e o Development Graph declara `{ containment: ['part_of'], usage: ['depends_on'] }`.

**Critérios de aceite:**
- [ ] Teste: toda relação citada em `scope` existe nas `relationTypes` do preset, e as duas listas não se cruzam.
- [ ] Os exports do presets não mudam; muda só o tipo.

**Verificação:** `pnpm vitest run tests/presets`; `pnpm check:task`.

**Dependências:** nenhuma de código (pode vir antes da T5); na ordem, depois da T5.

**Arquivos:** `src/presets/types.ts`, `src/presets/development-graph/index.ts`, `tests/presets/development-graph.test.ts`.

**Tamanho:** XS.

### T7: filtro pelo escopo da âncora

**Descrição:** `scope.ts` calcula, num SQL com CTE recursiva, os ids no escopo da âncora:
- **próprio:** a âncora mais o fecho de `containment` nos dois sentidos;
- **usado:** um salto de `usage` para fora;
- **ligado:** as entidades ligadas aos dois anteriores por relações que não são de `containment` nem de `usage`.

As duas pernas da busca filtram por esses ids.

**Critérios de aceite:**
- [ ] No corpus do presets, com a regra do Development Graph, a partir de `repo:fictora/pebble-web`, `repo:fictora/quarry-api` e `component:fictora/quarry-api/faturamento`: nenhum item do outro projeto nos `hits`; os `shared` aparecem nos dois repos; as lições sobre dependências de componentes aparecem.
- [ ] Uma âncora inexistente ou de outro space dá `NotFoundError`. Um component de outro repo usado por `depends_on` entra, mas os irmãos dele não (fixture pequena no próprio teste).
- [ ] Sem âncora, o resultado é igual ao da T5.

**Verificação:** `pnpm vitest run tests/embeddings/scope.test.ts`; `pnpm check:task`.

**Dependências:** T5, T6.

**Arquivos:** `src/embeddings/{scope,search}.ts`, `tests/embeddings/scope.test.ts`.

**Tamanho:** M.

### T8: vizinhos de contexto

**Descrição:** `context` reúne os vizinhos dos hits até `depth` (0–2, padrão 1) pelo `neighbors` do core-graph, sem repetir hits e restritos ao escopo e aos status pedidos. As relações também ficam só entre entidades do resultado.

**Critérios de aceite:**
- [ ] `depth: 0` dá contexto vazio; `1` e `2` trazem os vizinhos certos, sem duplicata.
- [ ] Com âncora, no corpus, nada do outro projeto em `context.entities` nem em `context.relations`, nos dois sentidos.
- [ ] Status fora do pedido não aparecem no contexto.

**Verificação:** `pnpm vitest run tests/embeddings`; `pnpm check:task`.

**Dependências:** T7.

**Arquivos:** `src/embeddings/{search,context}.ts`, `tests/embeddings/scope.test.ts`, `tests/embeddings/search.test.ts`.

**Tamanho:** S.

### Checkpoint B: busca completa
- [ ] Critérios 5–9 e 11 do spec cobertos.
- [ ] `pnpm check:task` verde.

## Fase 3: Benchmark e fechamento

### T9: fixtures do benchmark e métricas

**Descrição:**
- `tests/fixtures/embeddings/distractors.json`: 30–40 entidades fictícias válidas para o Development Graph, com quase-duplicatas, o mesmo assunto no outro idioma e um terceiro repo de outra stack, além das relações;
- `queries.json`: cerca de 40 consultas com `id`, `lang`, `targetLang`, `kind` (`lexical` | `paraphrase`), `text` e `expected`, nos grupos PT→PT, EN→EN, PT→EN e EN→PT;
- `scripts/bench-metrics.ts` com MRR@10, recall@5 e p50/p95.

**Critérios de aceite:**
- [ ] Os distratores carregam pelo core-graph real com o preset (`OntologyError` nenhum). Toda key em `expected` existe no corpus ou nos distratores.
- [ ] Toda consulta `paraphrase` não divide nenhuma palavra de conteúdo (ignorando palavras de até 3 letras) com os títulos esperados. Cada grupo de idioma tem pelo menos 8 consultas.
- [ ] Métricas com teste unitário (casos à mão, lista vazia, alvo ausente).

**Verificação:** `pnpm vitest run tests/embeddings/fixtures.test.ts tests/scripts/bench-metrics.test.ts`; `pnpm check:task`.

**Dependências:** nenhuma de código; na ordem, depois da T8.

**Arquivos:** `tests/fixtures/embeddings/{distractors,queries}.json`, `scripts/bench-metrics.ts`, `tests/embeddings/fixtures.test.ts`, `tests/scripts/bench-metrics.test.ts`.

**Tamanho:** M.

### T10: script do benchmark, execução e escolha do modelo

**Descrição:** `scripts/bench-embeddings.ts`. Para cada modelo:
- esvazia o banco de teste (`truncateAll`);
- carrega corpus e distratores;
- roda `syncEmbeddings` e mede o tempo;
- roda as consultas sem âncora pelas pernas isoladas e pela híbrida;
- mede a latência da consulta já carregada e a carga a frio, e a memória (`docker stats`);
- confere que nenhum vetor tem NaN;
- imprime a tabela.

Depois, roda nos dois modelos, aplica a regra de escolha e registra o resultado no spec.

**Critérios de aceite:**
- [ ] `pnpm bench:embeddings` imprime, por modelo:
  - MRR@10 e recall@5, no total e por grupo;
  - os mesmos números para só vetor, só texto e híbrida;
  - p50/p95 em CPU, carga a frio, memória e tempo do corpus.
- [ ] A seção "Resultado do benchmark" do spec traz a tabela, a data, as versões do Ollama e dos modelos e a CPU. O Gemma continua padrão, ou o dono decide de novo, conforme o "Papel do benchmark" do spec.
- [ ] Revisão humana do resultado antes de seguir (Checkpoint C).

**Verificação:** saída do script colada no spec; `pnpm check:task`.

**Dependências:** T8, T9.

**Arquivos:** `scripts/bench-embeddings.ts`, `package.json`, `SPEC-embeddings.md`, `src/embeddings/models.ts` (padrão), `docker-compose.yml`, `.env.example`.

**Tamanho:** M.

### T11: fechamento

**Descrição:**
- tabela de rastreabilidade critério → teste em `tasks/plan.md`;
- situação das pendências 1 e 2 em `tasks/presets/plan.md`;
- `CAPABILITY-MAP.md` atualizado, se a decisão do modelo mudar a linha do embeddings;
- `pnpm check:task` final.

**Critérios de aceite:**
- [ ] Os 12 critérios do spec ligados a testes ou a verificações registradas.
- [ ] `pnpm check:task` verde com o banco no ar.

**Verificação:** `pnpm check:task`.

**Dependências:** T10.

**Arquivos:** `tasks/plan.md`, `tasks/presets/plan.md`, `CAPABILITY-MAP.md`.

**Tamanho:** S.

### Checkpoint C: completo
- [ ] Modelo padrão aprovado pelo dono.
- [ ] `pnpm check:task` verde; pronto para a fase Verify.
