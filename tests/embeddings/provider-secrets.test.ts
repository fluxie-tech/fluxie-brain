import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { EmbeddingConfigError, EmbeddingProviderError } from '../../src/embeddings/index.ts';
import { configFromEnv, embed } from '../../src/embeddings/provider.ts';
import { startStub } from './stub-provider.ts';

const GEMMA = 'embeddinggemma-2:270m';

describe('credentials in EMBEDDINGS_BASE_URL', () => {
  it.each(['http://user:s3cret@host.example/v1', 'http://user@host.example/v1', 'http://:s3cret@host.example/v1'])(
    'refuses %s without echoing it',
    (baseUrl) => {
      const attempt = () => configFromEnv({ EMBEDDINGS_BASE_URL: baseUrl });
      expect(attempt).toThrow(EmbeddingConfigError);
      expect(attempt).not.toThrow(/s3cret|user|host\.example/);
    },
  );

  it('does not echo a malformed URL either', () => {
    expect(() => configFromEnv({ EMBEDDINGS_BASE_URL: 'ftp://host.example/v1' })).not.toThrow(/host\.example/);
  });

  it('keeps the password out of the error of an unreachable provider (hand-built config)', async () => {
    const closed = await startStub();
    await closed.close();
    const baseUrl = closed.baseUrl.replace('http://', 'http://user:s3cret@');
    const err = await embed({ baseUrl, model: GEMMA, apiKey: undefined }, ['x']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingProviderError);
    expect((err as Error).message).toMatch(/unreachable/);
    expect((err as Error).message).not.toMatch(/s3cret|user|127\.0\.0\.1/);
  });

  it('keeps the API key and the provider address out of every provider error', async () => {
    const stub = await startStub();
    try {
      const config = { baseUrl: stub.baseUrl, model: GEMMA, apiKey: 'sk-s3cret-key' };
      const replies = [
        { status: 401, body: '{"error":"bad key sk-s3cret-key"}' },
        { status: 200, body: 'not json' },
        { status: 200, body: JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }) },
        { status: 200, body: JSON.stringify({ data: [] }) },
      ];
      for (const reply of replies) {
        stub.respond = () => reply;
        const err = await embed(config, ['x']).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EmbeddingProviderError);
        expect((err as Error).message).not.toMatch(/sk-s3cret|127\.0\.0\.1/);
      }
    } finally {
      await stub.close();
    }
  });
});

describe('a timeout while reading the response body', () => {
  it('is reported as a timeout, not as a body that is not JSON, and without the URL', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":'); // headers and a partial body arrive, the rest never does
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    try {
      const err = await embed({ baseUrl, model: GEMMA, apiKey: undefined }, ['x'], 300).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingProviderError);
      expect((err as Error).message).toMatch(/TimeoutError/);
      expect((err as Error).message).not.toMatch(/not JSON|127\.0\.0\.1/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('provider hardening', () => {
  it('refuses a redirect (it would resend the key): the target is never called', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits++;
      res.writeHead(200).end('{}');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/steal`;
    const server = createServer((_req, res) => res.writeHead(307, { location: targetUrl }).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    try {
      const err = await embed({ baseUrl, model: GEMMA, apiKey: 'k' }, ['x']).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingProviderError);
      expect((err as Error).message).not.toMatch(/steal|127\.0\.0\.1/);
      expect(targetHits).toBe(0);
    } finally {
      await Promise.all([server, target].map((s) => new Promise((resolve) => s.close(resolve))));
    }
  });

  it.each([
    ['above the float32 maximum', 3.5e38],
    ['below the float32 maximum', -3.5e38],
    ['subnormal', 1e-39],
  ])('rejects a vector with a value %s, which pgvector would refuse', async (_name, bad) => {
    const stub = await startStub();
    const dims = 768;
    stub.respond = () => ({
      status: 200,
      body: JSON.stringify({ data: [{ index: 0, embedding: [bad, ...new Array(dims - 1).fill(0.1)] }] }),
    });
    try {
      await expect(embed({ baseUrl: stub.baseUrl, model: GEMMA, apiKey: undefined }, ['x'])).rejects.toThrow(/float32/);
    } finally {
      await stub.close();
    }
  });

  it('accepts the float32 limits themselves and exact zeros', async () => {
    const stub = await startStub();
    stub.respond = () => ({
      status: 200,
      body: JSON.stringify({
        data: [
          { index: 0, embedding: [3.4028234663852886e38, 1.1754943508222875e-38, 0, ...new Array(765).fill(0.1)] },
        ],
      }),
    });
    try {
      await expect(embed({ baseUrl: stub.baseUrl, model: GEMMA, apiKey: undefined }, ['x'])).resolves.toHaveLength(1);
    } finally {
      await stub.close();
    }
  });
});
