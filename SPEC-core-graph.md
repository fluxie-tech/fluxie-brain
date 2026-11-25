# Spec: core-graph

Módulo 1 de `CAPABILITY-MAP.md`. Não depende de nenhum outro módulo. Os módulos `embeddings`, `presets`, `mcp-server`, `curation` e `web-ui` dependem dele.

## Objetivo

Ser o armazenamento do grafo de memória do fluxie-brain:
- guarda nós e arestas tipados, separados por *space* (um por tipo de memória);
- valida toda escrita contra a ontologia do space;
- protege o que já foi aprovado contra alterações sem revisão;
- registra cada mudança com o autor e permite desfazer.

**Usuários do módulo:** os outros módulos, por uma API TypeScript. Nenhum agente acessa o banco diretamente; eles passam pelo `mcp-server`.

**Histórias:**
- Como agente, gravo um aprendizado ligado a um projeto. Ele nasce com o status padrão do tipo (normalmente `draft`), e a gravação é recusada se violar a ontologia.
- Como agente, edito uma entidade aprovada: a versão aprovada continua valendo e minha edição vira uma proposta pendente.
- Como curador (humano ou IA), aprovo ou rejeito drafts e propostas, e fica registrado quem decidiu.
- Como dono, vejo o histórico de uma entidade e reverto para uma versão anterior.
- Como agente, a partir de uma entidade obtenho seus vizinhos a até 2 saltos.

**Fora do escopo deste módulo:**
- geração de embeddings e busca híbrida (`embeddings`)
- definição das ontologias reais (`presets`)
- ferramentas MCP e autenticação (`mcp-server`)
- dedupe, contradição e autonomia do curador (`curation`)

## Tech Stack

Regra: sempre a versão estável mais recente, fixada com número exato no `package.json`, no compose e no Dockerfile. As versões são conferidas no dia da implementação. Abaixo, o estado em 25/11/2026:

- **Node.js 26 LTS:** em Active LTS desde out/2026; executa TypeScript nativamente (type stripping). TypeScript strict, ESM.
- **PostgreSQL 19 + pgvector:** o PG19 saiu em 19/11/2026.
  - Usar PG19 só se houver imagem oficial `pgvector/pgvector:pg19` e release estável do pgvector com suporte a ele. Senão, PG18 na última minor, com upgrade planejado depois.
  - Endurecimento em qualquer caso:
    - minor e tag de imagem fixadas;
    - autenticação `scram-sha-256`;
    - a aplicação conecta com um role sem superuser, só com permissões de DML; as migrações usam um role separado;
    - porta do banco não exposta fora da rede do compose;
    - senhas só via `.env`, que fica fora do git.
- **Drizzle ORM + drizzle-kit:** schema em TS, migrações SQL versionadas.
- **Zod:** valida `metadata` contra a ontologia.
- **Vitest:** testes de integração contra o Postgres do docker compose.
- **pnpm** (gerenciador de pacotes) e **Biome** (lint e format).

## Modelo de dados

```
spaces
  id uuid pk · slug text unique · name text · preset text · created_at

entities
  id uuid pk · space_id fk→spaces · type text · key text · title text · content text
  metadata jsonb · status enum(draft|approved|deprecated|rejected) · confidence real (0..1)
  usage_count int · last_used_at timestamptz
  content_hash text GENERATED (md5(title || E'\n' || content))   -- `embeddings` compara para saber o que regenerar
  tsv tsvector GENERATED (to_tsvector('simple', title || ' ' || content))
  version int · created_by text · created_at · updated_at
  unique(space_id, key)

entity_proposals
  id uuid pk · entity_id fk→entities · base_version int · proposed jsonb (title, content, metadata, confidence)
  status enum(pending|accepted|rejected) · proposed_by text · decided_by text null · created_at · decided_at null

relations
  id uuid pk · from_id fk→entities · to_id fk→entities · type text · weight real
  metadata jsonb · created_by text · created_at
  unique(from_id, to_id, type)

change_log
  id bigserial pk · space_id · target_kind enum(entity|relation|proposal) · target_id uuid
  action enum(create|update|status|propose|accept|reject|unlink|revert) · actor text
  before jsonb null · after jsonb null · created_at
```

**Índices deste módulo:**
- `entities(space_id, type, status)`
- `relations(from_id)` e `relations(to_id)`
- `change_log(target_id, created_at)`
- `entity_proposals(entity_id, status)`

Os vetores não ficam em `entities`: o módulo `embeddings` tem tabela própria (entidade, modelo, `source_hash`, vetor) com seus índices, além do GIN em `tsv`. Assim o modelo e a dimensão podem ser trocados sem migrar o núcleo.

**Decisões do modelo:**
- **Ontologia por registro:** core-graph mantém um registro em memória `preset → Ontology`, preenchido por `presets` na inicialização (`registerOntology`). Cada escrita busca a ontologia por `spaces.preset`. Os schemas Zod não são persistidos; quando a web-ui passar a editar tipos, a ontologia vai para o banco em formato serializável, numa mudança planejada nesse momento.
- **Status só via `setStatus` e decisões de proposta:** `upsertEntity` nunca recebe status. Uma entidade nova nasce com o `defaultStatus` do tipo.
- **Upsert conforme o estado atual:**
  - `draft`: aplica direto.
  - `approved`: cria uma proposta `pending` e não altera a entidade.
  - `deprecated` ou `rejected`: aplica e volta para `draft`, porque é conhecimento re-proposto.
- **Proposta desatualizada:** aceitar uma proposta cujo `base_version` difere da versão atual falha com `VersionConflictError`.
- **Chave com outro tipo:** upsert com `key` existente no space mas `type` diferente falha com `OntologyError`. A chave nunca muda de tipo.
- **Separação por space:** `relations` não tem `space_id`; o space vem das pontas. Na v1, relação entre spaces diferentes é recusada. Liberar isso depois, de forma explícita via ontologia, não exige migração.
- **Escopo em toda operação:** toda função pública recebe `spaceId`. Um id de outro space se comporta como inexistente (`NotFoundError`).
- **Embedding desatualizado:** `content_hash` é gerado pelo banco a partir de `title` e `content`. O módulo `embeddings` regenera o vetor quando o hash atual difere do `source_hash` gravado, cobrindo update, aceite de proposta e revert sem nenhuma lógica extra no núcleo.
- **Uso não é edição:** `recordUsage` incrementa `usage_count` e `last_used_at` sem subir `version` e sem gravar no change_log, para não inundar o histórico nem gerar conflitos de versão.
- **Revert:** restaura `title`, `content`, `metadata` e `confidence` para o estado `after` da mudança escolhida.
  - Nunca altera `key`, `type`, space nem `status`. Status é decisão de curadoria e passa por `setStatus`.
  - `version` continua subindo, e o próprio revert entra no change_log.
- **Sem delete físico na v1:** remover uma entidade é mudar o status (`deprecated` ou `rejected`). Remover uma relação é `unlink`, com o estado anterior guardado no change_log.
- **`actor`:** `agent:<nome>` ou `human:<nome>`, o que permite medir a concordância com o curador depois.
- **Atomicidade e concorrência:** toda escrita e sua linha no change_log acontecem na mesma transação. `expectedVersion`, opcional, dá controle de concorrência otimista.
- **Extensão `vector`:** criada numa migração custom (`drizzle-kit generate --custom`), porque o Drizzle não cria extensões.

## Interface (API do módulo)

```ts
type Ontology = {
  entityTypes: Record<string, { metadata: z.ZodType; defaultStatus: 'draft' | 'approved' }>;
  relationTypes: Record<string, { from: string[]; to: string[] }>;
};

registerOntology(preset: string, ontology: Ontology): void
createSpace(input: { slug; name; preset }): Promise<Space>          // falha se o preset não estiver registrado

upsertEntity(spaceId, input: { type; key; title; content; metadata?; confidence?; expectedVersion? }, actor)
  : Promise<{ entity: Entity; proposal?: Proposal }>                 // proposal quando a entidade está approved
getEntity(spaceId, key): Promise<(Entity & { relations: Relation[]; pendingProposals: Proposal[] }) | null>
setStatus(spaceId, entityId, status, actor): Promise<Entity>
recordUsage(spaceId, entityIds: string[]): Promise<void>

listProposals(spaceId, opts?: { status? }): Promise<Proposal[]>
acceptProposal(spaceId, proposalId, actor): Promise<Entity>
rejectProposal(spaceId, proposalId, actor): Promise<Proposal>

linkEntities(spaceId, fromId, toId, type, actor, opts?: { weight?; metadata? }): Promise<Relation>   // idempotente
unlink(spaceId, relationId, actor): Promise<void>
neighbors(spaceId, entityId, depth: 1 | 2, opts?: { relationTypes?; statuses? }): Promise<GraphSlice>

history(spaceId, entityId): Promise<ChangeLogEntry[]>
revertEntity(spaceId, entityId, changeId, actor): Promise<Entity>
```

Erros são tipados (`OntologyError`, `VersionConflictError`, `NotFoundError`) e carregam uma mensagem legível para o agente.

## Comandos

```
docker compose up -d db          # Postgres + pgvector
pnpm install
pnpm db:generate                 # drizzle-kit generate
pnpm db:migrate                  # drizzle-kit migrate
pnpm test                        # vitest run (banco fluxie_brain_test)
pnpm typecheck                   # tsc --noEmit
pnpm lint                        # biome check .
```

## Estrutura do projeto

```
fluxie-brain/                    (pasta local: omnigraph)
  src/core-graph/
    schema.ts        → tabelas Drizzle
    ontology.ts      → tipo Ontology, registro, validação
    entities.ts      → upsertEntity, getEntity, setStatus, recordUsage
    proposals.ts     → listProposals, acceptProposal, rejectProposal
    relations.ts     → linkEntities, unlink, neighbors
    history.ts       → history, revertEntity
    errors.ts
    index.ts         → API pública do módulo
  migrations/        → SQL gerado pelo drizzle-kit (+ custom: create extension vector)
  tests/core-graph/  → testes de integração
  tests/fixtures/    → ontologia e dados fictícios
  docker-compose.yml
  drizzle.config.ts
```

## Estilo de código

```ts
export async function setStatus(spaceId: string, entityId: string, status: EntityStatus, actor: Actor): Promise<Entity> {
  return db.transaction(async (tx) => {
    const before = await findEntityOrThrow(tx, spaceId, entityId);
    const [after] = await tx.update(entities)
      .set({ status, version: before.version + 1, updatedAt: new Date() })
      .where(eq(entities.id, entityId))
      .returning();
    await logChange(tx, { spaceId, kind: 'entity', action: 'status', target: entityId, actor, before, after });
    return after;
  });
}
```

- Funções exportadas, sem classes. Uma transação por operação pública.
- Nomes em inglês no código; documentação em português.
- Sem `any`. Erros tipados, nunca `throw new Error('...')` genérico na API pública.
- SQL cru (`sql```) só onde o Drizzle não alcança. `neighbors` usa busca em largura em TypeScript (2 níveis, conjunto de visitados) em vez de CTE recursiva: com profundidade máxima 2 é mais simples e igualmente correta em ciclos.

## Estratégia de testes

- **Integração:** Vitest contra o banco `fluxie_brain_test` no mesmo container do compose. O `globalSetup` cria o banco e roda as migrações; as tabelas são truncadas entre os testes.
- **Fixture:** uma ontologia fictícia mínima, independente de `presets`. Tipos `project`, `learning` (draft por padrão) e `rule` (approved por padrão); relações `learned_from` e `applies_to`.
- **Unitário:** só para a validação de ontologia (lógica pura).
- **Cobertura:** todas as funções da API pública têm teste do caminho feliz e de pelo menos um caso de erro.

## Fronteiras

- **Sempre:**
  - toda escrita passa pela ontologia e gera linha no change_log, na mesma transação (exceção: `recordUsage`);
  - rodar `pnpm test`, `pnpm typecheck` e `pnpm lint` antes de commit;
  - nas fixtures, só dados fictícios;
  - versões exatas e atuais, conferidas na implementação.
- **Perguntar antes:**
  - mudar o modelo de dados depois da primeira migração aplicada;
  - adicionar dependência;
  - mudar a dimensão do vetor;
  - qualquer delete físico.
- **Nunca:**
  - commitar `.env`, credenciais ou dados reais;
  - escrever no banco fora da API do módulo;
  - deixar um agente mudar status ou alterar entidade aprovada sem passar por proposta;
  - remover ou pular teste falhando para ficar verde.

## Critérios de sucesso

1. `docker compose up -d db && pnpm db:migrate` sobe o banco do zero, com a extensão `vector` ativa.
2. `upsertEntity` com tipo inexistente, `metadata` inválido ou `key` existente com outro `type` falha com `OntologyError` e não grava nada, nem no change_log.
3. Entidade nova nasce com o `defaultStatus` do tipo. Upsert com o mesmo `key` no mesmo space atualiza (sobe `version`) em vez de duplicar. O mesmo `key` em outro space cria uma entidade separada.
4. Upsert numa entidade `approved` não altera a entidade e cria uma proposta `pending`. `acceptProposal` aplica a proposta e `rejectProposal` a descarta; os dois ficam registrados com o `actor`. Aceitar uma proposta desatualizada falha com `VersionConflictError`.
5. Upsert numa entidade `rejected` ou `deprecated` aplica a mudança e a volta para `draft`.
6. Mudança em `title` ou `content` (update, aceite ou revert) altera `content_hash`; mudança só em `metadata` não altera.
7. `linkEntities` recusa relação não permitida pela ontologia e relação entre spaces diferentes; repetir a mesma ligação não duplica.
8. Qualquer função chamada com um id de outro space falha com `NotFoundError`.
9. Toda escrita, exceto `recordUsage`, gera exatamente uma linha no change_log com `actor`, `before` e `after` corretos. `recordUsage` não altera `version` nem o change_log.
10. `revertEntity` restaura `title`, `content`, `metadata` e `confidence`, preserva `key`, `type` e `status`, sobe `version` e aparece no histórico.
11. `upsertEntity` com `expectedVersion` desatualizado falha com `VersionConflictError`.
12. `neighbors(spaceId, id, 2)` retorna vizinhos a 1 e 2 saltos, sem repetição e sem entrar em loop em ciclos.
13. `pnpm test`, `pnpm typecheck` e `pnpm lint` passam.

## Perguntas em aberto

1. **Texto em `tsv`:** usa `'simple'` (sem stemming) porque o conteúdo mistura português e inglês. A qualidade da busca por texto será avaliada no módulo `embeddings`.
2. **Imagem do Postgres:** decidida na implementação pela regra do Tech Stack (PG19 se houver suporte estável; senão, PG18 endurecido).
3. **Modelo de embeddings:** decidido no spec do módulo `embeddings` por teste comparativo entre Qwen3-Embedding-0.6B e EmbeddingGemma 2, servidos pelo Ollama. Não bloqueia este módulo.
