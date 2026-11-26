# omnigraph

## Preferências de interação

- Sempre faça perguntas pela ferramenta interativa de perguntas (AskUserQuestion), com opções clicáveis e a opção recomendada primeiro, marcada "(Recommended)". Não peça ao usuário para escrever respostas longas em texto livre.
- Agrupe até 4 perguntas por rodada. Cada pergunta deve fazer sentido sozinha, com o contexto e as trocas de cada opção na descrição.

## Qualidade

Leia `CONSTRAINTS.md` antes de escrever código. Não o enfraqueça para uma mudança passar: corrija o código ou registre uma exceção com dono e validade.

- Depois de editar: `pnpm check:fast`.
- Antes de dar uma tarefa por concluída: `pnpm check:task`.
- Na fase Review: `pnpm check:full`.
- O `main` é protegido: todo trabalho vai num branch e entra por pull request, com merge só depois do CI verde. Nunca dê push direto no `main`.

## Workflow: agent-skills (addyosmani/agent-skills)

O plugin `agent-skills@addy-agent-skills` está instalado no escopo deste projeto (`.claude/settings.json`).
Todo trabalho de desenvolvimento segue o lifecycle abaixo, **em sequência**. Cada fase roda no seu subagente, que carrega a skill correspondente (ver **Delegação** no fim deste arquivo).

### Lifecycle obrigatório (6 fases)

| # | Fase    | Skill                 | Executada por                          | Saída esperada antes de avançar                          |
|---|---------|-----------------------|----------------------------------------|----------------------------------------------------------|
| 1 | Define  | `agent-skills:spec`   | `spec-writer`                          | Especificação escrita e aprovada pelo usuário            |
| 2 | Plan    | `agent-skills:plan`   | `planner`                              | Tarefas pequenas com critérios de aceite e dependências  |
| 3 | Build   | `agent-skills:build`  | `builder`                              | Implementação incremental, uma fatia por vez             |
| 4 | Verify  | `agent-skills:test`   | `test-engineer`                        | Testes passando (TDD; bugs via padrão Prove-It)          |
| 5 | Review  | `agent-skills:review` | `code-reviewer`                        | Revisão em 5 eixos sem achados críticos em aberto        |
| 6 | Ship    | `agent-skills:ship`   | orquestrador (fan-out para 3 personas) | Checklist de pré-lançamento com decisão go/no-go         |

Regras:
- Não pular fases nem mudar a ordem. Cada fase termina num **checkpoint humano**: resuma o resultado e aguarde aprovação antes de iniciar a próxima.
- Se uma fase revelar problema de uma fase anterior (ex.: review encontra falha de spec), volte para aquela fase e siga a sequência de novo a partir dela.
- `agent-skills:build auto` só quando o usuário pedir explicitamente; ele não dispensa as fases 4–6.
- Use sempre o nome qualificado `agent-skills:ship` — `/ship` sozinho conflita com o comando nativo do Claude Code (commit/push/PR).
- Mudanças triviais (typo, ajuste de texto, config de uma linha) podem ir direto para Build → Verify, informando o usuário que as demais fases foram puladas.

### Skills opcionais (conforme a tarefa)

Executadas **entre Review (5) e Ship (6)**, somente quando o gatilho se aplicar:

| Skill                        | Quando usar                                                                                               |
|------------------------------|-----------------------------------------------------------------------------------------------------------|
| `agent-skills:code-simplify` | O código ficou complexo, duplicado ou difícil de ler, ou a review apontou problemas de legibilidade/estrutura. Não muda comportamento; rode `agent-skills:test` de novo depois. |
| `agent-skills:webperf`       | A mudança afeta UI web, carregamento, bundle, renderização ou rede (Core Web Vitals). Ignore em backend, CLI ou bibliotecas sem front-end. |

Ao chegar nesse ponto, declare explicitamente se cada skill opcional se aplica ou não, e por quê.

## Delegação: subagentes, modelo e esforço

A sessão principal roda em **opus high** e só **orquestra**. Ela conversa com o usuário e faz as perguntas pelo `AskUserQuestion`, segura os checkpoints, delega cada fase ao subagente da tabela e confere o resultado antes de resumir (por exemplo, roda `pnpm check:task`). Ela não escreve código de produto.

Modelo e esforço das personas e dos agentes de fase ficam no frontmatter de `.claude/agents/*.md`. Ao chamá-los, **não** passe `model` nem `effort`, porque o parâmetro por chamada vence o frontmatter.

| Agente                   | Uso                                                 | Modelo / esforço | Ferramentas            |
|--------------------------|-----------------------------------------------------|------------------|------------------------|
| `spec-writer`            | fase Define                                         | opus / high      | todas                  |
| `planner`                | fase Plan                                           | opus / medium    | todas                  |
| `builder`                | fase Build (commit por fatia, sem push)             | sonnet / medium  | todas                  |
| `test-engineer`          | fase Verify; fan-out do ship                        | sonnet / medium  | todas                  |
| `code-reviewer`          | fase Review; fan-out do ship                        | opus / high      | só leitura + Bash      |
| `security-auditor`       | fan-out do ship                                     | sonnet / high    | só leitura + Bash      |
| `simplifier`             | `agent-skills:code-simplify` (opcional)             | sonnet / medium  | todas                  |
| `Explore` (override)     | busca e localização no repositório                  | haiku / low      | Read, Grep, Glob, Bash |

O Ship fica no orquestrador: ele roda `agent-skills:ship`, que faz o fan-out para `code-reviewer`, `security-auditor` e `test-engineer`, e o merge e a decisão go/no-go também ficam no orquestrador. As personas `web-performance-auditor` e `accessibility-auditor` do plugin usam o padrão do `settings.json`.

Os agentes nativos sem override recebem `model` **e** `effort` explícitos em cada chamada do Agent:

| Agente              | Quando                                                                              | `model` / `effort` |
|---------------------|-------------------------------------------------------------------------------------|--------------------|
| `general-purpose`   | trabalho mecânico com verificação depois (extração, transformação, lote de dados)    | haiku / low        |
| `general-purpose`   | implementação ou pesquisa delimitada fora de uma fase                                | sonnet / medium    |
| `Plan`              | pesquisa para plano                                                                  | sonnet / medium    |
| `web-fetch`         | ler uma página                                                                       | haiku / low        |
| `claude-code-guide` | dúvida sobre o Claude Code                                                           | haiku / low        |

Regras:
- Use sempre o mais barato que resolva. Se a saída falhar na verificação, suba um degrau (haiku → sonnet → opus, low → medium → high) e registre no resumo. Trabalho de juízo (spec, review, decisão de ship) nunca desce da tabela.
- `.claude/settings.json` define `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` e `CLAUDE_CODE_SUBAGENT_EFFORT=medium` como rede de segurança para subagentes sem modelo definido. Não é motivo para omitir o modelo na chamada.
- **Protocolo de perguntas:** subagentes não têm `AskUserQuestion`. Diante de uma decisão do usuário, o subagente para e devolve um bloco `PERGUNTAS` (até 4), cada uma com contexto, 2 a 4 opções com as trocas e a recomendada primeiro, marcada "(Recommended)". O orquestrador pergunta pelo `AskUserQuestion` e devolve as respostas ao **mesmo** agente pelo `SendMessage`, para ele retomar com o contexto intacto.
- Todo subagente segue o `CONSTRAINTS.md` e o lifecycle acima. A delegação não pula fase, checkpoint nem gate.
- Os corpos de `code-reviewer`, `security-auditor` e `test-engineer` são cópias do agent-skills 0.6.18. Ao atualizar o plugin, recopie-os e mantenha o frontmatter.
