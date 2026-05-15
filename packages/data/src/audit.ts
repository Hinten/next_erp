import type { Transaction } from 'firebase/firestore';

export interface AuditEntryInput {
  collectionPath: string;
  docId: string;
  uid: string;
  kind: 'create' | 'update' | 'delete';
  patch: Record<string, unknown>;
}

/**
 * Stub. In the next phase this writes a doc to
 * `audit/<collection>/<docId>/changes/<auditId>` inside the same transaction
 * as the underlying mutation so both succeed or fail together.
 *
 * Currently a no-op so callers can already pass the right metadata without
 * the write actually happening. Activating the write is a single function
 * body change — the call sites do not need to move.
 *
 * TODO Phase X: enable audit writes (use Firestore rules to restrict writes
 * to this path to Cloud Functions / privileged callers).
 */
export function writeAuditEntry(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tx: Transaction,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  entry: AuditEntryInput,
): void {
  // intentionally empty — see TODO above
}
