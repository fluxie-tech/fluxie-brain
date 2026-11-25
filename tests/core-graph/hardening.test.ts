import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  acceptProposal,
  createSpace,
  getEntity,
  history,
  linkEntities,
  listProposals,
  NotFoundError,
  neighbors,
  OntologyError,
  recordUsage,
  registerOntology,
  rejectProposal,
  revertEntity,
  type Space,
  setStatus,
  unlink,
  upsertEntity,
  VersionConflictError,
} from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { appClient, queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';
const curator = 'human:owner';
const BAD = 'bad';
const ID = '00000000-0000-0000-0000-000000000000';
const rule = { type: 'rule', key: 'r1', title: 'Original', content: '', metadata: { severity: 'low' } };

describe('ship hardening', () => {
  let space: Space;

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
  });
  afterEach(() => registerOntology(TEST_PRESET, testOntology));

  it.each([
    ['upsertEntity', () => upsertEntity(BAD, { type: 'learning', key: 'k', title: 't', content: '' }, agent)],
    ['getEntity', () => getEntity(BAD, 'k')],
    ['setStatus', () => setStatus(BAD, ID, 'approved', curator)],
    ['recordUsage', () => recordUsage(BAD, [ID])],
    ['listProposals', () => listProposals(BAD)],
    ['acceptProposal', () => acceptProposal(BAD, ID, curator)],
    ['rejectProposal', () => rejectProposal(BAD, ID, curator)],
    ['linkEntities', () => linkEntities(BAD, { fromId: ID, toId: ID, type: 'relates_to' }, agent)],
    ['unlink', () => unlink(BAD, ID, agent)],
    ['neighbors', () => neighbors(BAD, ID, 1)],
    ['history', () => history(BAD, ID)],
    ['revertEntity', () => revertEntity(BAD, ID, 1, curator)],
  ])('%s with a malformed space id fails with NotFoundError', async (_name, call) => {
    await expect(call()).rejects.toThrow(NotFoundError);
  });

  it('listProposals of a well-formed but missing space fails with NotFoundError', async () => {
    await expect(listProposals(ID)).rejects.toThrow(NotFoundError);
  });

  it('treats metadata keys set to undefined as absent when detecting no-op upserts', async () => {
    const input = { type: 'learning', key: 'l', title: 'T', content: 'C', metadata: { cause: undefined } };
    await upsertEntity(space.id, input, agent);
    const { entity } = await upsertEntity(space.id, input, agent);
    expect(entity.version).toBe(1);
  });

  it('rejects inherited object keys as entity or relation types', async () => {
    const input = { type: 'constructor', key: 'c', title: 'C', content: '' };
    await expect(upsertEntity(space.id, input, agent)).rejects.toThrow(OntologyError);
    const { entity } = await upsertEntity(space.id, { type: 'learning', key: 'l', title: 'L', content: '' }, agent);
    const link = { fromId: entity.id, toId: entity.id, type: 'toString' };
    await expect(linkEntities(space.id, link, agent)).rejects.toThrow(OntologyError);
  });

  it('revalidates proposal metadata against the current ontology on accept', async () => {
    await upsertEntity(space.id, rule, agent);
    const { proposal } = await upsertEntity(space.id, { ...rule, title: 'Edited' }, agent);
    registerOntology(TEST_PRESET, {
      ...testOntology,
      entityTypes: {
        ...testOntology.entityTypes,
        rule: { metadata: z.object({ severity: z.enum(['high']) }), defaultStatus: 'approved' },
      },
    });
    await expect(acceptProposal(space.id, proposal?.id ?? '', curator)).rejects.toThrow(OntologyError);
  });

  it('applies proposed metadata and confidence and logs real before/after content on accept', async () => {
    await upsertEntity(space.id, rule, agent);
    const edit = { ...rule, title: 'Edited', metadata: { severity: 'high' }, confidence: 0.75 };
    const { proposal } = await upsertEntity(space.id, edit, agent);
    const accepted = await acceptProposal(space.id, proposal?.id ?? '', curator);
    expect(accepted).toMatchObject({ title: 'Edited', metadata: { severity: 'high' }, confidence: 0.75 });
    const [log] = await queryRows(`select before, after from change_log where action = 'accept'`);
    expect(log).toMatchObject({ before: { title: 'Original' }, after: { title: 'Edited' } });
  });

  it('accepts an upsert whose expectedVersion matches', async () => {
    await upsertEntity(space.id, { type: 'learning', key: 'l', title: 'v1', content: '' }, agent);
    const input = { type: 'learning', key: 'l', title: 'v2', content: '', expectedVersion: 1 };
    expect((await upsertEntity(space.id, input, agent)).entity.version).toBe(2);
  });

  it('applies only one of two different proposals accepted concurrently', async () => {
    await upsertEntity(space.id, rule, agent);
    const a = (await upsertEntity(space.id, { ...rule, title: 'A' }, agent)).proposal;
    const b = (await upsertEntity(space.id, { ...rule, title: 'B' }, agent)).proposal;
    const results = await Promise.allSettled([
      acceptProposal(space.id, a?.id ?? '', curator),
      acceptProposal(space.id, b?.id ?? '', curator),
    ]);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status === 'rejected' && failed[0].reason).toBeInstanceOf(VersionConflictError);
    expect(await getEntity(space.id, 'r1')).toMatchObject({ version: 2 });
  });

  it('rejects the second of two concurrent upserts with the same expectedVersion', async () => {
    await upsertEntity(space.id, { type: 'learning', key: 'l', title: 'v1', content: '' }, agent);
    const results = await Promise.allSettled(
      ['A', 'B'].map((title) =>
        upsertEntity(space.id, { type: 'learning', key: 'l', title, content: '', expectedVersion: 1 }, agent),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await queryRows(`select id from change_log where action = 'update'`)).toHaveLength(1);
  });

  it('links A->B and B->A concurrently without deadlocking', async () => {
    const a = (await upsertEntity(space.id, { type: 'learning', key: 'a', title: 'A', content: '' }, agent)).entity;
    const b = (await upsertEntity(space.id, { type: 'learning', key: 'b', title: 'B', content: '' }, agent)).entity;
    const results = await Promise.allSettled([
      linkEntities(space.id, { fromId: a.id, toId: b.id, type: 'relates_to' }, agent),
      linkEntities(space.id, { fromId: b.id, toId: a.id, type: 'relates_to' }, agent),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('returns every relation among the returned entities, including edges between the deepest ones', async () => {
    const [a, b, c] = await Promise.all(
      ['a', 'b', 'c'].map(
        async (key) => (await upsertEntity(space.id, { type: 'learning', key, title: key, content: '' }, agent)).entity,
      ),
    );
    if (!a || !b || !c) throw new Error('setup failed');
    await linkEntities(space.id, { fromId: a.id, toId: b.id, type: 'relates_to' }, agent);
    await linkEntities(space.id, { fromId: b.id, toId: c.id, type: 'relates_to' }, agent);
    await linkEntities(space.id, { fromId: c.id, toId: a.id, type: 'relates_to' }, agent);
    expect((await neighbors(space.id, a.id, 1)).relations).toHaveLength(3);
  });

  it('denies the app role from editing or deleting the audit trail and from physical deletes', async () => {
    const client = appClient();
    await client.connect();
    try {
      for (const statement of [
        'update change_log set actor = actor',
        'delete from change_log',
        'delete from entities',
        'delete from entity_proposals',
        'delete from spaces',
      ]) {
        await expect(client.query(statement), statement).rejects.toThrow(/permission denied/);
      }
    } finally {
      await client.end();
    }
  });
});
