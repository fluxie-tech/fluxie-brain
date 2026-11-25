# Spec: embeddings

Módulo 2 de `CAPABILITY-MAP.md`. Depende só do `core-graph`, pelo `src/core-graph/index.ts`. O `mcp-server` e o `ingest-conversations` dependem dele.

## Objetivo

Encontrar o conhecimento certo para o trabalho atual, em português ou inglês, sem trazer conhecimento de outra stack. Para isso o módulo:
- gera e mantém vetores das entidades com um modelo local (Ollama), por uma API compatível com a da OpenAI (`/v1/embeddings`), para dar para trocar de provedor depois;
- faz busca híbrida: vetor + full-text, fundidos por RRF, mais os vizinhos a 1–2 saltos como contexto;
- recebe opcionalmente uma âncora (o repo ou component atual) e devolve só o que está no escopo dela;
- escolhe o modelo por benchmark entre Qwen3-Embedding-0.6B e EmbeddingGemma 2 em PT/EN.

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
- limites de entrada para agentes, autenticação e tratamento do conteúdo como não confiável (pendências 3 a 5 do `tasks/plan.md`): `mcp-server`;
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

- **Ollama:** imagem `ollama/ollama`. A última estável é a 0.40.18, de 24/11; a 0.40.17, de ~20/11, é a mais nova que já passou do prazo hoje. A tag é fixada no build.
  - **Só CPU, em todo lugar:** localmente no Docker Desktop, sem GPU, e igual na VPS. Assim o ambiente local é igual ao de produção e os números do benchmark valem para o deploy. A GPU local (RTX 3060) não é usada, e o compose não reserva GPU.
- **Candidatos do benchmark**, ambos só de texto e com tamanho parecido:
  - `qwen3-embedding:0.6b`: 639 MB, 1024 dims, 32K de contexto, Apache 2.0;
  - `embeddinggemma-2:570m`: ~0,95 GB, 768 dims (truncável para 512/256/128), 8K de contexto pelo model card, Apache 2.0. Lançado em 06/10/2026.
- **Cliente do provedor:** o `fetch` nativo do Node 26 contra `POST {base}/embeddings`, com a resposta validada por Zod. Não entra SDK; o Ollama aceita `input` em lote, `dimensions` e `encoding_format`.
- **pgvector 0.8.7** (já no compose). Coluna `vector` sem dimensão fixa. Os dois modelos ficam bem abaixo do limite de 2000 dims do HNSW, que continua possível depois.
- **Nenhuma dependência npm nova prevista.** Se o Drizzle não aceitar `vector` sem dimensão, usa-se um `customType`, como o `tsvector` do core-graph.

## Modelo de dados

```
entity_embeddings                      (migração do embeddings)
  entity_id uuid fk→entities on delete cascade · model text · source_hash text
  embedding vector                     -- sem dimensão fixa; a dimensão é a do modelo da linha
  updated_at timestamptz
  primary key (entity_id, model)

índice GIN em entities(tsv)            (migração do embeddings; o spec do core-graph já previa)
```

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
  context: GraphSlice;            // vizinhos dos hits, sem repetir hits, no mesmo escopo e status
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

**Configuração** (lida na primeira chamada, nunca na importação):
- `EMBEDDINGS_BASE_URL`: padrão `http://127.0.0.1:11434/v1`;
- `EMBEDDINGS_MODEL`: padrão é o vencedor do benchmark;
- `EMBEDDINGS_API_KEY`: opcional, enviada como `Bearer` (provedor remoto).

**Catálogo de modelos** (em código): para cada id, a dimensão, o template de documento e o template de consulta.
- EmbeddingGemma 2: documento `title: {title} | text: {content}`; consulta `task: search result | query: {q}`.
- Qwen3: documento sem instrução; consulta `Instruct: {tarefa}\nQuery: {q}`.
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

- **Dados:**
  - o corpus do presets (32 entidades), sem alterações;
  - `tests/fixtures/embeddings/distractors.json`: uns 30–40 distratores fictícios e válidos para o preset (quase-duplicatas, o mesmo assunto no outro idioma, um terceiro repo de outra stack);
  - `tests/fixtures/embeddings/queries.json`: cerca de 40 consultas, cada uma com `id`, `lang`, `targetLang`, `text` e `expected` (as keys relevantes). Grupos: PT→PT, EN→EN, PT→EN e EN→PT.
- **Sem âncora:** o idioma está amarrado ao projeto no corpus (pebble todo em EN, quarry todo em PT), e com âncora o filtro faria o trabalho do modelo.
- **Medidas por modelo:**
  - MRR@10 e recall@5, no total e por grupo, para cada perna isolada (só vetor, só texto) e para a híbrida. A perna só de texto avalia o `tsv 'simple'` (pergunta em aberto 1 do spec do core-graph);
  - latência p50/p95 para embutir uma consulta, em CPU (Docker Desktop local, sem GPU);
  - tempo para embutir o corpus inteiro;
  - verificação de que nenhum vetor tem NaN.
- **Regra de escolha:**
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

No compose, o serviço `ollama` publica a porta só em `127.0.0.1`, guarda os modelos num volume e tem healthcheck. Um serviço de uma execução só (`ollama-pull`) baixa o modelo configurado depois que o `ollama` está saudável.

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

- **CI sem Ollama:** os testes usam um stub HTTP local que implementa `/v1/embeddings` com vetores determinísticos (um saco de palavras com hash, que deixa textos parecidos próximos de verdade). Nenhum teste é pulado por falta de Ollama; o modelo real é exercitado pelo benchmark.
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
5. `search` devolve `hits` ordenados pelo RRF das duas pernas, com `ranks` por perna. Uma consulta sem palavra em comum com o alvo o encontra pelo vetor; uma consulta por termo exato o encontra pelo texto.
6. Por padrão, só entidades `approved` e `draft`; `statuses` e `types` filtram; `limit` (1–50) e uma consulta (1–2000 caracteres) fora do limite são recusados.
7. Com âncora e a regra do Development Graph, no corpus: nenhuma entidade do outro projeto aparece em `hits` nem em `context`, a partir de `repo:fictora/pebble-web`, de `repo:fictora/quarry-api` e de um component; os itens `shared` aparecem nos dois; as lições sobre dependências de componentes aparecem.
8. Com o provedor fora do ar, `search` responde só pelo texto, com `vector: 'unavailable'`.
9. O `context` traz os vizinhos dos `hits` até `depth`, sem repetir `hits`, respeitando o escopo e os status.
10. O benchmark roda para os dois modelos e imprime MRR@10 e recall@5 (total e por grupo de idioma, por perna) e latência p50/p95 em CPU. O resultado e o modelo escolhido pela regra estão registrados neste spec.
11. O `Preset` tem o campo opcional `scope`; o Development Graph declara `{ containment: ['part_of'], usage: ['depends_on'] }`; o core-graph exporta `db`, `entities` e `relations`, e nada mais muda nele.
12. O embeddings só importa `src/core-graph/index.ts` (`pnpm check:arch`), e o `pnpm check:task` passa.

## Perguntas em aberto

Nenhuma bloqueia o plano. Todas são conferidas no build:

1. **Qwen3-Embedding-0.6B:** a dimensão (1024) e o texto exato da instrução de consulta, que as páginas lidas não traziam. Conferir no model card oficial.
2. **Templates do Ollama:** se o Ollama já aplica algum prefixo por conta própria nesses modelos. Um prefixo dobrado ou ausente tornaria a comparação injusta. Conferir com um teste de similaridade.
3. **Truncamento:** como o `/v1/embeddings` do Ollama trata textos acima do contexto. Nos dois modelos, o contexto é muito maior que as entidades típicas.
4. **Tag do Ollama:** a que tiver mais de 1 dia no dia do build (hoje, 0.40.17).
5. **Drizzle:** se o tipo `vector` aceita coluna sem dimensão; se não aceitar, `customType`.
6. **CPU como referência:** a latência é medida em CPU no Docker Desktop local (limitado pelos recursos que o WSL2 dá ao Docker), como aproximação da VPS, que ainda não foi escolhida. Se a VPS for bem mais fraca, o corte de 300 ms é medido de novo lá antes do deploy.

## Resultado do benchmark

Preenchido na fase Build.
