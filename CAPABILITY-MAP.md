# Capability Map: fluxie-brain

Memória compartilhada em grafo para agentes de IA, que melhora com o uso.
Repositório público em `fluxie-tech/fluxie-brain`, licença MIT. Inspirado no omnigraph.dev, mas simplificado: Postgres + MCP em TypeScript.

| Module id | Responsabilidade | Depende de |
|---|---|---|
| core-graph | Schema Postgres: spaces, entities, relations, change_log; validação contra a ontologia do preset; migrações | — |
| embeddings | Embeddings locais via Ollama (API compatível com OpenAI, então dá para trocar de provedor). Vetores em tabela própria; modelo escolhido por teste entre Qwen3-Embedding-0.6B e EmbeddingGemma 2, alvo CPU. Busca híbrida (vetor + full-text + RRF + vizinhos a 1–2 saltos) | core-graph |
| presets | Ontologias por tipo de memória (tipos de nó/relação, campos obrigatórios, política de aprovação) | core-graph |
| mcp-server | Ferramentas MCP, escopo por space, stdio + HTTP com token, imagem Docker | core-graph, embeddings, presets |
| agent-loop | Hooks/skill do Claude Code: injetar contexto antes da tarefa, registrar aprendizados depois | mcp-server |
| curation | Ciclo de draft, dedupe, detecção de contradição, reforço/decaimento, curador de IA com autonomia medida por taxa de concordância | mcp-server |
| ingest-conversations | Entrada de WhatsApp/e-mail para o Long Memory (conector a definir) | mcp-server, embeddings |
| web-ui | UI estilo Obsidian: grafo, edição, fila de revisão | mcp-server, curation |

Ordem de construção: core-graph → embeddings, presets → mcp-server → agent-loop, curation → ingest-conversations, web-ui

## Decisões

- **Escopo da v1:** core-graph, embeddings, presets (só Development Graph), mcp-server, agent-loop e curation básica (draft, dedupe, curador sugere sem autonomia).
- **Depois da v1:** web-ui, ingest-conversations, autonomia do curador e os presets Company Brain, Agent Work Queue, Second Brain e Long Memory.
- **Separação:** spaces isolados por padrão; ligações entre spaces só quando explícitas.
- **Curador:** começa como ferramenta MCP executada pelo agente conectado. A interface já fica pronta para mover a execução para o servidor depois.
- **Long Memory:** modelo genérico (Conversation, Message, Participant); o conector é decidido no spec do módulo.
- **Deploy:** docker compose local. A mesma imagem vai para a VPS; TLS e domínio entram quando subir para a VPS.
- **Stack:** Node 26 LTS, TypeScript, pnpm, Biome, Vitest, Drizzle, Postgres 19 (ou 18) + pgvector. Sempre a versão estável mais recente, fixada com número exato e conferida na implementação.
- **Curadoria no núcleo:** status só muda via operação explícita; um agente editando algo aprovado gera uma proposta pendente, não uma alteração direta.
- **Privacidade:** nenhum dado real (conversas, e-mails, pessoas) entra no repositório, só código e fixtures fictícias.

## Specs

Cada módulo tem seu spec em `SPEC-<module-id>.md`, escrito na ordem de construção.
