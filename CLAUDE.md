# omnigraph

## Preferências de interação

- Sempre faça perguntas pela ferramenta interativa de perguntas (AskUserQuestion), com opções clicáveis e a opção recomendada primeiro, marcada "(Recommended)". Não peça ao usuário para escrever respostas longas em texto livre.
- Agrupe até 4 perguntas por rodada. Cada pergunta deve fazer sentido sozinha, com o contexto e as trocas de cada opção na descrição.

## Workflow: agent-skills (addyosmani/agent-skills)

O plugin `agent-skills@addy-agent-skills` está instalado no escopo deste projeto (`.claude/settings.json`).
Todo trabalho de desenvolvimento segue o lifecycle abaixo, **em sequência**, invocando cada skill pela ferramenta Skill.

### Lifecycle obrigatório (6 fases)

| # | Fase    | Skill                 | Saída esperada antes de avançar                          |
|---|---------|-----------------------|----------------------------------------------------------|
| 1 | Define  | `agent-skills:spec`   | Especificação escrita e aprovada pelo usuário            |
| 2 | Plan    | `agent-skills:plan`   | Tarefas pequenas com critérios de aceite e dependências  |
| 3 | Build   | `agent-skills:build`  | Implementação incremental, uma fatia por vez             |
| 4 | Verify  | `agent-skills:test`   | Testes passando (TDD; bugs via padrão Prove-It)          |
| 5 | Review  | `agent-skills:review` | Revisão em 5 eixos sem achados críticos em aberto        |
| 6 | Ship    | `agent-skills:ship`   | Checklist de pré-lançamento com decisão go/no-go         |

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
