import { EmbeddingConfigError } from './errors.ts';

/** How one model embeds: its output size and the prompt formats it was trained with. */
export type ModelSpec = {
  dimensions: number;
  document: (title: string, content: string) => string;
  query: (text: string) => string;
};

// Ollama applies no prompt of its own (TEMPLATE {{ .Prompt }}, checked in the T1 spike), so these are the only prefixes.
// Changing a template changes the vectors: add a new id instead, so old and new vectors never mix.
export const MODELS = {
  // Model card: "task: search result | query: …" for queries, "title: … | text: …" for documents.
  'embeddinggemma-2:270m': {
    dimensions: 768,
    document: (title, content) => `title: ${title} | text: ${content}`,
    query: (text) => `task: search result | query: ${text}`,
  },
  // Model card: queries carry an English one-line instruction ("Query:" with no space); documents go bare.
  'qwen3-embedding:0.6b': {
    dimensions: 1024,
    document: (title, content) => `${title}\n${content}`,
    query: (text) =>
      `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:${text}`,
  },
  // Remote, through OpenRouter's OpenAI-compatible API (Emenda 2): production candidate. OpenAI embeddings take raw
  // text, with no instruction or role prefix. Native 1536 dims, uncut. Id as OpenRouter names it (confirmed in T19).
  'openai/text-embedding-3-small': {
    dimensions: 1536,
    document: (title, content) => `${title}\n${content}`,
    query: (text) => text,
  },
} satisfies Record<string, ModelSpec>;

/** Models served by the local Ollama container (the ones the compose can pull); the rest are remote APIs. */
export const LOCAL_MODELS = ['embeddinggemma-2:270m', 'qwen3-embedding:0.6b'] as const;

export const DEFAULT_MODEL = 'embeddinggemma-2:270m';

export function modelSpec(model: string): ModelSpec {
  if (!Object.hasOwn(MODELS, model)) {
    throw new EmbeddingConfigError(`Unknown embeddings model "${model}". Known: ${Object.keys(MODELS).join(', ')}.`);
  }
  return MODELS[model as keyof typeof MODELS];
}
