import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptProposal,
  ConflictError,
  createSpace,
  type Entity,
  getEntity,
  listProposals,
  NotFoundError,
  registerOntology,
  rejectProposal,
  type Space,
  upsertEntity,
  VersionConflictError,
} from '../../src/core-graph/index.ts';
import { TEST_PRESET, testOntology } from '../fixtures/ontology.ts';
import { queryRows, truncateAll } from '../setup/db.ts';

const agent = 'agent:test';
const curator = 'human:owner';

describe('proposals on approved entities', () => {
  let space: Space;
  let otherSpace: Space;
  let rule: Entity;

  const edit = (title: string, content = 'C') =>
    upsertEntity(space.id, { type: 'rule', key: 'r1', title, content, metadata: { severity: 'high' } }, agent);

  beforeAll(() => registerOntology(TEST_PRESET, testOntology));
  beforeEach(async () => {
    await truncateAll();
    space = await createSpace({ slug: 'dev', name: 'Dev', preset: TEST_PRESET });
    otherSpace = await createSpace({ slug: 'other', name: 'Other', preset: TEST_PRESET });
    rule = (await edit('Original')).entity; // rule defaults to approved
  });

  it('turns an edit of an approved entity into a pending proposal without changing the entity', async () => {
    const { entity, proposal } = await edit('Edited');
    expect(entity).toMatchObject({ title: 'Original', version: 1, status: 'approved' });
    expect(proposal).toMatchObject({
      status: 'pending',
      baseVersion: 1,
      proposedBy: agent,
      proposed: { title: 'Edited' },
    });
    expect(await getEntity(space.id, 'r1')).toMatchObject({
      title: 'Original',
      pendingProposals: [{ id: proposal?.id }],
    });
  });

  it('applies an accepted proposal and records who decided', async () => {
    const { proposal } = await edit('Edited');
    const accepted = await acceptProposal(space.id, proposal?.id ?? '', curator);
    expect(accepted).toMatchObject({ title: 'Edited', version: 2, status: 'approved' });
    expect(await listProposals(space.id, { status: 'accepted' })).toMatchObject([{ decidedBy: curator }]);
    const log = await queryRows(`select actor, target_id from change_log where action = 'accept'`);
    expect(log).toEqual([{ actor: curator, target_id: rule.id }]);
  });

  it('discards a rejected proposal and records who decided', async () => {
    const { proposal } = await edit('Edited');
    const rejected = await rejectProposal(space.id, proposal?.id ?? '', curator);
    expect(rejected).toMatchObject({ status: 'rejected', decidedBy: curator });
    expect(await getEntity(space.id, 'r1')).toMatchObject({ title: 'Original', pendingProposals: [] });
    const log = await queryRows(`select actor from change_log where action = 'reject'`);
    expect(log).toEqual([{ actor: curator }]);
  });

  it('refuses to accept a proposal made on an outdated version', async () => {
    const first = (await edit('First')).proposal;
    const second = (await edit('Second')).proposal;
    await acceptProposal(space.id, first?.id ?? '', curator);
    await expect(acceptProposal(space.id, second?.id ?? '', curator)).rejects.toThrow(VersionConflictError);
  });

  it('refuses to decide a proposal twice', async () => {
    const { proposal } = await edit('Edited');
    await rejectProposal(space.id, proposal?.id ?? '', curator);
    await expect(acceptProposal(space.id, proposal?.id ?? '', curator)).rejects.toThrow(ConflictError);
  });

  it('changes content_hash when an accepted proposal changes the content', async () => {
    const hash = async () => (await queryRows(`select content_hash from entities where id = $1`, [rule.id]))[0];
    const before = await hash();
    const { proposal } = await edit('Original', 'New content');
    await acceptProposal(space.id, proposal?.id ?? '', curator);
    expect(await hash()).not.toEqual(before);
  });

  it('treats a proposal id from another space as missing', async () => {
    const { proposal } = await edit('Edited');
    await expect(acceptProposal(otherSpace.id, proposal?.id ?? '', curator)).rejects.toThrow(NotFoundError);
    await expect(rejectProposal(otherSpace.id, proposal?.id ?? '', curator)).rejects.toThrow(NotFoundError);
    expect(await listProposals(otherSpace.id)).toEqual([]);
  });
});
