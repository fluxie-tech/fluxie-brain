# Constraints

Last reviewed: 2026-11-25 by the owner (escolhas via entrevista: padrão de mercado, bloquear, 80% nas linhas alteradas + ratchet).

Este arquivo é a régua de qualidade do fluxie-brain. Toda checagem **bloqueia**: falhou, corrige-se o código antes de seguir. **Nunca** se enfraquece este arquivo, nem as configs que ele aponta, para uma mudança passar. Afrouxar uma regra exige uma linha na tabela de exceções, com dono e validade.

## Floor (sempre, sem configuração)

- Nenhum comentário de supressão novo: `@ts-ignore`, `@ts-nocheck`, `biome-ignore`, `eslint-disable`, `istanbul ignore`, `nosemgrep`, `gitleaks:allow`.
- Nenhum stub inacabado: `throw new Error('not implemented')`, `catch {}` vazio, `TODO` no lugar da implementação.
- Nenhum teste pulado (`.skip`, `.todo`), apagado ou com asserções a menos sem motivo na mensagem do commit.
- Nenhum segredo no código; senhas só no `.env`, que fica fora do git.
- Este arquivo não é enfraquecido para uma mudança passar.

Verificado por `node scripts/floor-guard.mjs [--base <ref>]`, que olha só o diff (padrão: trabalho não commitado). Caminhos isentos ficam em `.constraintsignore`, com motivo. O guard também acusa piso de cobertura baixado ou removido no `vitest.config.ts` e qualquer entrada nova no `.constraintsignore`, que precisa passar pela tabela de exceções.

## Enforced with numbers

| Dimensão | Regra | Por quê | Verificado por | Roda em |
|---|---|---|---|---|
| Tipos | Zero erros de tipo (strict, `noUncheckedIndexedAccess`) | Erros de tipo são bugs encontrados de graça | `tsc --noEmit` | edição |
| Lint | Zero erros nas regras recomendadas do Biome; `noExplicitAny` e `noNonNullAssertion` como erro | `any` e `!` desligam o typecheck justamente onde ele mais importa | `biome check .` | edição |
| Complexidade | Complexidade cognitiva ≤ 15 por função | Default do SonarQube; acima disso a função deixa de caber na cabeça de quem lê | `biome check .` (`noExcessiveCognitiveComplexity`) | edição |
| Tamanho de função | ≤ 50 linhas por função (fora de testes) | Default de mercado (ESLint/Biome); força uma responsabilidade por função | `biome check .` (`noExcessiveLinesPerFunction`) | edição |
| Tamanho de arquivo | ≤ 300 linhas em `src` e `scripts`; ≤ 400 em `tests` | Default do ESLint `max-lines`; testes DAMP repetem setup de propósito | `biome check .` (`noExcessiveLinesPerFile`) | edição |
| Parâmetros | ≤ 4 parâmetros por função | Mais que isso pede um objeto nomeado; evita argumentos trocados | `biome check .` (`useMaxParams`) | edição |
| Segredos | Nenhum vazamento no diff de trabalho | Um segredo commitado vaza para sempre no histórico | `gitleaks git --pre-commit --redact --no-banner` | edição |
| Arquitetura | Sem import circular; módulos só se importam pelo `index.ts`; dependências só na direção do `CAPABILITY-MAP.md`; `src` não importa devDependencies | Ciclos e atalhos entre módulos são a erosão que nenhum teste pega | `depcruise --validate .dependency-cruiser.cjs src` | fim de tarefa |
| Cobertura de código novo | ≥ 80% das linhas alteradas em `src` cobertas | Alto o bastante para forçar um teste, baixo o bastante para linhas de config | `vitest run --coverage` + `node scripts/changed-coverage.ts` | fim de tarefa |
| Segredos (histórico) | Nenhum vazamento em todo o histórico git | Confere o que o check de edição não vê | `gitleaks git --redact --no-banner` | revisão, CI |
| Dependências | Nada de severidade alta ou maior | Abaixo disso é quase sempre ruído; exceções médias ficam registradas | `docker run --rm -v .:/src ghcr.io/google/osv-scanner:v2.7.1 scan source -r /src` | revisão, CI |
| Segurança de código | Zero achados de severidade ERROR em `p/default` + `p/owasp-top-ten` | Opinião externa: OWASP não é julgado pelos nossos próprios testes | `docker run --rm -v .:/src -w /src semgrep/semgrep:1.186.0 semgrep scan --config p/default --config p/owasp-top-ten --severity ERROR --error --metrics=off --quiet src scripts docker` | revisão, CI |

Atalhos no `package.json`, que espelham esta tabela (em caso de divergência, vale este arquivo):

| Comando | O que roda | Orçamento | Medido em 2026-11-25 |
|---|---|---|---|
| `pnpm check:fast` | tipos, lint (inclui tamanho e complexidade), segredos do diff, floor-guard | segundos | ~3 s |
| `pnpm check:task` | `check:fast` + arquitetura + testes com cobertura (ratchet) + cobertura das linhas alteradas | < 90 s | ~20 s |
| `pnpm check:full` | `check:task` + gitleaks no histórico + osv-scanner + Semgrep | sem limite (revisão, CI) | ~3 min (Semgrep domina) |

`check:task` precisa do Postgres no ar (`docker compose up -d --wait db`). `check:full` precisa de Docker e do `gitleaks` instalado.

## Measured, not yet enforced as targets (ratchet)

Cobertura total do projeto, medida em 2026-11-25 (pisos subidos com o módulo presets). O `vitest.config.ts` trava o valor de hoje menos 0,5 de tolerância, para variações de arquivos não relacionados não quebrarem o build. Quando um número subir, sobe-se o piso; ele nunca desce.

| Métrica | Hoje | Piso em `vitest.config.ts` | Direção |
|---|---|---|---|
| Linhas | 97,3% | 96,8 | não pode cair |
| Statements | 93,2% | 92,6 | não pode cair |
| Funções | 92,2% | 91,6 | não pode cair |
| Branches | 87,9% | 87,3 | não pode cair |

## Dimensões fora por ora

- **Performance (Lighthouse) e acessibilidade (axe):** exigem uma URL rodando. Entram quando o módulo `web-ui` existir.
- **Qualidade de asserções (Stryker):** reavaliar depois do `mcp-server`.

## Exceptions

| ID | Regra | Caminho | Motivo | Dono | Expira |
|----|-------|---------|--------|------|--------|
| E1 | Dependências (osv-scanner) | `pnpm-lock.yaml` (esbuild 0.18.20) | GHSA-67mh-4wv8-2f99, média (CVSS 5.3), via `drizzle-kit` (dev). Afeta só o servidor de dev do esbuild, que o projeto não usa. Está abaixo do gate (alta ou maior); registrada em `osv-scanner.toml`. Remover quando o drizzle-kit atualizar o esbuild. | owner | 2027-02-23 |
