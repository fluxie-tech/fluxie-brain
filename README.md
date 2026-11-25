# fluxie-brain

Memória compartilhada em grafo para agentes de IA, que melhora com o uso. Servida via MCP, armazenada em Postgres.

> Em desenvolvimento. Veja `CAPABILITY-MAP.md` para os módulos e `SPEC-core-graph.md` para o módulo atual.

## Requisitos

- Node.js 26+
- pnpm 12+
- Docker (Postgres + pgvector)

## Comandos

```
cp .env.example .env              # e troque cada change-me por senhas fortes
docker compose up -d --wait db    # Postgres + pgvector
pnpm install
pnpm db:migrate                   # aplica migrações no banco de desenvolvimento
pnpm test                         # vitest (migra e usa fluxie_brain_test)
pnpm typecheck                    # tsc --noEmit
pnpm lint                         # biome check
```

## Banco de dados

- **PostgreSQL 19.0 + pgvector 0.8.7** (`pgvector/pgvector:0.8.7-pg19`). O PG19 foi adotado porque a imagem oficial do pgvector com release estável para ele já existia (verificado em 2026-11-25). Fallback: PG18.
- **Roles:** `fluxie_migrator` é dono do schema e roda as migrações; `fluxie_app` só tem DML (sem DDL) e é o usado pela aplicação.
- **Segurança:** autenticação `scram-sha-256` e porta publicada só em `127.0.0.1`. As senhas ficam apenas no `.env`, fora do git.

## Módulo core-graph

API TypeScript em `src/core-graph/index.ts`. Outros módulos usam só esse ponto de entrada.

```ts
import { z } from 'zod';
import { acceptProposal, createSpace, linkEntities, neighbors, registerOntology, upsertEntity } from './src/core-graph/index.ts';

registerOntology('development-graph', {
  entityTypes: {
    project: { metadata: z.object({}), defaultStatus: 'approved' },
    learning: { metadata: z.object({ cause: z.string().optional() }), defaultStatus: 'draft' },
  },
  relationTypes: { learned_from: { from: ['learning'], to: ['project'] } },
});

const space = await createSpace({ slug: 'dev', name: 'Dev graph', preset: 'development-graph' });
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

## Qualidade

As regras estão em `CONSTRAINTS.md` (tamanho, complexidade, arquitetura, cobertura, segurança): `pnpm check:fast`, `pnpm check:task` e `pnpm check:full`. O CI do GitHub roda o equivalente a cada push e PR.

- **Claude Code:** `.claude/settings.json` traz um hook que roda `pnpm check:fast` depois de cada edição feita por um agente. É o mesmo nível de confiança de rodar `pnpm test`; revise-o antes de confiar na pasta.
- **Pré-requisitos locais:** `check:fast` usa o [gitleaks](https://github.com/gitleaks/gitleaks) instalado na máquina, e `check:full` usa Docker para o osv-scanner e o Semgrep.

## Licença

MIT
