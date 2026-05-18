import { z } from 'zod';
import type { CollectionMetadata } from './types';

// Mirror `PERM.lixeira` from @delfrance/auth; duplicated locally to avoid a
// circular dep between the schemas and auth packages.
const PERM_LIXEIRA_READ = 1n << 80n;
const PERM_LIXEIRA_WRITE = 1n << 81n;
const PERM_LIXEIRA_DELETE = 1n << 82n;

/**
 * One recoverable record under the top-level `lixeira` collection.
 *
 * An entry is produced by the `onDelete` Cloud Function trigger: when a
 * document is deleted, the trigger snapshots the whole document into `data`
 * and records where it came from (`collectionPath` / `docId`). The recovery
 * UI lists these entries and restores them by re-writing `data` back to the
 * original collection under the original id.
 *
 * `deletedBy` is the uid of the user who triggered the delete when it can be
 * resolved (`event.authId`); it is `null` for service-account or otherwise
 * unattributed deletes (scripts, the Firebase console).
 */
export const lixeiraSchema = z.object({
  collectionPath: z.string().describe('Coleção'),
  docId: z.string().describe('ID original'),
  label: z.string().nullable().default(null).describe('Item'),
  // Full snapshot of the deleted document. `record/unknown` so the
  // schema-driven UI primitives skip it as a column.
  data: z.record(z.string(), z.unknown()),
  deletedAt: z.string().datetime().describe('Excluído em'),
  deletedBy: z.string().nullable().default(null).describe('Excluído por'),
});

export type LixeiraEntry = z.infer<typeof lixeiraSchema>;

export const lixeiraMeta: CollectionMetadata = {
  collectionPath: 'lixeira',
  permissions: {
    read: PERM_LIXEIRA_READ,
    write: PERM_LIXEIRA_WRITE,
    delete: PERM_LIXEIRA_DELETE,
  },
};

export const lixeira = { schema: lixeiraSchema, meta: lixeiraMeta };
