# Implementation Plan: embeddings

Spec: `SPEC-embeddings.md`. Mapa: `CAPABILITY-MAP.md`. Tarefas detalhadas: `tasks/todo.md`.
Planos anteriores (concluídos): `tasks/core-graph/` e `tasks/presets/`.

## Visão geral

Criar o módulo `src/embeddings`. Ele mantém vetores das entidades gerados pelo Ollama (CPU, API compatível com a OpenAI) numa tabela própria e oferece a busca híbrida: vetor + texto, fundidos por RRF, com filtro pelo escopo da âncora e vizinhos de contexto. O presets ganha o campo `scope`, e o core-graph passa a exportar `db`, `entities` e `relations`. Um benchmark manual escolhe entre `qwen3-embedding:0.6b` e `embeddinggemma-2:270m` (a `570m` foi trocada pela `270m` no spike, com aprovação do dono).

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
T10 script do benchmark + execução + escolha do modelo   (depende de T8 e T9)
T11 fechamento: rastreabilidade, pendências, check:task
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
- [ ] T2: provedor, catálogo e erros (M)
- [ ] T3: tabela, GIN e exports do core-graph (M)
- [ ] T4: syncEmbeddings (S)

### Checkpoint A: vetores gerados
- [ ] Critérios 1–4 do spec com teste ou verificação manual registrada
- [ ] `pnpm check:task` verde
- [x] Achados do spike revisados pelo dono (2026-11-25: Gemma `270m` no lugar da `570m`; pull no entrypoint)

### Fase 2: Busca
- [ ] T5: busca híbrida sem âncora (M)
- [ ] T6: campo `scope` no presets (XS)
- [ ] T7: filtro pelo escopo da âncora (M)
- [ ] T8: vizinhos de contexto (S)

### Checkpoint B: busca completa
- [ ] Critérios 5–9 e 11 do spec com teste
- [ ] `pnpm check:task` verde

### Fase 3: Benchmark e fechamento
- [ ] T9: fixtures do benchmark e métricas (M)
- [ ] T10: script do benchmark, execução e escolha do modelo (M)
- [ ] T11: fechamento (S)

### Checkpoint C: completo
- [ ] Resultado do benchmark no spec e modelo padrão aprovado pelo dono
- [ ] Os 12 critérios do spec ligados a testes (tabela abaixo, preenchida na T11)
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
| 7 | `vector` sem dimensão | Funciona no pgvector 0.8.7: linhas de 3 e 4 dims convivem, e comparar dimensões diferentes dá `different vector dimensions`. | O filtro `model = $1` vai sempre na mesma consulta da distância |
| 8 | Drizzle | `vector()` exige `dimensions` e gera `vector(N)` | `customType` em `src/embeddings/schema.ts` |
| 9 | `--wait` com serviço de pull | Um serviço de uma execução só conta como pronto enquanto ainda baixa. O `up --wait` voltou com o modelo a 41%. | Plano B aplicado: o pull roda no entrypoint do `ollama`, e o healthcheck só fica verde com o modelo presente (`ollama show`). Um modelo novo levou 46 s até o healthy. Num restart com o modelo no volume, não há pull. O `ollama-pull` saiu do compose. |
| 10 | Memória | Com `KEEP_ALIVE=-1`, todo modelo usado fica carregado: com dois, deu 2,46/3 GB. | `OLLAMA_MAX_LOADED_MODELS=1`. Com um só: Qwen3 1,21 GB, Gemma 270m 0,54 GB |
| 11 | Latência (sonda rápida, não é o benchmark) | Modelo carregado, 30 consultas: Qwen3 p50 191 ms / p95 216 ms; Gemma 270m p50 85 ms / p95 97 ms. Carga a frio: ~1,6–1,8 s. Lote de 32 documentos de ~70 tokens: Qwen3 17,8 s, Gemma 8,2 s. | O Qwen3 fica perto do corte de 300 ms, e um vCPU de VPS costuma ser mais lento |
| 12 | Papel do app | O `fluxie_app` não cria nem tabela temporária, como esperado pelo endurecimento | Nada a mudar |
| 13 | CI | `docker compose up -d --wait db` continua subindo só o banco | O CI não muda |

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

## Perguntas em aberto

- Nenhuma bloqueante. As do spec são fechadas pelo spike da T1.
