# Tarefas: presets

Plano: `tasks/presets/plan.md` · Spec: `SPEC-presets.md`.

**Definição de pronto para toda tarefa:**
- `pnpm check:fast` verde depois de cada edição (o hook roda);
- `pnpm check:task` verde antes de marcar a tarefa, com o banco no ar (`docker compose up -d --wait db`);
- um commit por tarefa no branch `spec/presets`, com o e-mail noreply;
- nada no `CONSTRAINTS.md` enfraquecido.

## Fase 1: Base

### T1: tipos genéricos, registro e tipos estruturais

**Descrição:** cria o módulo `src/presets` com:
- `Preset`, `EntityTypeDef` e `RelationTypeDef`;
- `DEVELOPMENT_GRAPH`, `developmentGraph`, `registerPresets()`, `listPresets()` e `getPreset(id)`;
- o Development Graph só com os tipos estruturais (`repo`, `component`, `dependency`, `spec`), todos `approved`, e as relações cujas pontas já existem (`part_of`, `depends_on`, `describes`, `relates_to` entre estruturais).

Cada tipo tem `description`, `instruction` (com a convenção de key) e schema `z.strictObject` com `.meta({ description })` nos campos. O cabeçalho do arquivo credita o omnigraph-cookbooks (MIT, link e copyright).

**Critérios de aceite:**
- [x] `developmentGraph.ontology` é passado a `registerOntology` sem cast, e o `typecheck` passa. É o risco principal: se falhar, parar e perguntar.
- [x] Teste unitário de coerência:
  - toda ponta de relação existe;
  - toda `description` está preenchida;
  - toda `instruction` cita o prefixo `<tipo>:`;
  - todo schema converte com `z.toJSONSchema()` com `additionalProperties: false`;
  - todo schema recusa chave desconhecida, e os com enum recusam valor fora dele.
- [x] Integração:
  - `registerPresets()` (duas vezes, sem efeito diferente) + `createSpace({ preset: 'development-graph' })`;
  - um `repo`, um `component` e uma `dependency` nascem `approved`;
  - `part_of` e `depends_on` são aceitas;
  - tipo fora do preset e `metadata` com chave extra falham com `OntologyError`, sem linha em `entities` nem em `change_log`.

**Verificação:** `pnpm test tests/presets` · `pnpm check:task` (inclui `check:arch`: presets → só `core-graph/index.ts`).

**Dependências:** nenhuma.

**Arquivos:** `src/presets/types.ts`, `src/presets/development-graph.ts`, `src/presets/index.ts`, `tests/presets/development-graph.test.ts`, `tests/presets/integration.test.ts`.

**Feito:** `tests/presets/public-api.test.ts` foi antecipado da T5, porque o ratchet de cobertura exige teste para `listPresets` e `getPreset`.

**Escopo:** M (5 arquivos pequenos).

## Fase 2: Ontologia completa

### T2: decision, principle e invariant

**Descrição:** acrescenta os tipos de governança interna, todos `draft`:
- `decision`: metadata vazio estrito; a instrução pede contexto, decisão, consequências e alternativas no `content`, e manda corrigir com nova decision + `supersedes` em vez de editar uma aprovada;
- `principle`: `polarity`;
- `invariant`: `state`, `guardRef?`.

Também acrescenta as relações `applies_to`, `establishes`, `relaxes` e `supersedes`. As instruções exigem âncora (`repo`, `component` ou `dependency`).

**Critérios de aceite:**
- [x] Os testes de coerência da T1 cobrem os novos tipos sem mudança no teste: ele percorre a ontologia.
- [x] Integração: os três nascem `draft`; `applies_to`, `establishes`, `relaxes` e `supersedes` são aceitas entre as pontas do spec, e `establishes` de `principle` para `repo` é recusada.
- [x] Exemplo válido e inválido por tipo; `polarity` e `state` fora do enum são recusados.

**Verificação:** `pnpm test tests/presets` · `pnpm check:task`.

**Dependências:** T1.

**Arquivos:** `src/presets/development-graph.ts`, `tests/presets/development-graph.test.ts`, `tests/presets/integration.test.ts`.

**Escopo:** S.

### T3: assumption, gap e learning (ontologia completa)

**Descrição:** acrescenta os tipos restantes, todos `draft`:
- `assumption`: `kind`, `state`, `guardRef?`;
- `gap`: `state`, `upstreamUrl?`, `pinnedVersion?`, `shippedInVersion?`;
- `learning`: `kind`.

Também acrescenta as relações `about`, `references`, `undermines` e `waits_for`, e estende `relates_to` a todos os tipos. As instruções de `invariant`, `assumption` e `learning` trazem o critério de escolha:
- interno e checável → `invariant`;
- sistema externo → `assumption`;
- lição sem garantia checável → `learning`.

Se o arquivo passar de 300 linhas, divide em `src/presets/development-graph/{index,entities,relations}.ts`.

**Critérios de aceite:**
- [x] A ontologia bate com o spec: 10 tipos e 12 relações com as pontas da tabela. Um teste confere os nomes e o `defaultStatus` de cada tipo contra a lista do spec.
- [x] Integração: os três nascem `draft`; `about`, `references`, `undermines` e `waits_for` são aceitas, e uma relação fora de `from × to` falha com `OntologyError` sem escrita.
- [x] Nenhum arquivo de `src` passa de 300 linhas.

**Verificação:** `pnpm test tests/presets` · `pnpm check:task`.

**Dependências:** T2.

**Arquivos:** `src/presets/development-graph.ts` (ou a pasta dividida), `tests/presets/development-graph.test.ts`, `tests/presets/integration.test.ts`.

**Escopo:** M.

## Checkpoint A: ontologia completa

- [x] 10 tipos e 12 relações, coerentes, com descrição e instrução.
- [x] `pnpm check:task` verde.
- [x] **Revisão humana** das descrições e instruções (aprovada pelo dono em 2026-11-25, após o build auto).

## Fase 3: Corpus e fechamento

### T4: corpus fictício PT/EN e prova multiprojeto

**Descrição:** escreve `tests/fixtures/development-graph/corpus.json`, com 30 ou mais entidades fictícias (12 ou mais em PT, 12 ou mais em EN, campo `lang`) e relações por `key`:
- dois repositórios com stacks diferentes (ex.: TypeScript/React e PHP/Laravel) no mesmo space;
- conhecimento específico de cada stack;
- uma `dependency` compartilhada (ex.: Postgres) com uma `learning` sobre ela;
- todo tipo e toda relação aparecem ao menos uma vez.

O helper `load.ts` carrega o corpus num space pelo core-graph e devolve um mapa `key → Entity`.

**Critérios de aceite:**
- [x] O corpus carrega inteiro sem erro, e cada entidade tem o `defaultStatus` do seu tipo.
- [x] `neighbors(repoA, 2)` inclui a `learning` da dependência compartilhada e não inclui conhecimento específico da stack do B (e vice-versa).
- [x] Toda entidade de conhecimento do corpus tem ao menos uma ligação a `repo`, `component` ou `dependency`. Um teste confere, e confere também a cobertura de tipos, relações e idiomas.

**Verificação:** `pnpm test tests/presets` · `pnpm check:task` · revisão manual de que nenhum nome ou dado do corpus é real.

**Dependências:** T3.

**Arquivos:** `tests/fixtures/development-graph/corpus.json`, `tests/fixtures/development-graph/load.ts`, `tests/presets/corpus.test.ts`.

**Escopo:** M (o volume está no conteúdo do JSON, não no código).

### T5: API pública, créditos e rastreabilidade

**Descrição:** fecha o módulo. Fixa a superfície pública por teste e adiciona a linha de créditos ao omnigraph-cookbooks no README. Preenche a tabela de rastreabilidade em `tasks/presets/plan.md` e confere que o core-graph não mudou.

**Critérios de aceite:**
- [x] `public-api.test.ts` fixa os exports: `DEVELOPMENT_GRAPH`, `developmentGraph`, `registerPresets`, `listPresets`, `getPreset`. Testa também `getPreset('x')` → `undefined` e que `listPresets()` contém o Development Graph.
- [x] O README credita o omnigraph-cookbooks (MIT, link).
- [x] `git diff main -- src/core-graph tests/core-graph` vazio.
- [x] A tabela de rastreabilidade liga os 10 critérios do spec a testes.

**Verificação:** `pnpm check:task`.

**Dependências:** T4.

**Arquivos:** `tests/presets/public-api.test.ts`, `README.md`, `tasks/presets/plan.md`.

**Escopo:** S.

## Checkpoint B: completo

- [x] Os 10 critérios do spec ligados a testes que passam.
- [x] `pnpm check:task` verde.
- [x] Resumo para o dono e aprovação antes da fase 4 do lifecycle (Verify).
