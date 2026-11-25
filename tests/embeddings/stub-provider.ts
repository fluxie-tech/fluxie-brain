import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MODELS } from '../../src/embeddings/models.ts';

type Reply = { status: number; body: string };
export type StubRequest = { model: string; input: string[]; authorization: string | undefined };

/** A local OpenAI-compatible /v1/embeddings server for tests: deterministic, no Ollama needed. */
export type Stub = {
  baseUrl: string;
  requests: StubRequest[];
  /** Exact vectors for given input texts; everything else gets a bag-of-words vector. */
  fixed: Map<string, number[]>;
  /** Overrides the next replies (e.g. an HTTP 500); return undefined to answer normally. */
  respond: ((req: StubRequest) => Reply | undefined) | undefined;
  close(): Promise<void>;
};

/** Hashes each word into one of `dims` buckets, then normalizes: texts sharing words end up close. */
export function bagOfWords(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
    v[h % dims] = (v[h % dims] ?? 0) + 1;
  }
  return normalize(v);
}

/** Unit vector along one axis, for tests that need two texts close without sharing words. */
export function axis(index: number, dims: number): number[] {
  return Array.from({ length: dims }, (_, i) => (i === index ? 1 : 0));
}

function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function vectorFor(stub: Stub, model: string, text: string): number[] {
  const dims = MODELS[model as keyof typeof MODELS]?.dimensions ?? 8;
  return stub.fixed.get(text) ?? bagOfWords(text, dims);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

export async function startStub(): Promise<Stub> {
  const stub: Stub = { baseUrl: '', requests: [], fixed: new Map(), respond: undefined, close: async () => {} };
  const server = createServer(async (req, res) => {
    const parsed = JSON.parse(await readBody(req)) as { model: string; input: string[] };
    const request = { model: parsed.model, input: parsed.input, authorization: req.headers.authorization };
    stub.requests.push(request);
    const reply = stub.respond?.(request) ?? {
      status: 200,
      body: JSON.stringify({
        object: 'list',
        model: parsed.model,
        data: parsed.input.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: vectorFor(stub, parsed.model, text),
        })),
      }),
    };
    res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  stub.close = () => new Promise((resolve) => server.close(() => resolve()));
  return stub;
}
