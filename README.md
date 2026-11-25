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

## Licença

MIT
