# Spec: embeddings

Módulo 2 de `CAPABILITY-MAP.md`. Depende só do `core-graph`, pelo `src/core-graph/index.ts`. O `mcp-server` e o `ingest-conversations` dependem dele.

## Objetivo

Encontrar o conhecimento certo para o trabalho atual, em português ou inglês, sem trazer conhecimento de outra stack. Para isso o módulo:
- gera e mantém vetores das entidades com um modelo local (Ollama), por uma API compatível com a da OpenAI (`/v1/embeddings`), para dar para trocar de provedor depois;
- faz busca híbrida: vetor + full-text, fundidos por RRF, mais os vizinhos a 1–2 saltos como contexto;
- recebe opcionalmente uma âncora (o repo ou component atual) e devolve só o que está no escopo dela;
- escolhe o modelo por benchmark entre Qwen3-Embedding-0.6B e EmbeddingGemma 2 (`270m`) em PT/EN; até lá, o Gemma é o padrão provisório.

**Usuários do módulo:** o `mcp-server`, que chama `syncEmbeddings` depois das escritas e `search` nas ferramentas de busca; depois, o `ingest-conversations`.

**Histórias:**
- Como agente no `pebble-web`, pergunto "como evitar efeitos duplicados no React?" e recebo a `learning` sobre o strict mode, mesmo sem nenhuma palavra em comum com o título.
- Como agente, pergunto em português sobre um conhecimento escrito em inglês, e vice-versa, e ele aparece.
- Como agente no `pebble-web`, nunca recebo a pegadinha do Laravel do `quarry-api`. A lição do Postgres, compartilhada pela dependência, aparece nos dois.
- Como agente, recebo junto com cada resultado as decisões, regras e lições ligadas a ele, para não precisar de uma segunda chamada.
- Como dono, troco o modelo de embeddings mudando uma variável de ambiente, sem migração. Os vetores do modelo novo são gerados pelo `syncEmbeddings`.

**Fora do escopo deste módulo:**
- quando chamar o `syncEmbeddings` (depois de cada escrita, em lote ou num worker): decisão do `mcp-server`;
- `recordUsage` dos resultados, porque só o agente sabe o que usou: `mcp-server`;
- limites de entrada para agentes, autenticação e tratamento do conteúdo como não confiável (pendências 3 a 5 do `tasks/presets/plan.md`): `mcp-server`;
- dedupe e detecção de contradição por similaridade: `curation`, que vai reaproveitar este módulo;
- embeddings de imagem e reranker;
- índice HNSW (ver "Decisões");
- remover vetores de modelos que não estão mais em uso.

## Escopo pela âncora (pendência 2)

A busca a partir de um repo não pode cair no conhecimento de outro repo só porque os dois usam a mesma dependência. A busca em largura do `neighbors` não serve para isso: a partir do Postgres, ela anda para trás pelo `depends_on` até o outro repo. Além disso, as lições sobre as dependências dos componentes de um repo ficam a 3 saltos dele e não aparecem.

**Regra (genérica, declarada pelo preset):**

```ts
type ScopeRule = { containment: string[]; usage: string[] };
// Development Graph: { containment: ['part_of'], usage: ['depends_on'] }
```

1. **Próprio:** a âncora mais tudo o que se alcança por relações de `containment`, seguidas nos dois sentidos e de forma transitiva (repo ↔ components ↔ subcomponents).
2. **Usado:** um salto para fora (`from` → `to`) por relações de `usage`, a partir de qualquer item próprio. Daí não se expande mais: nunca se volta de uma dependência para outro repo, e um component de outro repo usado como dependência não traz os irmãos dele.
3. **No escopo:** os itens próprios e usados, mais toda entidade ligada diretamente a um deles por uma relação que não seja de `containment` nem de `usage` (`applies_to`, `about`, `describes`, `waits_for`, `relates_to`…).

**Protótipo no corpus atual** (`tests/fixtures/development-graph/corpus.json`, anotação `project`): a partir de `repo:fictora/pebble-web`, de `repo:fictora/quarry-api` e de `component:fictora/quarry-api/faturamento`, nenhum item do outro projeto aparece, todos os itens do próprio projeto e os `shared` aparecem, e as lições sobre dependências de componentes entram.

**Limite conhecido** (já documentado no `edge-cases.test.ts` do presets): uma lição ancorada por engano numa dependência compartilhada aparece nos dois repos. A separação vale enquanto as âncoras estão certas, e o `curation` cuida disso.

**Onde mora cada parte:**
- **`presets`:** o tipo `Preset` ganha o campo opcional `scope` com o mesmo formato. O Development Graph declara o seu. É uma mudança aditiva, e um teste confere que os tipos de relação citados existem no preset.
- **`embeddings`:** recebe a regra como parâmetro da busca, porque não importa `presets`. Isso segue a direção do `CAPABILITY-MAP.md`.
- **`mcp-server`:** liga uma coisa à outra, passando `getPreset(space.preset).scope` para a busca.

## Tech Stack

Mesma regra dos outros módulos: versão estável mais recente, fixada com número exato e conferida no dia da implementação, respeitando o `minimumReleaseAge` do pnpm (e, por analogia, uma imagem Docker publicada há pelo menos 1 dia). Estado em 25/11/2026:

- **Ollama:** imagem `ollama/ollama:0.40.18`, publicada em 24/11/2026, mais de 1 dia antes do build.
  - **Só CPU, em todo lugar:** localmente no Docker Desktop, sem GPU, e igual na VPS. Assim o ambiente local é igual ao de produção e os números do benchmark valem para o deploy. A GPU local (RTX 3060) não é usada, e o compose não reserva GPU.
  - **VPS alvo:** 4 vCPU, 10 GB de RAM e 100 GB de disco, para tudo junto: Postgres, Ollama e, depois, o `mcp-server`. Para a máquina local reproduzir a VPS, o compose limita o `ollama` a `cpus: 4` e `mem_limit: 3g`. A memória é um orçamento a confirmar no build: um modelo de ~0,6 B mais o runtime cabem com folga, e sobram ~7 GB para o resto. Os modelos ocupam ~1–2 GB do disco.
  - **Modelo sempre carregado:** `OLLAMA_KEEP_ALIVE=-1`. Com o padrão do Ollama, o modelo sai da memória depois de 5 minutos parado, e a primeira busca seguinte paga o carregamento.
- **Candidatos do benchmark**, ambos só de texto e com tamanho parecido:
  - `qwen3-embedding:0.6b`: 639 MB, 1024 dims, 32K de contexto, Apache 2.0;
  - `embeddinggemma-2:270m`: ~0,5 GB carregado, 768 dims (truncável para 512/256/128), Apache 2.0, lançado em 06/10/2026. É a tag só de texto. A `570m` é o mesmo modelo de texto mais um codificador de áudio, e os vetores de texto das duas são idênticos (spike da T1).
- **Cliente do provedor:** o `fetch` nativo do Node 26 contra `POST {base}/embeddings`, com a resposta validada por Zod. Não entra SDK; o Ollama aceita `input` em lote, `dimensions` e `encoding_format`.
- **pg_textsearch 1.6.0** (Emenda 1): BM25 no Postgres, sob a PostgreSQL License, lançado em 23/11/2026 com suporte completo ao Postgres 19. Não tem imagem oficial, então o `db` usa uma imagem própria em cima de `pgvector/pgvector:0.8.7-pg19`. O ParadeDB `pg_search` ficou de fora: é AGPL-3.0 e usa tokenizadores próprios, sem stemmer português confirmado.
- **pgvector 0.8.7** (já no compose). Coluna `vector` sem dimensão fixa. Os dois modelos ficam bem abaixo do limite de 2000 dims do HNSW, que continua possível depois.
- **Nenhuma dependência npm nova prevista.** Se o Drizzle não aceitar `vector` sem dimensão, usa-se um `customType`, como o `tsvector` do core-graph.

## Modelo de dados

```
entity_embeddings                      (migração do embeddings)
  entity_id uuid fk→entities on delete cascade · model text · source_hash text
  embedding vector                     -- sem dimensão fixa; a dimensão é a do modelo da linha
  updated_at timestamptz
  primary key (entity_id, model)

índice GIN em entities(tsv)            (migração SQL custom do embeddings; o spec do core-graph já previa)
```

- **GIN sem mexer no core-graph:** o Drizzle declara índices dentro da tabela, e a tabela `entities` é do `src/core-graph/schema.ts`. Por isso o GIN entra numa migração SQL custom (`drizzle-kit generate --custom`), como a `0000_enable_pgvector.sql`. O `drizzle-kit` compara só snapshots do schema, então gerações futuras não tentam remover o índice.
- **Desatualizado:** um vetor está desatualizado quando `source_hash` difere de `entities.content_hash`. Isso cobre update, aceite de proposta e revert, e uma mudança só no metadata não gera vetor novo, porque o hash cobre só `title` e `content`.
- **Vários modelos convivem:** a busca compara só linhas do modelo ativo (`model = $1`), então a dimensão sempre bate. Trocar de modelo não exige migração.
- **Permissões:** o `fluxie_app` recebe DML na tabela nova pelos default privileges do `init-db.sh`. O `truncateAll` dos testes já pega todas as tabelas do schema.

## Interface (API do módulo)

```ts
type ScopeRule = { containment: string[]; usage: string[] };

syncEmbeddings(spaceId, opts?: { batchSize? })                      // padrão 32
  : Promise<{ embedded: number; remaining: number }>
  // Gera ou regenera os vetores ausentes ou desatualizados do modelo ativo, todas as entidades do space.
  // É idempotente; chamadas concorrentes não duplicam (upsert por entity_id+model).

search(spaceId, query: string, opts?: {
  anchor?: { key: string; scope: ScopeRule };                       // filtra pelo escopo da âncora
  statuses?: EntityStatus[];                                        // padrão ['approved', 'draft']
  types?: string[];
  limit?: number;                                                   // padrão 10, máximo 50
  depth?: 0 | 1 | 2;                                                // vizinhos de contexto; padrão 1
}): Promise<SearchResult>

type SearchResult = {
  hits: { entity: Entity; score: number; ranks: { vector?: number; text?: number } }[];
  context: GraphSlice;            // vizinhos dos hits, sem repetir hits, no mesmo escopo e status;
                                  // as relações também: só as que ligam duas entidades do resultado
  vector: 'ok' | 'unavailable';   // 'unavailable': o provedor falhou e a busca usou só o texto
};
```

**Comportamento da busca:**
1. Valida a entrada: consulta não vazia de até 2000 caracteres, `limit` entre 1 e 50, e uma âncora que exista no space. Senão, lança o erro do core-graph correspondente (`NotFoundError` para a âncora).
2. Calcula o escopo, se houver âncora.
3. **Perna vetorial:** embute a consulta com o template de consulta do modelo e pega os 50 mais próximos por distância de cosseno, entre as entidades do space no escopo, nos status e tipos pedidos (busca exata).
4. **Perna de texto:** `tsv` contra os termos da consulta combinados com OU (o `plainto_tsquery` exige todos os termos, e uma pergunta em linguagem natural quase nunca casa), ordenados por `ts_rank_cd`, com os mesmos filtros; os 50 primeiros.
5. **RRF:** `score = Σ 1/(60 + rank)` nas duas listas; desempate pelo `id`, para o resultado ser determinístico.
6. **Contexto:** vizinhos dos `hits` até `depth`, com o mesmo escopo e os mesmos status, e as relações entre eles.
7. **Provedor fora do ar:** a perna vetorial é pulada, o resultado sai só do texto e vem com `vector: 'unavailable'`. A busca não falha por causa do Ollama.

**Configuração** (lida do ambiente a cada chamada pública, o que é barato; nunca na importação nem guardada em cache). Por dentro, as funções recebem um objeto de configuração explícito: os testes apontam para o stub numa porta qualquer, e o benchmark troca de modelo no mesmo processo.
- `EMBEDDINGS_BASE_URL`: padrão `http://127.0.0.1:11434/v1`;
- `EMBEDDINGS_MODEL`: padrão provisório `embeddinggemma-2:270m`; depois da T10, o vencedor do benchmark;
- `EMBEDDINGS_API_KEY`: opcional, enviada como `Bearer` (provedor remoto).

**Catálogo de modelos** (em código): para cada id, a dimensão, o template de documento e o template de consulta.
- EmbeddingGemma 2: documento `title: {title} | text: {content}`; consulta `task: search result | query: {q}`.
- Qwen3: documento sem instrução; consulta `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:{q}`. Sem espaço depois de `Query:`, e a instrução em inglês, como recomenda o model card.
- O Ollama não aplica prefixo nenhum (`TEMPLATE {{ .Prompt }}`; conferido no spike), então os templates do catálogo são os únicos.
- Um modelo fora do catálogo é erro de configuração. Mudar um template exige um id novo no catálogo, para os vetores antigos não se misturarem com os novos.

**Erros:** `EmbeddingProviderError` (rede, status HTTP, resposta inválida) e `EmbeddingConfigError` (modelo desconhecido), os dois derivados de `CoreGraphError`, para o `mcp-server` tratar todos os erros do domínio de um jeito só. A resposta do provedor é validada antes de qualquer escrita:
- número de vetores igual ao de entradas;
- dimensão igual à do catálogo;
- todos os números finitos, porque o EmbeddingGemma em float16 pode gerar NaN.

Se algo falhar, nada é gravado.

**Mudanças em módulos prontos** (aprovadas na entrevista):
- **`core-graph`:** o `index.ts` passa a exportar `db` e as tabelas `entities` e `relations`. O embeddings só lê essas tabelas e nunca escreve nelas; as escritas continuam passando pela API do core-graph.
- **`presets`:** campo opcional `scope` no `Preset`, e o valor do Development Graph.
- **Pendência 1 (`DATABASE_URL` na importação):** fecha sem código. Scripts e testes que só precisam do vocabulário importam `src/presets/development-graph/index.ts` direto, o que já funciona sem banco (conferido). Ela volta a ser tratada (com pool preguiçoso) só se um módulo de `src` precisar do vocabulário sem banco.

## Benchmark

`scripts/bench-embeddings.ts`, rodado à mão com o Ollama no ar. Não roda no CI.

- **Banco:** o de testes (`fluxie_brain_test`, pelas variáveis `TEST_*`), esvaziado no início pelo mesmo `truncateAll`, que recusa qualquer banco sem o sufixo `_test`. Nunca o `fluxie_brain`: o `fluxie_app` não apaga entidades, e o benchmark deixaria dados para sempre. Não roda junto com os testes.
- **Pernas isoladas:** o `search` público devolve só os hits fundidos. O script importa por dentro as funções de cada perna (`src/embeddings/search.ts`), com configuração explícita. Scripts podem fazer isso; a regra de importar só pelo `index.ts` vale dentro de `src`.

- **Dados:**
  - o corpus do presets (32 entidades), sem alterações;
  - `tests/fixtures/embeddings/distractors.json`: uns 30–40 distratores fictícios e válidos para o preset (quase-duplicatas, o mesmo assunto no outro idioma, um terceiro repo de outra stack);
  - `tests/fixtures/embeddings/queries.json`: cerca de 40 consultas, cada uma com `id`, `lang`, `targetLang`, `text` e `expected` (as keys relevantes). Grupos: PT→PT, EN→EN, PT→EN e EN→PT.
- **Sem âncora:** o idioma está amarrado ao projeto no corpus (pebble todo em EN, quarry todo em PT), e com âncora o filtro faria o trabalho do modelo.
- **Medidas por modelo:**
  - MRR@10 e recall@5, no total e por grupo, para cada perna isolada (só vetor, só texto) e para a híbrida. A perna só de texto avalia o `tsv 'simple'` (pergunta em aberto 1 do spec do core-graph);
  - latência p50/p95 para embutir uma consulta com o modelo já carregado, em CPU (Docker Desktop local, sem GPU, com os limites da VPS), e o tempo de carga a frio, à parte;
  - memória do container `ollama` em uso (`docker stats`), que precisa caber nos 3 GB;
  - tempo para embutir o corpus inteiro;
  - verificação de que nenhum vetor tem NaN.
- **Regra de escolha** (neutra; o dono confirmou depois de comparar o MTEB multilíngue, Qwen3 64,33 × Gemma 61,36, com a latência do spike):
  - vence o maior MRR@10 híbrido;
  - se a diferença for menor que 0,02, vence o mais rápido em CPU;
  - um modelo com p95 acima de 300 ms em CPU está fora.
- **Registro:** o resultado (a tabela que o script imprime, a data, as versões do Ollama e dos modelos, e a CPU usada) entra na seção "Resultado do benchmark" deste spec. O vencedor vira o padrão de `EMBEDDINGS_MODEL`.

## Comandos

```
docker compose up -d --wait db                                      # testes (não precisam do Ollama)
docker compose up -d --wait                                         # db + ollama, só CPU (local e VPS)
pnpm db:migrate
pnpm bench:embeddings                                               # node scripts/bench-embeddings.ts
pnpm check:fast | check:task | check:full                           # como no CONSTRAINTS.md
```

No compose, o serviço `ollama` publica a porta só em `127.0.0.1`, guarda os modelos num volume, tem healthcheck e roda com os limites da VPS (`cpus: 4`, `mem_limit: 3g`, `OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_MAX_LOADED_MODELS=1`). O entrypoint baixa o modelo de `EMBEDDINGS_MODEL`, se ele ainda não estiver no volume, e o healthcheck só fica verde com o modelo presente; assim o `up --wait` espera o download. Um serviço de pull à parte contava como pronto ainda baixando.

## Estrutura do projeto

```
src/embeddings/
  schema.ts      → tabela entity_embeddings (Drizzle)
  models.ts      → catálogo: dimensão e templates por modelo
  provider.ts    → cliente /v1/embeddings (fetch + validação Zod), configuração por env
  sync.ts        → syncEmbeddings
  scope.ts       → ScopeRule → ids no escopo (SQL)
  search.ts      → pernas vetor e texto, RRF, contexto
  errors.ts
  index.ts       → API pública
migrations/      → 0006_entity_embeddings.sql (tabela + GIN em tsv), gerada pelo drizzle-kit
scripts/bench-embeddings.ts
tests/embeddings/                  → integração com um stub HTTP do provedor (node:http)
tests/fixtures/embeddings/         → queries.json, distractors.json
docker-compose.yml (+ serviço ollama, só CPU)
drizzle.config.ts                  → schema passa a ser a lista dos dois schema.ts
```

Os arquivos são separados por responsabilidade. Os limites do `CONSTRAINTS.md` (300 linhas por arquivo, 50 por função, complexidade 15) decidem quando dividir.

## Estilo de código

O mesmo do core-graph: funções exportadas, sem classes, erros tipados, nomes em inglês e documentação em português. SQL cru (`sql```) só onde o Drizzle não alcança (distância vetorial, `ts_rank_cd`, CTE recursiva do escopo).

```ts
/** Reciprocal Rank Fusion: each list contributes 1/(k + rank); ties break by id for stable output. */
export function fuse(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
```

## Estratégia de testes

- **CI sem Ollama:** os testes usam um stub HTTP local que implementa `/v1/embeddings` com vetores determinísticos. Por padrão é um saco de palavras com hash, que deixa próximos os textos que dividem palavras. Para o caso "acha pelo vetor sem nenhuma palavra em comum", o stub aceita um mapa texto → vetor, que o teste define, porque um saco de palavras não consegue aproximar textos sem palavras em comum. Nenhum teste é pulado por falta de Ollama; o modelo real é exercitado pelo benchmark.
- **Unitário:** RRF, montagem da tsquery com OU (incluindo caracteres especiais e consulta só com símbolos), templates do catálogo e validação da resposta do provedor (contagem, dimensão, NaN, JSON inválido).
- **Integração** (banco do compose, harness existente):
  - **sync:** gera o que falta; regenera depois de mudar `content`, aceitar proposta ou fazer revert; não regenera depois de mudar só `metadata`; é idempotente; um modelo não toca nos vetores do outro;
  - **search:** a perna de texto acha por palavra; a perna vetorial acha sem palavra em comum; a fusão junta as duas; os filtros de status e tipo funcionam; `limit` e `depth` são respeitados; o provedor fora do ar dá `vector: 'unavailable'`;
  - **escopo:** com o corpus do presets e a regra do Development Graph, a partir de cada repo e de um component não aparece nada do outro projeto, nem nos `hits` nem no `context`; os itens `shared` aparecem nos dois; o conhecimento sobre dependências de componentes aparece; uma âncora inexistente dá `NotFoundError`.
- **Presets:** a regra `scope` cita só relações que existem no preset, e a API pública inclui o campo.
- **Cobertura:** ≥ 80% das linhas alteradas, e o ratchet do `vitest.config.ts` não cai. O `scripts/bench-embeddings.ts` fica de fora da cobertura, porque depende do Ollama; a lógica de métricas dele (MRR, recall) fica num arquivo testado.

## Fronteiras

- **Sempre:**
  - validar a resposta do provedor antes de gravar;
  - filtrar por `spaceId` em todas as consultas, e pela âncora quando houver, incluindo o contexto;
  - só dados fictícios nas fixtures;
  - versões fixadas e conferidas no dia;
  - Ollama exposto só em `127.0.0.1`, ou só na rede interna na VPS.
- **Perguntar antes:**
  - mudar a regra de escopo ou o RRF depois do benchmark;
  - criar o índice HNSW;
  - adicionar dependência;
  - mudar o CI;
  - qualquer outra mudança no core-graph ou no presets além das listadas acima.
- **Nunca:**
  - escrever em `entities`, `relations` ou no `change_log` a partir do embeddings;
  - mandar conteúdo para um provedor remoto sem que o dono tenha configurado `EMBEDDINGS_BASE_URL`;
  - pular teste por falta de Ollama;
  - commitar modelos ou vetores gerados.

## Critérios de sucesso

1. `docker compose up -d --wait` sobe o `db` e o `ollama` só em CPU no Docker Desktop local, sem GPU, baixa o modelo padrão, e `POST /v1/embeddings` responde.
2. `pnpm db:migrate` cria a `entity_embeddings` e o GIN em `entities.tsv`, e o `fluxie_app` consegue ler e escrever na tabela nova.
3. `syncEmbeddings` gera vetores para todas as entidades do space e devolve `remaining: 0`. Uma segunda chamada não faz nada. Depois de mudar `title` ou `content` (update, aceite ou revert), só aquela entidade é regenerada; depois de mudar só `metadata`, nenhuma.
4. Uma resposta inválida do provedor (contagem, dimensão, NaN, HTTP de erro, rede) lança `EmbeddingProviderError` e não grava nada. Um modelo fora do catálogo lança `EmbeddingConfigError`.
5. `search` devolve `hits` ordenados pela fusão que a Emenda 1 escolher, com `ranks` por perna. Uma consulta sem palavra em comum com o alvo o encontra pelo vetor; uma consulta por termo exato o encontra pelo texto.
6. Por padrão, só entidades `approved` e `draft`; `statuses` e `types` filtram; `limit` (1–50) e uma consulta (1–2000 caracteres) fora do limite são recusados.
7. Com âncora e a regra do Development Graph, no corpus: nenhuma entidade do outro projeto aparece em `hits` nem em `context`, a partir de `repo:fictora/pebble-web`, de `repo:fictora/quarry-api` e de um component; os itens `shared` aparecem nos dois; as lições sobre dependências de componentes aparecem.
8. Com o provedor fora do ar, `search` responde só pelo texto, com `vector: 'unavailable'`.
9. O `context` traz os vizinhos dos `hits` até `depth`, sem repetir `hits`, respeitando o escopo e os status.
10. O benchmark roda para os dois modelos e imprime MRR@10 e recall@5 (total e por grupo de idioma, por perna) e latência p50/p95 em CPU. O resultado e o modelo escolhido pela regra estão registrados neste spec. Feito em 26/11/2026: `embeddinggemma-2:270m`, confirmado pelo dono.
11. O `Preset` tem o campo opcional `scope`; o Development Graph declara `{ containment: ['part_of'], usage: ['depends_on'] }`; o core-graph exporta `db`, `entities` e `relations`, e nada mais muda nele.
12. O embeddings só importa `src/core-graph/index.ts` (`pnpm check:arch`), e o `pnpm check:task` passa.
13. **Emenda 1, imagem do banco:** `docker compose up -d --wait db` sobe a imagem própria com `pg_textsearch` 1.6.0 e `pgvector` 0.8.7 no Postgres 19, e a suíte inteira passa nela, localmente e no CI.
14. **Emenda 1, texto:** a perna de texto usa BM25 nos dois índices (`portuguese` e `english`), e uma palavra vazia da consulta ("como", "do") não puxa mais documentos para o topo. O `entities.tsv` e o código do core-graph não mudam.
15. **Emenda 1, dogfooding:** o `pnpm dogfood:prepare`, os subagentes Haiku e o `pnpm dogfood:build` geram, a partir da lista permitida do chatbot:
    - entidades e relações válidas para o Development Graph, sem nenhum `OntologyError`;
    - consultas com gabarito nos quatro grupos de idioma e nos tipos `lexical`, `paraphrase`, `exact` e `multihop`.

    Tudo fica em `.dogfood/`, fora do git, e a taxa de erro da amostra revisada está no `tasks/plan.md`.
16. **Emenda 1, decisão:** o benchmark calibra nas consultas de calibração e reporta nas de teste. A configuração escolhida aparece ao lado do vetor sozinho, por grupo e por tipo de consulta, e a busca segue a regra da Emenda 1.
17. **Emenda 1, latência:** com o modelo carregado, o p95 da `search` inteira (consulta, pernas, fusão e contexto) fica em até 300 ms em CPU, com os limites da VPS, no dataset do dogfooding.

## Perguntas em aberto

As perguntas do spec foram fechadas pelo spike da T1. A tabela completa está em `tasks/plan.md`, seção "Achados do spike":
- dimensões 1024 e 768;
- templates exatos, e o Ollama não aplica prefixo;
- tag 0.40.18;
- `customType` para o `vector` sem dimensão;
- **truncamento silencioso:** o Ollama corta o Qwen3 em 4096 tokens e o Gemma em 2048, sem erro. Com `OLLAMA_CONTEXT_LENGTH=8192`, o Gemma continua em 2048, e o Qwen3 aceita mais, porém um texto de ~5800 tokens levou 81 s em CPU. Entidades típicas ficam muito abaixo disso. O compose fica no padrão, e o `mcp-server` limita o `content` a ~2048 tokens (pendência 4).

Fica uma, que não bloqueia: a latência em CPU é medida no Docker Desktop local com os limites da VPS. Um vCPU de VPS costuma ser mais lento que um núcleo de desktop, então o corte de 300 ms é medido de novo na VPS antes do deploy.

## Resultado do benchmark

**Rodada de 2026-11-26** (`pnpm bench:embeddings`, `scripts/bench-embeddings.ts`):
- Ollama 0.40.18, só CPU, no Docker Desktop 29.9.3 local com os limites da VPS (`cpus: 4`, `mem_limit: 3g`), num AMD Ryzen 7 5800H;
- modelos `embeddinggemma-2:270m` e `qwen3-embedding:0.6b` (Q8_0);
- dados: o corpus do presets (32) mais os distratores (32), 40 consultas (10 por grupo), sem âncora.

Qualidade (células: MRR@10 / recall@5):

| Modelo | Perna | all | en->en | pt->pt | pt->en | en->pt |
|---|---|---|---|---|---|---|
| embeddinggemma-2:270m | vector | 0.921 / 1.00 | 0.933 / 1.00 | 0.933 / 1.00 | 0.883 / 1.00 | 0.933 / 1.00 |
| embeddinggemma-2:270m | text | 0.487 / 0.63 | 0.625 / 0.70 | 0.687 / 1.00 | 0.225 / 0.40 | 0.412 / 0.40 |
| embeddinggemma-2:270m | hybrid | 0.642 / 0.65 | 0.733 / 0.70 | 0.950 / 1.00 | 0.412 / 0.40 | 0.472 / 0.50 |
| qwen3-embedding:0.6b | vector | 0.861 / 0.95 | 0.900 / 1.00 | 0.867 / 0.90 | 0.727 / 0.90 | 0.950 / 1.00 |
| qwen3-embedding:0.6b | text | 0.508 / 0.60 | 0.644 / 0.70 | 0.737 / 1.00 | 0.250 / 0.30 | 0.400 / 0.40 |
| qwen3-embedding:0.6b | hybrid | 0.650 / 0.68 | 0.817 / 0.80 | 0.900 / 1.00 | 0.414 / 0.40 | 0.468 / 0.50 |

Desempenho:

| Modelo | Carga a frio | p50 consulta | p95 consulta | Corpus (embutir) | Memória do ollama | Vetores com NaN |
|---|---|---|---|---|---|---|
| embeddinggemma-2:270m | 1.5 s | 81 ms | 89 ms | 8.1 s (64 entidades) | 539.9MiB / 3GiB | 0 |
| qwen3-embedding:0.6b | 1.4 s | 215 ms | 279 ms | 17.9 s (64 entidades) | 1.212GiB / 3GiB | 0 |

**Pela regra:** os dois ficam abaixo de 300 ms de p95, e a diferença de MRR@10 híbrido (0,650 × 0,642) é menor que 0,02, então vence o mais rápido em CPU: **`embeddinggemma-2:270m`**, que já era o padrão. O Gemma também vence só pelo vetor (0,921 × 0,861).

**Achado:** a híbrida perde para o vetor sozinho nos dois modelos (Gemma 0,642 × 0,921). A perna de texto só ajuda em PT→PT, e nas consultas entre idiomas é quase só ruído. Pela decisão do dono no Checkpoint B, isso volta ao spec. A perna de texto também varia entre rodadas (0,487 × 0,508 com as mesmas consultas), porque o `ts_rank_cd` empata muito e o desempate é pelo id, que é aleatório a cada carga.

**Variantes descartáveis** (só Gemma; MRR@10 / recall@5):

| Variante | todas | lexical | paráfrase | PT→PT | entre idiomas |
|---|---|---|---|---|---|
| só vetor | 0.921 / 1.00 | 1.000 / 1.00 | 0.868 / 1.00 | 0.933 / 1.00 | 0.908 / 1.00 |
| híbrida atual (pernas de 50) | 0.642 / 0.70 | 1.000 / 1.00 | 0.403 / 0.50 | 0.950 / 1.00 | 0.434 / 0.45 |
| pernas de 10 | 0.701 / 0.95 | 1.000 / 1.00 | 0.502 / 0.92 | 0.950 / 1.00 | 0.539 / 0.90 |
| texto só com palavras de mais de 3 letras | 0.730 / 0.90 | 1.000 / 1.00 | 0.551 / 0.83 | 0.950 / 1.00 | 0.598 / 0.85 |
| as duas mudanças juntas | 0.753 / 1.00 | 1.000 / 1.00 | 0.589 / 1.00 | 0.950 / 1.00 | 0.634 / 1.00 |

## Emenda 1: busca híbrida melhorada (2026-11-26)

**Por quê:** a híbrida perdeu para o vetor sozinho, mesmo nas variantes corrigidas (acima). Há três causas medidas:
- **Perna de texto:** o `ts_rank_cd` com `simple` não tem IDF, então uma palavra vazia vale tanto quanto um termo raro.
- **Fusão sem peso:** o RRF dá o mesmo peso a uma perna fraca e a uma forte, e 50 candidatos num corpus de 64 põem quase tudo nas duas listas.
- **Dados:** são 64 documentos fictícios, e cada consulta tem um único alvo.

O dono decidiu melhorar a híbrida, em vez de abandoná-la, e medir num projeto real.

**Pesquisa que embasa:**
- [Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search): RRF com peso por perna e `least(match_count, 30) * 2` candidatos.
- [Bruch et al.](https://arxiv.org/abs/2210.11934): a combinação convexa de scores normalizados supera o RRF e se calibra com poucas consultas.
- [Elastic](https://www.elastic.co/search-labs/blog/improving-information-retrieval-elastic-stack-hybrid): pesos ajustados vencem o RRF com ~40 consultas, mas o peso ideal muda de um conjunto de dados para outro. Daí a separação entre calibração e teste.
- [LightRAG](https://github.com/HKUDS/LightRAG), [RAG-Anything](https://github.com/hkuds/rag-anything) e [HippoRAG](https://arxiv.org/abs/2405.14831): acham entidades pelo vetor e espalham a relevância pelo grafo (PageRank personalizado).

### O que muda na busca

1. **Perna de texto em BM25** (`pg_textsearch` 1.6.0):
   - dois índices `bm25` sobre título + conteúdo das `entities`, um com `text_config='portuguese'` e outro com `'english'`;
   - a consulta roda nos dois, e o benchmark escolhe entre o melhor score dos dois e a fusão dos dois;
   - os filtros (space, status, tipo, escopo) continuam valendo;
   - o `entities.tsv` e o GIN da migração 0007 ficam; se nada mais usar o GIN, a retirada é decidida no plano.

   Limite conhecido: as estatísticas do BM25 são da tabela inteira, de todos os spaces.
2. **Perna de grafo** (nova; só fica se vencer):
   - PageRank personalizado sobre as relações do space, dentro do escopo da âncora quando ela existe;
   - sementes: os melhores resultados da perna vetorial, com peso proporcional à similaridade;
   - amortecimento de 0,85, número fixo de iterações, relações nos dois sentidos e pesos iguais por tipo;
   - devolve uma lista ordenada, que entra na fusão como as outras;
   - sem vetor (provedor fora do ar), ela não roda;
   - a implementação (SQL recursivo ou TypeScript sobre uma leitura das relações) é decidida no plano.
3. **Fusão calibrada:**
   - **candidatos:** cada perna traz `2 × limit` candidatos, até 60;
   - **funções comparadas:**
     - RRF com peso por perna (k=60);
     - combinação convexa de scores normalizados (min-max por perna, em cada consulta);
   - **grade de pesos** (relativos ao vetor, que vale 1): texto ∈ {0; 0,25; 0,5; 0,75; 1} e grafo ∈ {0; 0,25; 0,5}. Peso 0 desliga a perna, então "só vetor" faz parte da grade;
   - **o que fica:** a melhor combinação nas consultas de **calibração**, fixada em constantes no `search.ts` (sem env). O número que vale é o das consultas de **teste**.
4. **`ranks`** ganha `graph?: number`.
5. **Provedor fora do ar:** sem mudança, a busca responde pela perna de texto, com `vector: 'unavailable'`.

### Regra de decisão (nas consultas de teste do dogfooding)

- **A fusão entra se cumprir as duas condições:**
  - o MRR@10 dela supera o do vetor sozinho em pelo menos 0,02;
  - nenhum grupo de idioma cai mais que 0,02.

  Se não cumprir, a busca ordena só pelo vetor, e o texto fica de reserva para quando o provedor cair.
- **A perna de grafo fica se cumprir as duas condições:**
  - o peso calibrado dela é maior que 0;
  - nas consultas de vários saltos, ela melhora o MRR@10 em pelo menos 0,02, sem derrubar o total.
- **Latência:** o limite do critério 17 vale para a configuração escolhida. Se ela não couber, vale a melhor que couber.
- **Corpus fictício:** continua no CI e no benchmark para comparação, mas não decide.

### Dogfooding com o `C:\Projetos\chatbot`

- **Lista permitida:**
  - entra: `docs/**/*.md`, `CLAUDE.md`, `AGENTS.md` e `README.md`;
  - fica de fora, sempre: `.env*`, `vendor/`, `node_modules/`, `storage/`, `.git/` e as pastas de agentes (`.claude`, `.agents`, `.codex`, `.gemini`, `.kiro`, `.superpowers`, `.referencias`, `.codegraph`).
- **Segredos:** o `gitleaks` varre a lista antes da extração. Arquivo com achado é pulado e listado, e nenhum subagente o lê.
- **Extração** (decisão do dono em 26/11: subagentes Haiku 5.5 com esforço `low`, nesta mesma sessão do Claude Code; sem OpenRouter, sem chave e sem enviar texto para terceiros). Ela tem três etapas:
  1. **`pnpm dogfood:prepare`** (`scripts/dogfood-prepare.ts`):
     - monta a lista permitida e roda o `gitleaks`;
     - divide os arquivos em lotes de tamanho parecido;
     - grava `.dogfood/batches.json`.
  2. **Âncoras:** um primeiro subagente lê `README.md`, `CLAUDE.md` e `AGENTS.md` e grava em `.dogfood/anchors.json` as âncoras do chatbot (repo, components e dependências), com as keys no formato do preset.
  3. **Lotes:** um subagente por lote, em paralelo, lê só os arquivos do seu lote e grava em `.dogfood/extracted/<lote>.json`, no formato JSON que o prompt define. Cada lote devolve:
  - **entidades** do Development Graph e as relações entre elas e com as âncoras do passo 2;
  - **consultas com gabarito**, nos quatro grupos de idioma e nos tipos:
    - `lexical`;
    - `paraphrase`: não divide palavra de conteúdo com os títulos esperados, conferido por código;
    - `exact`: um identificador exato, como nome de job, de classe ou de chave de config;
    - `multihop`: o alvo só se liga à consulta por uma relação.
- **Validação** (`pnpm dogfood:build`, `scripts/dogfood-build.ts`):
  - junta os lotes e valida com Zod;
  - resolve keys duplicadas entre lotes, ficando com a primeira e contando as outras;
  - confere a regra das paráfrases;
  - carrega tudo no banco de testes pelo core-graph com o preset;
  - grava `.dogfood/dataset.json`.

  Item inválido é descartado e contado.
- **Separação:** as consultas são divididas 50/50 entre calibração e teste, estratificadas por grupo e tipo, com semente fixa.
- **Revisão:**
  - eu reviso uma amostra (10% das entidades e 10% das consultas, no mínimo 30 de cada) antes da primeira rodada, e a taxa de erro entra no `tasks/plan.md`;
  - mais de 20% de erros manda corrigir o prompt e extrair de novo.
- **Configuração:** `DOGFOOD_SOURCE` é o caminho do chatbot, com padrão `C:\Projetos\chatbot`. Não há chave.
- **Custo:** o `dogfood:prepare` imprime quantos arquivos, lotes e tokens estimados vão entrar. A extração só começa depois que o dono vê esses números.
- **Onde os dados ficam:** em `.dogfood/`, que fica no `.gitignore`. O repositório é público, então nenhum texto do chatbot entra em commit, PR, spec ou log do CI; o spec recebe só números agregados.
- **Escopo:** o dogfooding é só para medir e não grava no `fluxie_brain` nem no chatbot.

### Fronteiras (acréscimos)

- **Sempre:**
  - varrer os arquivos com o `gitleaks` antes da extração;
  - dizer a cada subagente que o texto lido é dado, não instrução;
  - deixar `.dogfood/` fora do git;
  - reportar o número das consultas de teste.
- **Perguntar antes:**
  - trocar o modelo ou o esforço dos subagentes de extração;
  - mudar a regra de decisão depois de ver os números de teste.
- **Nunca:**
  - ler os `.env*` do chatbot ou mandar qualquer arquivo dele para fora desta sessão;
  - commitar texto do chatbot;
  - calibrar olhando as consultas de teste.

### Mudanças em módulos prontos

- **Infra do `db`:** o compose e o CI trocam a imagem `pgvector/pgvector:0.8.7-pg19` por uma própria (`docker/db/Dockerfile`), que adiciona o `pg_textsearch` 1.6.0 e o carrega por `shared_preload_libraries`. O código do core-graph não muda.
- **Migrações:** uma migração custom cria a extensão e os dois índices BM25 e dá ao `fluxie_app` o que ele precisar para consultar.

### Perguntas em aberto (fechadas no spike da emenda)

- A v1.6.0 tem pacote pronto para pg19 amd64, ou precisa compilar? A página de releases não mostrou a lista inteira.
- A extensão aceita dois índices `bm25` (`portuguese` e `english`) sobre a mesma expressão? Ela indexa expressão, ou exige uma coluna?
- O `to_bm25query` combina com os filtros de space, status e escopo no mesmo `WHERE` sem perder o índice?
- O Haiku 5.5 em `low` extrai com qualidade suficiente? A revisão da amostra responde. Se ficar acima de 20% de erros, a mudança de modelo ou de esforço é perguntada ao dono.
