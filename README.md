# fluxie-brain

Memória compartilhada em grafo para agentes de IA, que melhora com o uso. Servida via MCP, armazenada em Postgres.

> Em desenvolvimento. Veja `CAPABILITY-MAP.md` para os módulos e os `SPEC-<módulo>.md` de cada um (`SPEC-core-graph.md`, `SPEC-presets.md`).

## Requisitos

- Node.js 26+
- pnpm 12+
- Docker (Postgres + pgvector + pg_textsearch, e o Ollama para os embeddings)

## Comandos

```
cp .env.example .env              # e troque cada change-me por senhas fortes
docker compose up -d --wait db    # Postgres + pgvector + pg_textsearch (imagem própria, reconstruída se mudar)
pnpm install
pnpm db:migrate                   # aplica migrações no banco de desenvolvimento
pnpm test                         # vitest (migra e usa fluxie_brain_test)
pnpm typecheck                    # tsc --noEmit
pnpm lint                         # biome check
```

## Banco de dados

- **PostgreSQL 19.0 + pgvector 0.8.7 + pg_textsearch 1.6.0** (imagem própria em `docker/db/Dockerfile`, a partir de `pgvector/pgvector:0.8.7-pg19`). O PG19 foi adotado porque a imagem oficial do pgvector com release estável para ele já existia (verificado em 2026-11-25). Fallback: PG18.
- **Roles:** `fluxie_migrator` é dono do schema e roda as migrações; `fluxie_app` só tem DML (sem DDL) e é o usado pela aplicação.
- **Segurança:** autenticação `scram-sha-256` e porta publicada só em `127.0.0.1`. As senhas ficam apenas no `.env`, fora do git.

## Módulo core-graph

API TypeScript em `src/core-graph/index.ts`. Outros módulos usam só esse ponto de entrada.

```ts
import { z } from 'zod';
import { acceptProposal, createSpace, linkEntities, neighbors, registerOntology, upsertEntity } from './src/core-graph/index.ts';

registerOntology('my-preset', {
  entityTypes: {
    project: { metadata: z.object({}), defaultStatus: 'approved' },
    learning: { metadata: z.object({ cause: z.string().optional() }), defaultStatus: 'draft' },
  },
  relationTypes: { learned_from: { from: ['learning'], to: ['project'] } },
});

const space = await createSpace({ slug: 'dev', name: 'Dev graph', preset: 'my-preset' });
const { entity: project } = await upsertEntity(space.id, { type: 'project', key: 'fluxie', title: 'fluxie-brain', content: '' }, 'human:owner');
const { entity: learning } = await upsertEntity(space.id, { type: 'learning', key: 'rrf', title: 'Use RRF', content: '...' }, 'agent:claude-code');
await linkEntities(space.id, { fromId: learning.id, toId: project.id, type: 'learned_from' }, 'agent:claude-code');
const slice = await neighbors(space.id, project.id, 2);
```

**Regras principais:**
- **Status:** entidades nascem com o status padrão do tipo e só mudam de status via `setStatus`.
- **Proposta:** editar uma entidade `approved` cria uma proposta pendente, que é aplicada por `acceptProposal` ou descartada por `rejectProposal`.
- **Histórico:** toda escrita fica no `change_log` com o `actor`, e `revertEntity` restaura o conteúdo a partir dele.
- **Isolamento:** ids de outro space se comportam como inexistentes.

## Módulo presets

Ontologias prontas por tipo de memória, em `src/presets/index.ts`. Cada space escolhe o seu preset. A v1 traz o **Development Graph** (`development-graph`): decisões, regras, invariantes, suposições sobre sistemas externos, dívidas e lições, ancorados a repositórios, componentes e dependências.

```ts
import { createSpace } from './src/core-graph/index.ts';
import { DEVELOPMENT_GRAPH, getPreset, registerPresets } from './src/presets/index.ts';

registerPresets(); // uma vez na inicialização
const space = await createSpace({ slug: 'dev', name: 'Dev graph', preset: DEVELOPMENT_GRAPH });
const preset = getPreset(DEVELOPMENT_GRAPH); // descrições, instruções e schemas Zod para os agentes
```

Um space pode guardar vários repositórios: conhecimento específico de uma stack fica ligado às âncoras dela, e o comum é alcançado pelas dependências compartilhadas. Detalhes em `SPEC-presets.md`.

## Módulo embeddings

Busca híbrida por significado e por palavra, em `src/embeddings/index.ts`: vetores (pgvector), texto BM25 (pg_textsearch) e grafo, fundidos por formato de consulta. Detalhes, benchmark e emendas em `SPEC-embeddings.md`.

```ts
import { search, syncEmbeddings } from './src/embeddings/index.ts';

await syncEmbeddings(space.id); // gera os vetores que faltam: { embedded, remaining, failed }
const { hits, context, vector } = await search(space.id, 'como o cache expira?', { limit: 10, depth: 1 });
// vector === 'unavailable': a perna vetorial não contribuiu (provedor fora do ar, timeout, modelo sem vetores); só texto
```

- **Banco:** o `db` usa uma imagem própria (`docker/db/Dockerfile`: PG19 + pgvector + pg_textsearch). Depois de atualizar o repositório, reconstrua e suba com `docker compose up -d --wait db`.
- **Ollama no compose:** o serviço `ollama` (só CPU, porta 11434 em `127.0.0.1`) baixa o modelo na primeira subida. O modelo vem de `OLLAMA_MODEL`, ou de `EMBEDDINGS_MODEL` se aquela faltar (padrão: EmbeddingGemma 2 270M). `docker compose up -d --wait` sobe tudo e espera o modelo.
- **Provedor:** qualquer API compatível com OpenAI em `EMBEDDINGS_BASE_URL`, com `EMBEDDINGS_API_KEY` opcional (recusada com `http:` fora de loopback). Veja `.env.example`.
- **Atualizar um `pgdata` antigo** (criado antes do `pg_textsearch`): reconstrua a imagem, recrie o contêiner e rode `CREATE EXTENSION IF NOT EXISTS pg_textsearch;` como `postgres` em cada banco, porque exige superusuário. O comentário de `migrations/0008_entities_bm25.sql` tem o passo a passo.
- **Nunca rode `docker compose down -v`:** o `-v` apaga os volumes, inclusive o do Ollama (o modelo baixado) e o do banco. Use `docker compose down` sem `-v`.
- **Benchmarks e dogfooding** (manuais, com o Ollama no ar; escrevem no banco de teste): `pnpm bench:embeddings` compara os modelos, `pnpm bench:fusion` calibra a fusão, `pnpm dogfood:prepare` (exige `DOGFOOD_SOURCE`) e `pnpm dogfood:build` montam o dataset. Num provedor remoto, os benchmarks só seguem com `--yes`.

## Qualidade

As regras estão em `CONSTRAINTS.md` (tamanho, complexidade, arquitetura, cobertura, segurança): `pnpm check:fast`, `pnpm check:task` e `pnpm check:full`. O CI do GitHub roda o equivalente a cada push e PR.

- **Claude Code:** `.claude/settings.json` traz um hook que roda `pnpm check:fast` depois de cada edição feita por um agente. É o mesmo nível de confiança de rodar `pnpm test`; revise-o antes de confiar na pasta.
- **Pré-requisitos locais:** `check:fast` usa o [gitleaks](https://github.com/gitleaks/gitleaks) instalado na máquina, e `check:full` usa Docker para o osv-scanner e o Semgrep.

## Licença

MIT

## Créditos

O preset Development Graph adapta a camada de governança e conhecimento do schema `dev-graph` do [omnigraph-cookbooks](https://github.com/ModernRelay/omnigraph-cookbooks/tree/main/dev-graph) (MIT License, Copyright (c) 2026 ModernRelay).
