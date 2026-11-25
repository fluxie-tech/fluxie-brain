import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { db, type Tx } from './db.ts';
import { type Entity, entityColumns, findEntityOrThrow } from './entities.ts';
import { ConflictError, NotFoundError, VersionConflictError } from './errors.ts';
import { logChange } from './history.ts';
import { entities, entityProposals, type ProposedChange } from './schema.ts';
import { isUuid } from './scope.ts';
import type { Actor } from './types.ts';

export type Proposal = typeof entityProposals.$inferSelect;
type ProposalStatus = Proposal['status'];

const proposalColumns = getTableColumns(entityProposals);

/** Records an agent's edit of an approved entity as a pending proposal (called inside upsertEntity). */
export async function createProposal(
  tx: Tx,
  entity: Entity,
  proposed: ProposedChange,
  actor: Actor,
): Promise<Proposal> {
  const [proposal] = await tx
    .insert(entityProposals)
    .values({ entityId: entity.id, baseVersion: entity.version, proposed, proposedBy: actor })
    .returning();
  if (!proposal) throw new Error('insert returned no row');
  await logChange(tx, {
    spaceId: entity.spaceId,
    kind: 'proposal',
    action: 'propose',
    target: proposal.id,
    actor,
    before: null,
    after: proposal,
  });
  return proposal;
}

export async function listProposals(spaceId: string, opts: { status?: ProposalStatus } = {}): Promise<Proposal[]> {
  return db
    .select(proposalColumns)
    .from(entityProposals)
    .innerJoin(entities, eq(entities.id, entityProposals.entityId))
    .where(and(eq(entities.spaceId, spaceId), opts.status ? eq(entityProposals.status, opts.status) : undefined))
    .orderBy(entityProposals.createdAt);
}

export async function pendingProposalsFor(entityId: string): Promise<Proposal[]> {
  return db
    .select()
    .from(entityProposals)
    .where(and(eq(entityProposals.entityId, entityId), eq(entityProposals.status, 'pending')))
    .orderBy(entityProposals.createdAt);
}

/** Loads and locks a pending proposal of the space; proposals of other spaces behave as missing. */
async function findPendingProposal(tx: Tx, spaceId: string, proposalId: string): Promise<Proposal> {
  const [proposal] = isUuid(proposalId)
    ? await tx
        .select(proposalColumns)
        .from(entityProposals)
        .innerJoin(entities, eq(entities.id, entityProposals.entityId))
        .where(and(eq(entityProposals.id, proposalId), eq(entities.spaceId, spaceId)))
        .for('update', { of: entityProposals })
    : [];
  if (!proposal) throw new NotFoundError(`Proposal ${proposalId} not found in this space.`);
  if (proposal.status !== 'pending') throw new ConflictError(`Proposal ${proposalId} was already ${proposal.status}.`);
  return proposal;
}

async function decide(tx: Tx, proposalId: string, status: ProposalStatus, actor: Actor): Promise<Proposal> {
  const [decided] = await tx
    .update(entityProposals)
    .set({ status, decidedBy: actor, decidedAt: new Date() })
    .where(eq(entityProposals.id, proposalId))
    .returning();
  if (!decided) throw new Error('update returned no row');
  return decided;
}

/** Applies a pending proposal to its entity. Fails if the entity changed since the proposal was made. */
export async function acceptProposal(spaceId: string, proposalId: string, actor: Actor): Promise<Entity> {
  return db.transaction(async (tx) => {
    const proposal = await findPendingProposal(tx, spaceId, proposalId);
    const before = await findEntityOrThrow(tx, spaceId, proposal.entityId);
    if (before.version !== proposal.baseVersion) {
      throw new VersionConflictError(
        `Proposal ${proposalId} was made on version ${proposal.baseVersion}, entity is at ${before.version}.`,
      );
    }
    const [after] = await tx
      .update(entities)
      .set({ ...proposal.proposed, version: sql`${entities.version} + 1`, updatedAt: new Date() })
      .where(eq(entities.id, before.id))
      .returning(entityColumns);
    if (!after) throw new Error('update returned no row');
    await decide(tx, proposalId, 'accepted', actor);
    // Logged against the entity so its history and revert see the content change.
    await logChange(tx, { spaceId, kind: 'entity', action: 'accept', target: before.id, actor, before, after });
    return after;
  });
}

/** Discards a pending proposal; the entity is untouched. */
export async function rejectProposal(spaceId: string, proposalId: string, actor: Actor): Promise<Proposal> {
  return db.transaction(async (tx) => {
    const before = await findPendingProposal(tx, spaceId, proposalId);
    const after = await decide(tx, proposalId, 'rejected', actor);
    await logChange(tx, { spaceId, kind: 'proposal', action: 'reject', target: proposalId, actor, before, after });
    return after;
  });
}
