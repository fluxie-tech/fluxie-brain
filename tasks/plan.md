# Implementation Plan: embeddings

Spec: `SPEC-embeddings.md`. Mapa: `CAPABILITY-MAP.md`. Tarefas detalhadas: `tasks/todo.md`.
Planos anteriores (concluídos): `tasks/core-graph/` e `tasks/presets/`.

## Visão geral

Criar o módulo `src/embeddings`. Ele mantém vetores das entidades gerados pelo Ollama (CPU, API compatível com a OpenAI) numa tabela própria e oferece a busca híbrida: vetor + texto, fundidos por RRF, com filtro pelo escopo da âncora e vizinhos de contexto. O presets ganha o campo `scope`, e o core-graph passa a exportar `db`, `entities` e `relations`. Um benchmark manual escolhe entre `qwen3-embedding:0.6b` e `embeddinggemma-2:270m`, que é o padrão provisório até lá.

## Grafo de dependências

```
T1 Ollama no compose + spike (fecha as perguntas em aberto do spec)
 └─ T2 provedor: catálogo, cliente /v1/embeddings, erros, stub de teste
     └─ T3 tabela entity_embeddings + GIN + exports do core-graph
         └─ T4 syncEmbeddings
             └─ T5 busca híbrida sem âncora (vetor + texto + RRF)
                 ├─ T6 campo scope no presets ─┐
                 └──────────────────────────────┴─ T7 filtro pelo escopo da âncora
                                                    └─ T8 vizinhos de contexto
T9 fixtures do benchmark + métricas      (depende só do corpus; pode correr ao lado de T5–T8)
T10 script do benchmark + 1ª rodada + escolha do modelo  (feito: Gemma 270m; a híbrida perdeu → Emenda 1)

Emenda 1 (SPEC-embeddings.md, aprovada em 26/11/2026):
T12 spike: imagem do db com pg_textsearch 1.6.0 no PG19 (o risco primeiro; fecha as perguntas da emenda)
 ├─ T13 perna de texto em BM25 (dois índices, portuguese e english)
 └─ T14 dogfood:prepare (lista permitida + gitleaks + lotes)        (só precisa da T12 para carregar no banco)
     └─ T15 extração com subagentes Haiku + dogfood:build + revisão da amostra
T16 perna de grafo (PageRank personalizado)            (depende de T8; pode correr ao lado de T13–T15)
T17 fusão calibrada no search (funções + constantes provisórias)   (depende de T13 e T16)
 └─ T18 benchmark com calibração/teste no dogfooding + decisão     (depende de T15 e T17)
T11 fechamento: rastreabilidade (17 critérios), pendências, pisos de cobertura, check:task
```

## Decisões de arquitetura

- **O risco vem primeiro (T1):** a T1 é um spike sem código de produção. Ela mede o que o catálogo e o schema precisam e registra os achados abaixo:
  - a dimensão real dos dois modelos;
  - se o Ollama aplica prefixo próprio;
  - como ele trunca textos acima do contexto;
  - se a coluna `vector` sem dimensão funciona no pgvector 0.8.7;
  - se o `docker compose up -d --wait` aceita um serviço de pull que termina com 0;
  - quantas CPUs o WSL2 libera para o Docker.

  Se algum achado contradisser o spec, o plano para e volta à fase 1.
- **Fatias verticais:** cada tarefa entrega um comportamento testável de ponta a ponta (gerar vetores, buscar, filtrar, expandir) e deixa o projeto verde. O `index.ts` do embeddings e o `public-api.test.ts` nascem na T2, porque o ratchet de cobertura exigiu isso no presets.
- **Configuração explícita por dentro:** as funções internas recebem `{ baseUrl, model, apiKey }`, e só a API pública lê o ambiente, a cada chamada. É isso que deixa os testes apontarem para o stub em porta dinâmica e o benchmark trocar de modelo no mesmo processo.
- **Stub HTTP nos testes** (`node:http`, em `tests/embeddings/stub-provider.ts`): por padrão, um saco de palavras com hash; para o caso "sem palavra em comum", um mapa texto → vetor definido no teste. Ele também simula falhas (HTTP 500, conexão recusada, NaN, dimensão errada, contagem errada).
- **Reuso:** o contexto usa o `neighbors` do core-graph por hit, filtrado pelo conjunto do escopo, e as colunas de `Entity` saem do `getTableColumns(entities)` sem o `tsv`, como no `rows.ts` do core-graph. Nada novo é exportado do core-graph além do que o spec lista.
- **Migrações:**
  - a tabela é gerada pelo `drizzle-kit` a partir de `src/embeddings/schema.ts` (o `drizzle.config.ts` passa a listar os dois schemas);
  - o GIN em `entities.tsv` vai numa migração custom;
  - o `fluxie_app` recebe DML pelos default privileges.
- **Commits:** um por tarefa, no branch `spec/embeddings`, com o e-mail noreply. O PR sai na fase Ship.

## Tarefas

Detalhes, critérios de aceite e verificação em `tasks/todo.md`.

### Fase 1: Vetores
- [x] T1: Ollama no compose + spike (S)
- [x] T2: provedor, catálogo e erros (M)
- [x] T3: tabela, GIN e exports do core-graph (M)
- [x] T4: syncEmbeddings (S)

### Checkpoint A: vetores gerados
- [x] Critérios 1–4 do spec com teste ou verificação manual registrada: 1 manual (spike T1 e prova de ponta a ponta abaixo), 2 `tests/embeddings/schema.test.ts`, 3 `tests/embeddings/sync.test.ts`, 4 `tests/embeddings/provider.test.ts` + teste de falha no meio do `sync.test.ts`
- [x] `pnpm check:task` verde (240 testes; cobertura das linhas alteradas 100%)
- [x] Prova de ponta a ponta com o Ollama real: as 32 entidades do corpus no banco de testes, `syncEmbeddings` com o Gemma 270m → `{ embedded: 32, remaining: 0 }` em 7,2 s; a segunda chamada deu `{ embedded: 0, remaining: 0 }` em 3 ms; 32 vetores de 768 dims
- [x] Achados do spike revisados pelo dono (2026-11-25: Gemma `270m` no lugar da `570m`; pull no entrypoint)

### Fase 2: Busca
- [x] T5: busca híbrida sem âncora (M)
- [x] T6: campo `scope` no presets (XS)
- [x] T7: filtro pelo escopo da âncora (M)
- [x] T8: vizinhos de contexto (S)

### Checkpoint B: busca completa
- [x] Critérios 5–9 e 11 do spec com teste: 5, 6 e 8 `tests/embeddings/search.test.ts`; 7 `tests/embeddings/scope.test.ts` (hits e context, três âncoras, fixture de component usado por outro repo); 9 `search.test.ts` (context) + `scope.test.ts`; 11 `tests/presets/development-graph.test.ts` + `tests/core-graph/public-api.test.ts`
- [x] `pnpm check:task` verde (271 testes; cobertura das linhas alteradas 100%). O teste de vazamento do context falha (3 casos) com o filtro de escopo desligado
- [x] Prova com o Ollama real (Gemma 270m, banco de testes, corpus): busca em 81–109 ms com vetor; com âncora em `repo:fictora/pebble-web`, nada do quarry
- [x] Achado revisado pelo dono (2026-11-26: o benchmark decide; se a híbrida perder para o vetor sozinho, volta ao spec): a perna de texto (OU de todas as palavras, `simple`, sem stopwords) casa palavras vazias ("como", "do", "be", "an") e, no RRF, um documento nas duas pernas com ranks medianos passa na frente do 1º lugar de uma perna só. Em 2 de 3 consultas ao vivo o alvo certo saiu do top 3 (ex.: `invariant:quarry-nota-idempotente` é o 1º do vetor e ficou em 3º). O benchmark (T10) mede isso por perna

### Fase 3: Benchmark
- [x] T9: fixtures do benchmark e métricas (M)
- [x] T10: script do benchmark, 1ª rodada e escolha do modelo (M). O Gemma 270m venceu pela regra e foi confirmado pelo dono em 26/11. A híbrida perdeu para o vetor sozinho, o que levou à Emenda 1 do spec.

### Fase 4: Emenda 1, híbrida melhorada
- [x] T12: spike da imagem do banco com pg_textsearch 1.6.0 (S)
- [x] T14: `dogfood:prepare` (S)

### Checkpoint D: base pronta
- [x] A suíte inteira passa na imagem nova; perguntas da emenda fechadas (achados abaixo)
- [x] O dono viu os números do `dogfood:prepare` (arquivos, lotes, tokens) e liberou a extração

- [x] T13: perna de texto em BM25 (M)
- [x] T15: extração com subagentes Haiku, `dogfood:build` e revisão da amostra (M)
- [ ] T16: perna de grafo (M)
- [ ] T17: fusão calibrada no `search` (M)

### Checkpoint E: pernas e dados prontos
- [ ] Três pernas com teste; dataset do dogfooding validado, com a taxa de erro da amostra registrada
- [ ] `pnpm check:task` verde

- [ ] T18: benchmark com calibração e teste e decisão da fusão (M)

### Checkpoint F: decisão
- [ ] Resultado agregado no spec; configuração da fusão (ou só vetor) aplicada pela regra e aprovada pelo dono

### Fase 5: Fechamento
- [ ] T11: fechamento (S)

### Checkpoint C: completo
- [x] Resultado do benchmark no spec e modelo padrão aprovado pelo dono (rodada 1, 26/11)
- [ ] Os 17 critérios do spec ligados a testes (tabela abaixo, preenchida na T11)
- [ ] `pnpm check:task` verde; pronto para a fase Verify

## Achados do spike (T1)

Medido em 25/11/2026 no Docker Desktop 29.9.3 (WSL2: o Docker vê 16 CPUs e 15,3 GB). O container `ollama` roda com 4 CPUs e 3 GB (`docker inspect`: `NanoCpus=4e9`, `Memory=3221225472`). Imagem `ollama/ollama:0.40.18`, publicada em 24/11 às 08:06 UTC, mais de 1 dia antes da medida.

| # | Pergunta | Achado | Efeito |
|---|---|---|---|
| 1 | Dimensões | `qwen3-embedding:0.6b`: 1024 (Q8_0, 596M). `embeddinggemma-2`: 768 (Q8_0), confirmados na resposta do `/v1/embeddings`. Os vetores já vêm normalizados (norma 1). | O catálogo usa 1024 e 768 |
| 2 | Tag do EmbeddingGemma 2 | **Contradiz o spec.** A `570m` não é só de texto: é o modelo de texto de 270M mais o codificador de **áudio** (300M), segundo o model card (tabela de variantes) e o `ollama show` (capacidade `audio`). O texto é o mesmo de 270M em todas as tags: `270m` e `570m` dão vetores idênticos (cosseno 1,000000 e 0,999999). | Candidata justa: `embeddinggemma-2:270m` (só texto, 528 MB carregada). Decisão do dono. |
| 3 | Prefixo do Ollama | Os dois modelos têm `TEMPLATE {{ .Prompt }}`. O texto cru e o texto com prefixo dão vetores diferentes (cosseno 0,93 no Gemma e 0,90 no Qwen), então o Ollama não aplica prefixo nenhum. | O prefixo é responsabilidade do catálogo |
| 4 | Template do Qwen3 | Pelo model card: `Instruct: {tarefa}\nQuery:{consulta}`, sem espaço depois de `Query:`, com uma frase de tarefa em inglês ("in multilingual contexts… write their instructions in English"). Documentos vão sem instrução. Tarefa: `Given a web search query, retrieve relevant passages that answer the query`. | Catálogo |
| 5 | Template do Gemma 2 | Consulta `task: search result \| query: {q}`; documento `title: {title} \| text: {content}`, como estava no spec | Catálogo |
| 6 | Texto acima do contexto | Truncamento **silencioso**, sem erro: o Qwen3 em 4096 tokens (`num_ctx` padrão do Ollama) e o Gemma em 2048. O texto longo e o texto longo com cauda diferente dão cosseno 1,0. O `usage.prompt_tokens` mostra o corte. | Entidades típicas ficam muito abaixo disso. O limite de tamanho de `content` fica com o `mcp-server` (pendência 4) |
| 6b | Teste com `OLLAMA_CONTEXT_LENGTH=8192` (pedido do dono; override temporário, o compose não mudou) | O `ollama ps` passa a mostrar contexto 8192. O **Gemma continua cortando em 2048 tokens**, então o limite dele não é o `num_ctx`. O Qwen3 passa a aceitar mais: um texto de 5782 tokens foi embutido inteiro, mas levou **81 s** em CPU. O Gemma, com 2048 tokens, levou ~8 s. Entradas longas custam caro em CPU (atenção quadrática), e um só texto assim trava o lote. | O limite de tamanho do `content` fica com o `mcp-server`: ~2048 tokens (o corte do Gemma), ou ~1500 palavras. O compose fica no padrão. |
| 7 | `vector` sem dimensão | Funciona no pgvector 0.8.7: linhas de 3 e 4 dims convivem, e comparar dimensões diferentes dá `different vector dimensions`. | O filtro `model = $1` vai sempre na mesma consulta da distância |
| 8 | Drizzle | `vector()` exige `dimensions` e gera `vector(N)` | `customType` em `src/embeddings/schema.ts` |
| 9 | `--wait` com serviço de pull | Um serviço de uma execução só conta como pronto enquanto ainda baixa. O `up --wait` voltou com o modelo a 41%. | Plano B aplicado: o pull roda no entrypoint do `ollama`, e o healthcheck só fica verde com o modelo presente (`ollama show`). Um modelo novo levou 46 s até o healthy. Num restart com o modelo no volume, não há pull. O `ollama-pull` saiu do compose. |
| 10 | Memória | Com `KEEP_ALIVE=-1`, todo modelo usado fica carregado: com dois, deu 2,46/3 GB. | `OLLAMA_MAX_LOADED_MODELS=1`. Com um só: Qwen3 1,21 GB, Gemma 270m 0,54 GB |
| 11 | Latência (sonda rápida, não é o benchmark) | Modelo carregado, 30 consultas: Qwen3 p50 191 ms / p95 216 ms; Gemma 270m p50 85 ms / p95 97 ms. Carga a frio: ~1,6–1,8 s. Lote de 32 documentos de ~70 tokens: Qwen3 17,8 s, Gemma 8,2 s. | O Qwen3 fica perto do corte de 300 ms, e um vCPU de VPS costuma ser mais lento |
| 12 | Papel do app | O `fluxie_app` não cria nem tabela temporária, como esperado pelo endurecimento | Nada a mudar |
| 13 | CI | `docker compose up -d --wait db` continua subindo só o banco | O CI não muda |

## Achados do spike da Emenda 1 (T12)

Medido em 26/11/2026, no Docker Desktop local, com a imagem `fluxie-brain-db:pg19-pgvector0.8.7-pgts1.6.0` (`docker/db/Dockerfile`).

| # | Pergunta | Achado | Efeito |
|---|---|---|---|
| 1 | Pacote pronto ou compilar? | A v1.6.0 (23/11/2026 17:00 UTC) publica zips para pg17, pg18 e pg19 em amd64 e arm64, além do código-fonte. A base é Debian 12 com Postgres 19.0. | Compila do tarball de código (sha256 `356244be…f8fd`, o digest do release), com os headers fixados na versão exata do servidor. Build em **64 s** (cache frio). |
| 2 | Dois índices `bm25` sobre a mesma expressão? | Funciona: `bm25 ((title \|\| ' ' \|\| content))` com `portuguese` e com `english` na mesma tabela. Coluna também funciona. | Índices sobre a expressão, sem coluna nova: **o core-graph não muda** |
| 3 | Stopwords e radical | Com `portuguese`, um documento só com "como" tem score 0; "faturar" casa "faturamento". | É o que faltava na perna de texto (critério 14) |
| 4 | Linhas sem termo casado | Voltam com score **0**. O score é negativo, e menor é melhor. | A perna filtra `score < 0` |
| 5 | Filtros no `WHERE` (`EXPLAIN ANALYZE`, 50 mil linhas) | `Index Scan using bm_pt` com os filtros de space e status aplicados depois: 5 ms com filtros, 0,3 ms sem. | Serve. Limite conhecido: um space pequeno numa tabela grande faz o scan percorrer mais linhas até completar o `LIMIT` |
| 6 | Papel restrito | O `fluxie_app` consulta com `<@>`/`to_bm25query`. `create extension pg_textsearch` fica no `init-db.sh` (superusuário), como o `vector`. | A migração só cria os índices |
| 7 | Suíte e SAST | `pnpm check:task`: 284 testes passam na imagem nova sem mudança de código. `pnpm check:sast` limpo com o Dockerfile. | O CI passa a construir a imagem (`build:` no compose). Confirmo no PR |
| 8 | IDF entre spaces | As estatísticas são do índice inteiro (os 50 spaces da sonda). | Limite conhecido, já registrado no spec |

## Dataset do dogfooding (T15)

Gerado em 26/11/2026 por 1 subagente de âncoras e 19 subagentes de lote (Haiku 5.5, esforço `low`), a partir de 205 arquivos do chatbot. Os dados ficam em `.dogfood/`, fora do git, e aqui entram só números.

| Medida | Valor |
|---|---|
| Brutos | 392 entidades (20 delas âncoras), 505 relações, 597 consultas |
| Descartes | 0 entidades, 0 relações, 0 keys duplicadas; consultas: 6 paráfrases com palavra do título e 16 `exact` cujo identificador não está no texto |
| Válidos | 392 entidades, 505 relações, 575 consultas; carga pelo core-graph sem nenhum `OntologyError` |
| Por grupo | en→en 72, en→pt 213, pt→en 78, pt→pt 212 |
| Por tipo | lexical 201, paraphrase 189, exact 132, multihop 53 |
| Divisão | calibração 291, teste 284 (semente 20261126, estratificada por grupo e tipo) |

**Revisão da amostra** (sorteada com semente fixa: 40 entidades de conhecimento e 58 consultas):
- **Entidades:** 3 de 40 com problema (7,5%), todas duplicatas de conceito entre lotes (o mesmo assunto tirado do plano e do spec, ou do plano e do relatório). Nenhum tipo errado nem metadata inventada.
- **Consultas:** 5 de 58 com problema (8,6%). Nenhuma tem gabarito errado: 4 ficaram ambíguas porque o alvo tem um gêmeo de outro lote, e 1 `multihop` ficou fraca.
- **Resultado:** abaixo do corte de 20%, então não há nova extração.

As duplicatas baixam o MRR absoluto igualmente em todas as configurações. Mesmo assim, a T18 reporta também uma leitura em que um gêmeo quase idêntico (mesmo tipo e cosseno ≥ 0,93 com o esperado) conta como acerto, para medir o efeito.

## Rastreabilidade: critérios do spec → testes

Preenchida na T11.

## Pendências herdadas do presets

A tabela completa está em `tasks/presets/plan.md`, seção "Pendências para módulos seguintes".

| # | Pendência | Situação |
|---|---|---|
| 1 | Importar `src/presets/index.ts` exige `DATABASE_URL` | Fechada no `SPEC-embeddings.md`, sem código. Scripts importam o preset direto. |
| 2 | A busca a partir de uma dependência compartilhada chega ao outro repo | Resolvida pela regra `scope` (T6, T7, T8) |
| 3–5 | Metadata de relação, prompt injection, `getPreset` somente leitura | Continuam com o `mcp-server` |

## Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| O Ollama já aplica prefixo, ou o template do Qwen3 é outro | Médio: comparação injusta | Medido na T1, com um teste de similaridade (prefixo dobrado × único); catálogo ajustado antes da T2 |
| `--wait` falha com o serviço de pull que termina | Baixo | Plano B na T1: o pull roda no entrypoint do próprio `ollama` antes do healthcheck ficar verde |
| O WSL2 dá menos de 4 CPUs ao Docker | Médio: latência pessimista ou otimista | A T1 confere (`docker info`) e registra; ajuste no `.wslconfig` é do dono |
| O benchmark não separa os modelos (corpus pequeno) | Médio | Distratores e consultas parafraseadas (T9); o relatório mostra o tamanho da diferença, e a regra de desempate cobre o empate |
| Consultas escritas olhando os dados ficam lexicais demais | Médio | Campo `kind: 'paraphrase'`; um teste da T9 garante que essas consultas não dividem palavras de conteúdo com o título esperado |
| O escopo vaza por uma relação esquecida | Alto | Teste no corpus nos dois sentidos, em `hits` e em `context` (entidades e relações); protótipo já confirmado com a redação do spec |
| Arquivo acima de 300 linhas (`search.ts`) | Baixo | Fusão e tsquery em `fusion.ts`, escopo em `scope.ts`, contexto em `context.ts` se passar |
| Cobertura das linhas alteradas abaixo de 80% | Baixo | O stub cobre os caminhos de erro do provedor; o script do benchmark fica fora de `src`, e as métricas dele têm teste |

### Riscos da Emenda 1

| Risco | Impacto | Mitigação |
|---|---|---|
| O suporte do pg_textsearch ao PG19 tem 3 dias e pode ter bugs | Alto: perna de texto e banco | T12 primeiro, com a suíte inteira na imagem nova. Se falhar, para e volta ao dono (as opções são o PG18 com a v1.5.1 ou o BM25 em SQL) |
| `CREATE EXTENSION pg_textsearch` exige superusuário | Médio | O `init-db.sh` cria a extensão nos dois bancos (o principal e o de teste), e a migração só cria os índices. A T12 confere |
| A extensão não aceita dois índices na mesma expressão | Médio | A T12 testa. Plano B: uma coluna gerada `search_text` no core-graph, que é mudança de schema e pede pergunta ao dono |
| Compilar a extensão deixa o CI lento | Baixo | Dockerfile multi-stage com a versão fixada e o código conferido por checksum. O tempo é medido na T12 |
| Os subagentes Haiku inventam keys ou relações para âncoras que não existem | Médio | As âncoras saem antes (T15, passo 1) e são passadas a cada lote; o `dogfood:build` descarta relações com pontas desconhecidas e conta |
| Consultas geradas a partir do próprio texto ficam lexicais demais | Médio | Tipos separados, regra das paráfrases conferida por código e relatório por tipo |
| Calibração sobreajustada a poucas consultas | Médio | Divisão 50/50 estratificada com semente fixa, grade pequena e número reportado só nas consultas de teste |
| Texto do chatbot vazar para o repositório público | Alto | `.dogfood/` no `.gitignore`, o `gitleaks` no pre-commit, e o spec recebe só números agregados. Os testes usam só fixtures fictícias |
| A latência da busca inteira passar de 300 ms | Médio | Medida na T18 com a configuração escolhida; a regra cai para a melhor configuração que couber |

## Perguntas em aberto

- As da Emenda 1 são fechadas pelo spike da T12 e pela revisão da amostra na T15.
