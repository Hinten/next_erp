import { z } from 'zod';
import { millisSinceEpoch } from './datetime';

/**
 * One mutation record under `audit/{collectionName}/{docId}/changes/{auditId}`.
 *
 * Writes are produced by `writeAuditEntry()` inside the same transaction as
 * the underlying document write, so a successful audit row guarantees the
 * data row landed and vice versa.
 *
 * Currently a no-op stub on the write path; the schema is shipped now so
 * downstream tooling (rules generator, dashboards) can already type-check
 * against it.
 */
export const auditEntrySchema = z.object({
  uid: z.string(),
  collectionPath: z.string(),
  docId: z.string(),
  kind: z.enum(['create', 'update', 'delete']),
  // Partial document — for updates, only the dirty fields the user touched.
  patch: z.record(z.string(), z.unknown()),
  // millisecondsSinceEpoch INT wire format (#484/#486); tolerant read via the codec.
  timestamp: millisSinceEpoch(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;
