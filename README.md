# fluxie-brain

Memória compartilhada em grafo para agentes de IA, que melhora com o uso. Servida via MCP, armazenada em Postgres.

> Em desenvolvimento. Veja `CAPABILITY-MAP.md` para os módulos e `SPEC-core-graph.md` para o módulo atual.

## Requisitos

- Node.js 26+
- pnpm 12+
- Docker (Postgres + pgvector)

## Comandos

```
pnpm install
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome check
```

## Licença

MIT
