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
- [x] `pnpm db:migrate` do zero cria a tabela e os dois índices. Um teste com o `fluxie_app` insere, lê, atualiza e apaga uma linha. O GIN aparece em `pg_indexes`.
- [x] `tests/core-graph/public-api.test.ts` passa a listar `db`, `entities` e `relations`, e `git diff main -- src/core-graph` mostra só o `index.ts`. O comentário de `tests/core-graph/db.test.ts` é atualizado.
- [x] `on delete cascade` e a PK `(entity_id, model)` conferidos no teste.

**Verificação:** `pnpm vitest run tests/embeddings tests/core-graph`; `pnpm check:task`.

**Dependências:** T2.

**Arquivos:** `src/embeddings/schema.ts`, `migrations/0006_*.sql` e `0007_*.sql` (+ snapshot), `drizzle.config.ts`, `src/core-graph/index.ts`, `tests/core-graph/public-api.test.ts`, `tests/core-graph/db.test.ts`, `tests/embeddings/schema.test.ts`.

**Tamanho:** M. A maioria das mudanças é de uma linha.

### T4: syncEmbeddings

**Descrição:** `syncEmbeddings(spaceId, { batchSize })` embute, em lotes, as entidades do space sem vetor do modelo ativo ou com `source_hash ≠ content_hash`, e faz upsert por `(entity_id, model)`.

**Critérios de aceite:**
- [x] A primeira chamada gera tudo (`remaining: 0`), e a segunda não chama o provedor.
- [x] Mudar `content`, aceitar uma proposta ou fazer revert regenera só aquela entidade. Mudar só `metadata` não regenera.
- [x] Um modelo não toca nos vetores do outro. Duas chamadas concorrentes não duplicam. Se o provedor falha no meio, os lotes já gravados ficam, o lote que falhou não é gravado e o erro sobe.

**Verificação:** `pnpm vitest run tests/embeddings/sync.test.ts`; `pnpm check:task`.

**Dependências:** T3.

**Arquivos:** `src/embeddings/{sync,index}.ts`, `tests/embeddings/sync.test.ts`.

**Tamanho:** S.

### Checkpoint A: vetores gerados
- [x] Critérios 1–4 do spec cobertos.
- [x] `pnpm check:task` verde.
- [x] Achados do spike revisados pelo dono.

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
- [x] Unitário:
  - `fuse` (ordem, desempate, uma lista vazia);
  - montagem da tsquery: OU, acentos, símbolos, consulta só com símbolos, que pula a perna de texto sem erro.
- [x] Integração:
  - consulta por termo exato acha pela perna de texto;
  - com o mapa do stub, consulta sem palavra em comum acha pela perna vetorial;
  - `ranks` por perna;
  - filtros de status e tipo;
  - `limit` fora de 1–50 e consulta fora de 1–2000 caracteres recusados;
  - provedor fora do ar dá `vector: 'unavailable'` e hits do texto.
- [x] Entidades sem vetor ainda aparecem pela perna de texto, e uma entidade de outro space nunca aparece.

**Verificação:** `pnpm vitest run tests/embeddings`; `pnpm check:task`.

**Dependências:** T4.

**Arquivos:** `src/embeddings/{search,fusion,index}.ts`, `tests/embeddings/{fusion,search}.test.ts`.

**Tamanho:** M.

### T6: campo `scope` no presets

**Descrição:** `Preset` ganha `scope?: { containment: string[]; usage: string[] }`, e o Development Graph declara `{ containment: ['part_of'], usage: ['depends_on'] }`.

**Critérios de aceite:**
- [x] Teste: toda relação citada em `scope` existe nas `relationTypes` do preset, e as duas listas não se cruzam.
- [x] Os exports do presets não mudam; muda só o tipo.

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
- [x] No corpus do presets, com a regra do Development Graph, a partir de `repo:fictora/pebble-web`, `repo:fictora/quarry-api` e `component:fictora/quarry-api/faturamento`: nenhum item do outro projeto nos `hits`; os `shared` aparecem nos dois repos; as lições sobre dependências de componentes aparecem.
- [x] Uma âncora inexistente ou de outro space dá `NotFoundError`. Um component de outro repo usado por `depends_on` entra, mas os irmãos dele não (fixture pequena no próprio teste).
- [x] Sem âncora, o resultado é igual ao da T5.

**Verificação:** `pnpm vitest run tests/embeddings/scope.test.ts`; `pnpm check:task`.

**Dependências:** T5, T6.

**Arquivos:** `src/embeddings/{scope,search}.ts`, `tests/embeddings/scope.test.ts`.

**Tamanho:** M.

### T8: vizinhos de contexto

**Descrição:** `context` reúne os vizinhos dos hits até `depth` (0–2, padrão 1) pelo `neighbors` do core-graph, sem repetir hits e restritos ao escopo e aos status pedidos. As relações também ficam só entre entidades do resultado.

**Critérios de aceite:**
- [x] `depth: 0` dá contexto vazio; `1` e `2` trazem os vizinhos certos, sem duplicata.
- [x] Com âncora, no corpus, nada do outro projeto em `context.entities` nem em `context.relations`, nos dois sentidos.
- [x] Status fora do pedido não aparecem no contexto.

**Verificação:** `pnpm vitest run tests/embeddings`; `pnpm check:task`.

**Dependências:** T7.

**Arquivos:** `src/embeddings/{search,context}.ts`, `tests/embeddings/scope.test.ts`, `tests/embeddings/search.test.ts`.

**Tamanho:** S.

### Checkpoint B: busca completa
- [x] Critérios 5–9 e 11 do spec cobertos.
- [x] `pnpm check:task` verde.

## Fase 3: Benchmark e fechamento

### T9: fixtures do benchmark e métricas

**Descrição:**
- `tests/fixtures/embeddings/distractors.json`: 30–40 entidades fictícias válidas para o Development Graph, com quase-duplicatas, o mesmo assunto no outro idioma e um terceiro repo de outra stack, além das relações;
- `queries.json`: cerca de 40 consultas com `id`, `lang`, `targetLang`, `kind` (`lexical` | `paraphrase`), `text` e `expected`, nos grupos PT→PT, EN→EN, PT→EN e EN→PT;
- `scripts/bench-metrics.ts` com MRR@10, recall@5 e p50/p95.

**Critérios de aceite:**
- [x] Os distratores carregam pelo core-graph real com o preset (`OntologyError` nenhum). Toda key em `expected` existe no corpus ou nos distratores.
- [x] Toda consulta `paraphrase` não divide nenhuma palavra de conteúdo (ignorando palavras de até 3 letras) com os títulos esperados. Cada grupo de idioma tem pelo menos 8 consultas.
- [x] Métricas com teste unitário (casos à mão, lista vazia, alvo ausente).

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
- [x] `pnpm bench:embeddings` imprime, por modelo:
  - MRR@10 e recall@5, no total e por grupo;
  - os mesmos números para só vetor, só texto e híbrida;
  - p50/p95 em CPU, carga a frio, memória e tempo do corpus.
- [x] A seção "Resultado do benchmark" do spec traz a tabela, a data, as versões do Ollama e dos modelos e a CPU. O vencedor sai pela regra, e o padrão de `EMBEDDINGS_MODEL` (compose, `.env.example` e `DEFAULT_MODEL` do catálogo) passa a ser ele.
- [x] Revisão humana do resultado antes de seguir (Checkpoint C).

**Verificação:** saída do script colada no spec; `pnpm check:task`.

**Dependências:** T8, T9.

**Arquivos:** `scripts/bench-embeddings.ts`, `package.json`, `SPEC-embeddings.md`, `src/embeddings/models.ts` (padrão), `docker-compose.yml`, `.env.example`.

**Tamanho:** M.

## Fase 4: Emenda 1, híbrida melhorada

### T12: spike da imagem do banco com pg_textsearch 1.6.0

**Descrição:** uma imagem própria do `db`, `docker/db/Dockerfile`:
- parte de `pgvector/pgvector:0.8.7-pg19`;
- instala o `pg_textsearch` v1.6.0, por pacote pronto se existir para pg19 amd64, ou compilado num estágio de build com o código conferido por checksum;
- carrega a extensão por `shared_preload_libraries` (`command: -c ...` no compose).

O compose passa de `image:` para `build:` no `db`. O `init-db.sh` cria a extensão nos dois bancos.

O spike responde às perguntas em aberto da emenda e registra os achados no `tasks/plan.md`:
- se a extensão chega por pacote ou precisa compilar;
- se ela aceita dois índices `bm25` (`portuguese` e `english`) sobre a mesma expressão;
- se o `to_bm25query` funciona com os filtros de space, status e escopo no `WHERE` (`EXPLAIN`);
- se o `fluxie_app` consegue consultar com o papel restrito;
- o tempo do build.

Se um achado contradisser o spec, o plano para e volta ao dono.

**Critérios de aceite:**
- [x] `docker compose up -d --wait db` sobe a imagem nova a partir de um volume limpo, e `pnpm db:migrate` roda nela.
- [x] A suíte inteira (`pnpm check:task`) passa na imagem nova, sem nenhuma mudança de código.
- [x] A tabela de achados da T12 no `tasks/plan.md` responde às quatro perguntas da emenda.

**Verificação:** `docker compose down -v && docker compose up -d --wait db`; `pnpm db:migrate`; `pnpm check:task`.

**Dependências:** nenhuma de código. É o primeiro passo da emenda, porque é o maior risco.

**Arquivos:** `docker/db/Dockerfile`, `docker-compose.yml`, `docker/init-db.sh`, `tasks/plan.md`.

**Tamanho:** S.

### T14: `dogfood:prepare`

**Descrição:** `scripts/dogfood-prepare.ts`, com as funções puras em `scripts/dogfood-lib.ts`:
- monta a lista permitida a partir de `DOGFOOD_SOURCE`, com padrão `C:\Projetos\chatbot`: `docs/**/*.md`, `CLAUDE.md`, `AGENTS.md` e `README.md`. Exclui sempre `.env*`, `vendor`, `node_modules`, `storage`, `.git` e as pastas de agentes;
- roda o `gitleaks` nos arquivos e pula os que tiverem achado;
- divide em lotes de tamanho parecido (por bytes, com teto por lote);
- grava `.dogfood/batches.json`;
- imprime quantos arquivos, lotes e tokens estimados vão entrar, sem nenhum conteúdo.

Inclui também `pnpm dogfood:prepare` no `package.json`.

**Critérios de aceite:**
- [x] Testes, com uma árvore de arquivos fictícia num diretório temporário: a lista exclui `.env`, `.env.local`, `vendor/x.md` e `.claude/a.md`; os lotes cobrem cada arquivo uma vez e respeitam o teto; o `.dogfood/` está no `.gitignore`.
- [x] Rodando no chatbot, imprime só contagens (nenhum caminho de arquivo pulado traz o conteúdo).

**Verificação:** `pnpm vitest run tests/scripts/dogfood-lib.test.ts`; `pnpm dogfood:prepare`; `pnpm check:task`.

**Dependências:** nenhuma de código. Vem depois da T12 na ordem, para fechar o Checkpoint D.

**Arquivos:** `scripts/dogfood-prepare.ts`, `scripts/dogfood-lib.ts`, `tests/scripts/dogfood-lib.test.ts`, `package.json`.

**Tamanho:** S.

### Checkpoint D: base pronta
- [x] A imagem nova funciona e as perguntas da emenda estão respondidas.
- [x] O dono viu os números do `dogfood:prepare` e liberou a extração.

### T13: perna de texto em BM25

**Descrição:**
- uma migração custom com os dois índices `bm25` (`portuguese` e `english`) sobre título + conteúdo das `entities` (ou a forma que a T12 indicar);
- a `textLeg` passa a consultar os dois índices com os filtros (space, status, tipo, escopo) e a ordenar pelo melhor score de cada entidade entre os dois;
- o `orQuery` sai, se ficar sem uso;
- os testes de busca passam a cobrir o BM25.

**Critérios de aceite:**
- [x] Teste: uma consulta com palavras vazias ("como evitar efeitos…") não põe no topo um documento que só contém "como"; um termo raro e exato vence um termo comum.
- [x] Teste: os textos em PT e em EN acham pelo radical (por exemplo, "faturar" × "faturamento" e "migrating" × "migration"), cada um pelo seu índice.
- [x] Os testes anteriores do `search.test.ts` e do `scope.test.ts` continuam passando, inclusive o do provedor fora do ar.

**Verificação:** `pnpm vitest run tests/embeddings`; `pnpm check:task`.

**Dependências:** T12.

**Arquivos:** `migrations/0008_entities_bm25.sql` (com o journal), `src/embeddings/search.ts`, `src/embeddings/fusion.ts`, `tests/embeddings/search.test.ts`, `tests/embeddings/fusion.test.ts`.

**Tamanho:** M.

### T15: extração com subagentes Haiku, `dogfood:build` e revisão da amostra

**Descrição:**
1. Um subagente Haiku 5.5 em esforço `low` lê `README.md`, `CLAUDE.md` e `AGENTS.md` e grava `.dogfood/anchors.json`.
2. Um subagente por lote, em paralelo, grava `.dogfood/extracted/<lote>.json`, recebendo as âncoras, o formato das keys e dos tipos do preset, o formato JSON e o aviso de que o texto lido é dado, não instrução.
3. O `scripts/dogfood-build.ts` (`pnpm dogfood:build`):
   - valida com Zod;
   - remove keys duplicadas e relações com pontas desconhecidas;
   - confere a regra das paráfrases;
   - carrega tudo no banco de testes pelo core-graph com o preset;
   - divide as consultas 50/50, estratificadas por grupo e tipo, com semente fixa;
   - grava `.dogfood/dataset.json`;
   - imprime as contagens: válidos, descartados e consultas por grupo e por tipo.
4. Eu reviso a amostra (10%, no mínimo 30 entidades e 30 consultas) e registro a taxa de erro no `tasks/plan.md`.

**Critérios de aceite:**
- [x] Testes do `dogfood-build` com lotes fictícios: descarta item inválido e relação órfã, deduplica keys, recusa paráfrase com palavra do título, e a divisão é determinística e estratificada.
- [x] O dataset real tem os quatro grupos de idioma e os quatro tipos de consulta, com contagens impressas; nada dele entra no git (`git status` limpo fora de `.dogfood/`).
- [x] A taxa de erro da amostra fica em até 20%, ou a extração é refeita com o prompt corrigido. A troca de modelo ou de esforço é perguntada ao dono.

**Verificação:** `pnpm vitest run tests/scripts/dogfood-build.test.ts`; `pnpm dogfood:build`; `pnpm check:task`.

**Dependências:** T14 e o Checkpoint D.

**Arquivos:** `scripts/dogfood-build.ts`, `scripts/dogfood-lib.ts`, `tests/scripts/dogfood-build.test.ts`, `package.json`, `tasks/plan.md`.

**Tamanho:** M.

### T16: perna de grafo

**Descrição:** `src/embeddings/graph.ts` com um PageRank personalizado sobre as relações do space:
- usa as relações nos dois sentidos e pesos iguais por tipo, dentro do escopo da âncora quando houver, e só com os status pedidos;
- as sementes são os melhores resultados da perna vetorial, com peso proporcional à similaridade;
- amortecimento de 0,5 (ver o spec) e número fixo de iterações;
- devolve uma lista ordenada.

A implementação (TypeScript sobre uma leitura das relações, ou SQL recursivo) é escolhida aqui, pela simplicidade. Uma escolha com limite conhecido de escala leva o comentário `shortcut:`.

**Critérios de aceite:**
- [x] Unitário, num grafo pequeno à mão: a ordem esperada sai; com uma semente só, ela fica em 1º e os vizinhos diretos vêm antes dos de dois saltos; ciclos terminam.
- [x] Integração no corpus: com uma âncora, nada fora do escopo aparece; uma lição ligada a um component semente aparece entre os primeiros.
- [x] Sem sementes (perna vetorial vazia), devolve uma lista vazia.

**Verificação:** `pnpm vitest run tests/embeddings/graph.test.ts`; `pnpm check:task`.

**Dependências:** T8. Pode correr ao lado das T13 a T15.

**Arquivos:** `src/embeddings/graph.ts`, `tests/embeddings/graph.test.ts`.

**Tamanho:** M.

### T17: fusão calibrada no `search`

**Descrição:**
- o `fusion.ts` ganha o RRF com peso por perna e a combinação convexa de scores normalizados (min-max por perna, em cada consulta);
- o `search` passa a usar três pernas (vetor, texto e grafo), com `2 × limit` candidatos, até 60;
- as constantes `FUSION = { fn, text, graph }` ficam no `search.ts`, com valores provisórios até a T18;
- `ranks` ganha `graph`;
- o provedor fora do ar continua dando só texto.

**Critérios de aceite:**
- [ ] Unitário: os dois `fuse` com pesos (peso 0 desliga a perna; desempate pelo id; perna vazia; normalização quando todos os scores são iguais).
- [ ] Integração: os `ranks` trazem as três pernas; com o peso do texto em 0, a ordem é a do vetor; os testes antigos de status, tipo, limite, escopo e provedor fora do ar continuam passando.
- [ ] O `search.ts` fica dentro dos limites do `CONSTRAINTS.md`. Se passar, o código é dividido em arquivos.

**Verificação:** `pnpm vitest run tests/embeddings`; `pnpm check:task`.

**Dependências:** T13 e T16.

**Arquivos:** `src/embeddings/fusion.ts`, `src/embeddings/search.ts`, `src/embeddings/index.ts`, `tests/embeddings/fusion.test.ts`, `tests/embeddings/search.test.ts`.

**Tamanho:** M.

### Checkpoint E: pernas e dados prontos
- [ ] Três pernas com teste; o dataset do dogfooding está validado, com a taxa de erro da amostra registrada.
- [ ] `pnpm check:task` verde.

### T18: benchmark com calibração e teste, e decisão da fusão

**Descrição:**
- o `bench-embeddings.ts` ganha `--data fictional|dogfood`;
- no dogfooding, ele:
  - calibra na metade de calibração (as duas funções de fusão × a grade de pesos);
  - reporta na metade de teste, por grupo e por tipo, a configuração escolhida ao lado do vetor sozinho;
  - mede o p95 da `search` inteira;
  - aplica a regra da Emenda 1 por uma função testada (`chooseFusion` no `bench-metrics.ts`);
- a configuração vencedora entra nas constantes do `search.ts`; se vencer "só vetor", os pesos do texto e do grafo vão a 0;
- os números agregados (sem nenhum texto do chatbot) vão para "Resultado do benchmark" no spec.

**Critérios de aceite:**
- [ ] `chooseFusion` tem teste unitário com os casos da regra: margem de 0,02, queda por grupo, grafo nas consultas de vários saltos e latência acima do corte.
- [ ] O spec traz a tabela agregada da rodada (data, contagens do dataset, calibração × teste) e a decisão. As constantes do `search.ts` refletem essa decisão.
- [ ] O dono revisa o resultado (Checkpoint F).

**Verificação:** `pnpm bench:embeddings --data dogfood`; `pnpm check:task`.

**Dependências:** T15 e T17.

**Arquivos:** `scripts/bench-embeddings.ts`, `scripts/bench-metrics.ts`, `tests/scripts/bench-metrics.test.ts`, `src/embeddings/search.ts`, `SPEC-embeddings.md`.

**Tamanho:** M.

### Checkpoint F: decisão
- [ ] O resultado está no spec, e a configuração da fusão está aplicada pela regra e aprovada pelo dono.

## Fase 5: Fechamento

### T11: fechamento

**Descrição:**
- tabela de rastreabilidade critério → teste no `tasks/plan.md`, com os 17 critérios;
- situação das pendências 1 e 2 no `tasks/presets/plan.md`;
- `CAPABILITY-MAP.md` atualizado (a linha do embeddings: BM25, grafo e fusão);
- decisão sobre o GIN de `entities.tsv`: sai se nada mais o usar;
- os pisos de cobertura do `vitest.config.ts` sobem até o valor medido;
- `pnpm check:task` final.

**Critérios de aceite:**
- [ ] Os 17 critérios do spec estão ligados a testes ou a verificações registradas.
- [ ] Os pisos do ratchet sobem, sem nenhum cair.
- [ ] `pnpm check:task` verde com o banco no ar.

**Verificação:** `pnpm check:task`.

**Dependências:** T18.

**Arquivos:** `tasks/plan.md`, `tasks/presets/plan.md`, `CAPABILITY-MAP.md`, `vitest.config.ts`.

**Tamanho:** S.

### Checkpoint C: completo
- [x] Modelo padrão aprovado pelo dono (rodada 1, 26/11: Gemma 270m).
- [ ] `pnpm check:task` verde; pronto para a fase Verify.
