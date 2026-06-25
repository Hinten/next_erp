import { z } from 'zod';

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
  timestamp: z.string().datetime(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;
