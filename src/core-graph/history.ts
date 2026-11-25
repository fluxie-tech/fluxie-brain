import type { Tx } from './db.ts';
import { changeLog } from './schema.ts';
import type { Actor } from './types.ts';

type ChangeEntry = {
  spaceId: string;
  kind: (typeof changeLog.$inferInsert)['targetKind'];
  action: (typeof changeLog.$inferInsert)['action'];
  target: string;
  actor: Actor;
  before: object | null;
  after: object | null;
};

/** Records one write in the change log; must run inside the same transaction as the write. */
export async function logChange(tx: Tx, e: ChangeEntry): Promise<void> {
  await tx.insert(changeLog).values({
    spaceId: e.spaceId,
    targetKind: e.kind,
    targetId: e.target,
    action: e.action,
    actor: e.actor,
    before: e.before,
    after: e.after,
  });
}
