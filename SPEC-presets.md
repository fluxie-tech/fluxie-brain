# Spec: presets

Módulo 3 de `CAPABILITY-MAP.md`. Depende só do `core-graph`, pelo `src/core-graph/index.ts`. O `mcp-server` depende dele.

## Objetivo

Definir as ontologias reais do fluxie-brain, uma por tipo de memória. Cada uma diz:
- os tipos de entidade e de relação;
- os campos de metadata de cada tipo;
- a política de aprovação, ou seja, o `defaultStatus` de cada tipo;
- o que cada tipo significa e como um agente deve preenchê-lo.

A v1 entrega só o **Development Graph**, usado como dogfood: o Claude Code registra a memória de desenvolvimento deste repositório.

**Base:** a camada de governança e conhecimento do `dev-graph` do [omnigraph-cookbooks](https://github.com/ModernRelay/omnigraph-cookbooks/tree/main/dev-graph) (MIT), adaptada ao modelo do core-graph.
- **Fica de fora:** a parte de tracker (Issue, Epic, PR, Commit, Release, Deployment, Comment, Label, Gate, Actor, Incident, Capability). O GitHub é a fonte da verdade de código e PRs, tarefas são do preset futuro Agent Work Queue, e autoria já é o `actor` do core-graph.

**Usuários do módulo:**
- o `mcp-server`, que registra os presets na inicialização e descreve os tipos aos agentes;
- o `embeddings`, que reaproveita o corpus fictício no benchmark de modelos.

**Histórias:**
- Como agente, registro que "TS 7 não é suportado pelo dependency-cruiser". Isso vira uma `assumption` ligada à `dependency` `typescript` por `about`, e nasce `draft`.
- Como agente, registro que "o `main` só muda por PR com CI verde". Isso vira um `principle` (`prescribes`) ligado ao `repo` por `applies_to`.
- Como agente, antes de mexer no `core-graph`, peço os vizinhos do `component` e recebo as decisões, regras, invariantes e lições ligadas a ele.
- Como agente, leio a descrição e a instrução de cada tipo para saber qual usar, o que vai no título e no conteúdo e como montar a `key`.
- Como dono, troco uma decisão aprovada sem reescrevê-la: crio uma nova `decision`, ligo `supersedes` e marco a antiga como `deprecated`.

**Fora do escopo deste módulo:**
- os presets Company Brain, Agent Work Queue, Second Brain e Long Memory, sem framework especulativo para eles;
- consultas prontas e ferramentas MCP: o omnigraph tem 57 leituras e 23 escritas prontas, e isso é entrada para o spec do `mcp-server`;
- quem pode aprovar o quê: autorização é do `mcp-server`, curadoria é do `curation`;
- limites de tamanho de texto, que são do `mcp-server`;
- criação de spaces e seed de dados reais.

## Vários projetos, vários tipos de memória, outros apps

O fluxie-brain é um só aplicativo com vários usos. O Development Graph vem primeiro porque serve para construir o próprio fluxie-brain, mas o módulo não pode amarrar o produto a ele.

A separação acontece em três níveis. Cada um é de um módulo, e nenhum exige retrabalho no core-graph.

**1. Space: o cofre isolado (core-graph, já existe).**
- Toda operação exige o `spaceId`, e um id de outro space se comporta como inexistente. Ligação entre spaces é recusada na v1 e, depois, só explícita.
- Um space por "dono de memória":
  - o Second Brain pessoal;
  - o Company Brain da empresa A e, separado, o da empresa B (mesmo preset, spaces diferentes);
  - o Development Graph do dono;
  - um space à parte para cada projeto sigiloso, como os de cliente.

**2. Acesso: quem lê e escreve cada space (`mcp-server`).**
- Um token ou usuário fica vinculado aos spaces que pode usar, numa tabela do próprio `mcp-server` que referencia `spaces.id`.
- Um agente no projeto da empresa A nunca enxerga o Second Brain nem a empresa B.
- É requisito para o spec do `mcp-server`, sem mudança no core-graph.

**3. Relevância: o que vale para o trabalho atual (grafo + busca).**
- Um único space Development Graph guarda todos os repositórios do dono, e quem separa o que é específico do que é comum são as ligações:
  - **Todo conhecimento é ancorado.** `decision`, `principle`, `invariant`, `assumption`, `gap` e `learning` são ligados a pelo menos uma âncora (`repo`, `component` ou `dependency`). A `instruction` de cada tipo exige isso, e o `curation` acusa os órfãos.
  - **Específico fica no projeto; comum é compartilhado pela dependência.**
    - Uma pegadinha do Laravel liga-se a `dependency:composer/laravel`. Um projeto TypeScript, que não depende do Laravel, nunca chega a ela.
    - Uma pegadinha do Postgres, usada pelos dois projetos, aparece nos dois.
  - **As `key`s seguem a mesma lógica.** Levam o repositório onde o item é do projeto (`component:<repo>/<nome>`) e são globais onde é compartilhável (`dependency:<ecossistema>/<nome>`).
- **Requisito para o `embeddings` e o `mcp-server`:** a busca recebe o contexto de trabalho (o repo ou component atual). Ela prioriza ou filtra pela vizinhança dessa âncora, para a busca semântica não trazer conhecimento de outra stack.

**Vários tipos de memória:** cada space escolhe o seu preset.
- Company Brain, Second Brain, Agent Work Queue e Long Memory entram depois como novos arquivos na lista de presets, sem mudar o core-graph nem os presets já existentes.
- Por isso o `id` do preset é um contrato estável, e nenhum tipo genérico (`Preset`, `registerPresets`) conhece o Development Graph.
- Cada preset é autocontido. Tipos parecidos entre presets (uma `decision` no Development Graph e no Company Brain) são definidos em cada um; um código comum entre eles só nasce quando o segundo preset existir.
- **Outros aplicativos:** usam o fluxie-brain pelo `mcp-server`, nunca pelo banco.
  - Um app que precise de um vocabulário próprio, sem mexer no código, depende da ontologia passar para o banco.
  - Essa mudança já está prevista no spec do core-graph e acontece quando a web-ui passar a editar tipos. Fica fora deste módulo.

## Tech Stack

Nenhuma dependência nova. Usa as já fixadas, conferidas em 25/11/2026:
- **Zod 4.6.7**, a última no npm. Fornece `z.strictObject`, `.meta({ description })` e `z.toJSONSchema()`, que o `mcp-server` vai usar para expor os schemas aos agentes.
- Node 26, TypeScript 7.0.2, Vitest 5.1.1 e Biome 2.6.8, como no core-graph.

## Modelo do preset

### Tipos de suporte (`src/presets/types.ts`)

```ts
type EntityTypeDef = {
  description: string;               // o que o tipo é (o @description do omnigraph)
  instruction: string;               // como usar: título, conteúdo, key, quando escolher este tipo (o @instruction)
  defaultStatus: 'draft' | 'approved';
  metadata: z.ZodType;               // z.strictObject; campos com .meta({ description })
};
type RelationTypeDef = { description: string; from: string[]; to: string[] };

type Preset = {
  id: string;                        // persistido em spaces.preset: contrato estável, nunca renomeado
  name: string;
  description: string;
  ontology: { entityTypes: Record<string, EntityTypeDef>; relationTypes: Record<string, RelationTypeDef> };
};
```

`Preset['ontology']` é um superconjunto estrutural do `Ontology` do core-graph e é passado direto ao `registerOntology`. O core-graph não muda, e `tests/core-graph/public-api.test.ts` continua intacto.

### Regras do modelo

- **Texto livre vai em `content`.** A busca por texto (`tsv`) e o embedding (`content_hash`) usam só `title` e `content`. Por isso contexto, consequências, justificativas e alternativas ficam no conteúdo, e a `instruction` do tipo diz como estruturá-lo. O metadata guarda só campos estruturados: enums, referências, versões e caminhos.
- **Metadata estrito.** Todo schema é `z.strictObject`. Chave desconhecida é recusada com `OntologyError` e mensagem legível, e o JSON Schema exportado sai com `additionalProperties: false`.
- **Schemas serializáveis.** Sem `Date`, `transform` nem `refine`, porque o core-graph faz round-trip por JSON e o `mcp-server` converte para JSON Schema. Os nomes de campo são em camelCase, como no omnigraph (`guardRef`, `defaultBranch`).
- **Status: o ciclo de vida é o do core-graph; o estado do domínio vai para o metadata.**
  - O status próprio do omnigraph é mapeado para o do core-graph:
    - `proposed` → `draft`
    - `accepted`/`active` → `approved`
    - `superseded`/`retired` → `deprecated`, mais a aresta `supersedes` quando houver substituto
    - um principle `relaxed` continua `approved`; o afrouxamento fica registrado pela `decision` ligada por `relaxes`
    - rejeitado → `rejected`
  - Vira metadata só o que é fato do domínio, não decisão de curadoria: `state` de `invariant`/`assumption` (`holds|violated`) e de `gap` (`narrowing|widened|closed`).
- **Decisão aprovada não se reescreve.** Editar uma `decision` `approved` já gera proposta no core-graph. A `instruction` orienta o agente a corrigir com uma nova `decision` + `supersedes`, como o ADR do omnigraph.
- **Âncora obrigatória por instrução:** a `instruction` de todo tipo de conhecimento manda ligá-lo a um `repo`, `component` ou `dependency`. Ver "Relevância" acima.
- **Convenção de `key`:** `<tipo>:<slug-kebab>`. Ela é documentada na `instruction` de cada tipo, não validada; o dedupe é papel do `curation`. Exemplos:

  | Tipo | Exemplo de key |
  |---|---|
  | `repo` | `repo:fluxie-tech/fluxie-brain` |
  | `component` | `component:fluxie-brain/core-graph` |
  | `dependency` | `dependency:npm/zod`, `dependency:docker/pgvector` |
  | `spec` | `spec:fluxie-brain/SPEC-core-graph.md` |
  | conhecimento | `decision:postgres-two-roles` (e assim por diante) |

- **Evolução só por adição.** O core-graph valida o metadata na escrita e revalida em `acceptProposal` e `revertEntity`. Por isso mudanças no preset precisam ser compatíveis:
  - pode: campo novo opcional, valor novo em enum, tipo novo, ponta nova numa relação;
  - não pode sem migração planejada: remover, renomear ou apertar (o que é "perguntar antes").
- **Descrições em inglês.** São strings de runtime lidas por agentes, adaptadas do original, e o código fica em inglês. A documentação continua em português.

### Development Graph (`id: 'development-graph'`)

**Entidades.** Origem: o tipo correspondente do omnigraph, ou "nosso" quando é adição deste projeto.

| Tipo | Origem | Status padrão | Metadata (`?` = opcional) | Uso |
|---|---|---|---|---|
| `repo` | Repo | approved | `host?: github\|gitlab\|other`, `ref?` (owner/name), `defaultBranch?`, `visibility?: public\|private` | Repositório |
| `component` | Component | approved | `path?` (ex.: `src/core-graph`), `criticality?: low\|medium\|high\|critical` | Módulo ou pacote |
| `dependency` | nosso | approved | `ecosystem: language\|npm\|pypi\|composer\|cargo\|go\|maven\|nuget\|gem\|docker\|service\|tool\|other`, `version?` | Linguagem, lib, imagem, serviço ou ferramenta de que um projeto depende. Ex.: `dependency:language/php`, `dependency:npm/react` |
| `spec` | SpecFile | approved | `location` (caminho no repo ou URL) | Documento de design (`SPEC-*.md`) |
| `decision` | Decision | draft | — (objeto vazio estrito) | ADR. Conteúdo: contexto, decisão, consequências, alternativas |
| `principle` | Principle | draft | `polarity: prescribes\|forbids` | Regra de trabalho. Conteúdo: justificativa e, se `forbids`, a alternativa correta |
| `invariant` | Invariant | draft | `state: holds\|violated`, `guardRef?` (teste ou check) | Propriedade interna checável; violação é bug |
| `assumption` | Assumption | draft | `kind: compile\|runtime\|manual`, `state: holds\|violated`, `guardRef?` | Crença sobre o comportamento de um sistema **externo** |
| `gap` | Gap (+ ExternalBlocker) | draft | `state: narrowing\|widened\|closed`, `upstreamUrl?`, `pinnedVersion?`, `shippedInVersion?` | Dívida técnica: invariante desejado ainda não garantido, ou trava que espera correção upstream. Conteúdo: comportamento atual × alvo e contorno |
| `learning` | Learning | draft | `kind: gotcha\|hindsight\|retro\|incident_review` | Lição aprendida |

**Relações** (verbos genéricos; o core-graph valida `from × to`):

| Relação | De | Para | Origem no omnigraph |
|---|---|---|---|
| `part_of` | component | repo, component | RepoHasComponent, ComponentHasSubcomponent (invertidas) |
| `depends_on` | repo, component | component, dependency | ComponentDependsOn (+ repo: ferramentas do repositório, como pnpm e TypeScript) |
| `describes` | spec | repo, component | SpecDescribes |
| `applies_to` | decision, principle | repo, component, dependency, spec | DecisionAppliesTo* (+ dependency: regra ou decisão sobre uma dependência compartilhada) |
| `establishes` | decision | principle, invariant | DecisionEstablishes* |
| `relaxes` | decision | principle, invariant | DecisionRelaxes* |
| `supersedes` | decision, spec, principle | decision, spec, principle | *Supersedes |
| `about` | learning, invariant, assumption, gap | repo, component, dependency | LearningAbout*, InvariantAboutComponent, AssumptionAboutComponent |
| `references` | learning, spec | decision, spec | LearningReferencesDecision, SpecReferences |
| `undermines` | gap | invariant | GapUnderminesInvariant |
| `waits_for` | gap | dependency | ExternalBlocker (dívida à espera de correção upstream) |
| `relates_to` | todos | todos | IssueRelated (válvula de escape) |

**A memória atual do projeto cabe no modelo:**

| Memória de hoje | Tipo e ligação |
|---|---|
| "TS 7 não roda com o dependency-cruiser; usar parser swc" | `assumption` (`compile`, `violated`) `about` → `dependency:npm/dependency-cruiser` |
| "confidence é float32; comparar com `Math.fround`" | `invariant` com `guardRef` `about` → `component:fluxie-brain/core-graph` |
| "Postgres com dois roles" | `decision` `applies_to` → `repo` |
| "main só por PR com CI verde" | `principle` (`prescribes`) `applies_to` → `repo` |
| exceção E1 (esbuild via drizzle-kit) | `gap` `waits_for` → `dependency:npm/drizzle-kit` |
| "pnpm 12 bloqueia build scripts" | `learning` (`gotcha`) `about` → `dependency:npm/pnpm` |

## Interface (API do módulo)

```ts
export const DEVELOPMENT_GRAPH = 'development-graph';
export const developmentGraph: Preset;

registerPresets(): void                  // chama registerOntology para cada preset; idempotente (o registro sobrescreve)
listPresets(): readonly Preset[]
getPreset(id: string): Preset | undefined
export type { Preset, EntityTypeDef, RelationTypeDef }
```

- O registro é explícito, por chamada na inicialização. Importar o módulo não tem efeito colateral.
- `getPreset` devolve `undefined` em vez de lançar erro, porque quem trata id desconhecido é o chamador (`createSpace` do core-graph já lança `OntologyError`).

## Corpus fictício (`tests/fixtures/development-graph/corpus.json`)

- **Volume e idioma:** pelo menos 30 entidades sobre um projeto inventado (nome e todo o conteúdo fictícios; nada de dados reais), com pelo menos 12 em PT e 12 em EN.
- **Cobertura:** pelo menos uma entidade de cada tipo e uma relação de cada tipo.
- **Dois projetos fictícios no mesmo space, com stacks diferentes** (ex.: um em TypeScript/React e outro em PHP/Laravel):
  - cada um tem conhecimento específico da sua stack;
  - os dois compartilham ao menos uma `dependency` (ex.: Postgres) com uma `learning` sobre ela.
- **Formato:**

  ```json
  { "entities": [{ "lang": "pt", "project": "quarry", "type": "...", "key": "...", "title": "...", "content": "...", "metadata": {} }],
    "relations": [{ "from": "<key>", "to": "<key>", "type": "..." }] }
  ```

  `lang` e `project` (projeto fictício ou `shared`) são anotações do corpus e não vão para o banco. O `embeddings` acrescenta depois as consultas e os resultados esperados do benchmark.
- **Carga nos testes:** um helper em `tests/fixtures/development-graph/load.ts` carrega o corpus num space pelo core-graph real.

## Comandos

```
docker compose up -d --wait db   # Postgres de teste
pnpm test tests/presets          # testes do módulo
pnpm check:fast                  # tipos, lint, segredos, floor-guard (roda após cada edição pelo hook)
pnpm check:task                  # + arquitetura, testes com cobertura e cobertura das linhas alteradas
```

## Estrutura do projeto

```
src/presets/
  types.ts               → Preset, EntityTypeDef, RelationTypeDef
  development-graph/index.ts      → o preset (cabeçalho com origem e copyright MIT do omnigraph-cookbooks)
  development-graph/entities.ts   → tipos de entidade · development-graph/relations.ts → relações
  index.ts               → registerPresets, listPresets, getPreset, DEVELOPMENT_GRAPH, tipos
tests/presets/
  development-graph.test.ts   → unitário: coerência da ontologia, schemas, JSON Schema
  integration.test.ts         → cada grupo de tipos e relações pelo core-graph real
  corpus.test.ts              → corpus inteiro: cobertura, âncoras, separação por stack
  edge-cases.test.ts          → campos exatos do spec, campo obrigatório ausente, proposta, prova de mutação
  public-api.test.ts          → superfície pública fixada
tests/fixtures/development-graph/
  corpus.json, load.ts
README.md                → linha de créditos ao omnigraph-cookbooks
```

`.dependency-cruiser.cjs` já permite `presets → core-graph`, e só via `index.ts`.

## Estilo de código

```ts
export const developmentGraph = {
  id: DEVELOPMENT_GRAPH,
  name: 'Development Graph',
  description: 'Decisions, rules and lessons behind a codebase, linked to its repos, components and dependencies.',
  ontology: {
    entityTypes: {
      principle: {
        description: 'Prescriptive working rule. Violation = rejected change.',
        instruction:
          'Title: the rule as one imperative sentence. Content: why it exists and, for forbids, the correct alternative. ' +
          'Key: principle:<kebab-slug>. Link it with applies_to to the repo/component/spec it governs.',
        defaultStatus: 'draft',
        metadata: z.strictObject({
          polarity: z.enum(['prescribes', 'forbids']).meta({ description: 'prescribes = always do; forbids = never do' }),
        }),
      },
      // ...
    },
    relationTypes: {
      applies_to: { description: 'Scope a decision or principle governs.', from: ['decision', 'principle'], to: ['repo', 'component', 'spec'] },
      // ...
    },
  },
} satisfies Preset;
```

- Objetos literais com `satisfies Preset`, sem classes nem builders.
- Funções exportadas, sem estado além do registro do core-graph.
- Nada de `any` nem `!`. Os limites do `CONSTRAINTS.md` valem: função ≤ 50 linhas e arquivo ≤ 300 linhas.

## Estratégia de testes

**Unitário** (lógica pura, sem banco):
- coerência: toda ponta de relação existe em `entityTypes`, e todo tipo e toda relação têm `description` não vazia;
- cada tipo de entidade tem `instruction`, e ela cita o prefixo de `key` do tipo;
- cada schema de metadata aceita o exemplo válido do corpus e recusa uma chave desconhecida; os que têm enum também recusam um valor fora dele;
- `z.toJSONSchema()` converte todos os schemas sem erro, com `additionalProperties: false`.

**Integração** (Postgres do compose, como no core-graph):
- `registerPresets()` + `createSpace({ preset: 'development-graph' })`;
- carga do corpus inteiro: toda entidade nasce com o `defaultStatus` do tipo e toda relação é aceita;
- um caso inválido por regra chega ao core-graph como `OntologyError`, sem nada gravado: tipo fora do preset, metadata com chave extra e relação fora de `from × to`.

**API pública:** `public-api.test.ts` fixa os exports.

**Cobertura:** a régua do `CONSTRAINTS.md` (≥ 80% das linhas alteradas, ratchet global sem queda).

## Fronteiras

- **Sempre:**
  - todo schema `strictObject` e serializável;
  - toda descrição e instrução preenchida;
  - presets só importam `core-graph/index.ts`;
  - fixtures 100% fictícias;
  - crédito ao omnigraph-cookbooks no cabeçalho do arquivo e no README;
  - trabalho em branch, entrando por PR com CI verde;
  - commits com o e-mail noreply.
- **Perguntar antes:**
  - mudar o `id` de um preset;
  - remover, renomear ou apertar um tipo, campo ou relação depois de haver dados;
  - mudar a API do core-graph;
  - adicionar dependência;
  - adicionar outro preset.
- **Nunca:**
  - enfraquecer o `CONSTRAINTS.md`;
  - dados reais no corpus;
  - estado de curadoria duplicado no metadata (o ciclo de vida é o status do core-graph);
  - texto livre longo em metadata, onde a busca não alcança.

## Critérios de sucesso

1. `registerPresets()` registra o Development Graph, e `createSpace` com `preset: 'development-graph'` funciona. Chamar duas vezes não tem efeito diferente.
2. As 10 entidades e as 12 relações das tabelas acima existem com o `defaultStatus` e os campos indicados, e toda ponta de relação é um tipo existente.
3. Todo tipo e toda relação têm `description`. Todo tipo tem `instruction` com a convenção de `key`.
4. Todo schema de metadata é estrito, converte com `z.toJSONSchema()` e recusa chave desconhecida com `OntologyError` legível ao passar pelo core-graph.
5. O corpus (≥ 30 entidades, ≥ 12 em PT e ≥ 12 em EN, todos os tipos e relações, dois repositórios no mesmo space) carrega inteiro pelo core-graph real.
   - O status de cada entidade é o `defaultStatus` do tipo.
   - Os vizinhos a 2 saltos do repositório A incluem a `learning` da dependência compartilhada e **não** incluem nenhum conhecimento específico da stack do repositório B, e vice-versa.
   - Toda entidade de conhecimento do corpus está ligada a pelo menos uma âncora.
6. Relação fora de `from × to` e tipo fora do preset são recusados com `OntologyError`, sem escrita.
7. `presets` importa só `core-graph/index.ts`, e `pnpm check:arch` passa.
8. A API pública é fixada por teste. O core-graph não muda.
9. O README e o cabeçalho do preset creditam o omnigraph-cookbooks (MIT), com link e aviso de copyright.
10. `pnpm check:task` passa.

## Perguntas em aberto

1. **`supersedes` entre tipos diferentes.** O core-graph valida `from × to`, então `decision supersedes spec` passaria. Fica aceito na v1, com a `instruction` pedindo o mesmo tipo dos dois lados. Se der problema, o caminho é uma regra opcional "mesmo tipo" na ontologia do core-graph (mudança de API, então perguntar antes).
2. **Ambiguidade invariant × assumption × learning.** As `instruction`s precisam deixar claro quando usar cada um: interno e checável → `invariant`; externo → `assumption`; lição sem garantia checável → `learning`. A qualidade disso só aparece no dogfood do `agent-loop`.
