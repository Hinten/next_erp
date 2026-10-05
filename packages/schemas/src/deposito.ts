import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

// Mirror `PERM.estoque` from @delfrance/auth; duplicated locally to avoid a
// circular dep.
const PERM_ESTOQUE_READ = 1n << 64n;
const PERM_ESTOQUE_WRITE = 1n << 65n;
const PERM_ESTOQUE_DELETE = 1n << 66n;

/**
 * Deposito — armazém / depósito físico onde estoque é mantido. Mirrors
 * `Deposito` in `packages/produtos/lib/src/models.dart` (.old/Flutter).
 */
export const depositoSchema = z.object({
  nome: z.string().min(1).max(255).describe('Nome'),
  ativo: z.boolean().default(true).describe('Ativo'),
  // Milliseconds since epoch (numeric-epoch standard); reads tolerantly.
  timestamp: millisSinceEpoch().nullable().optional(),
  // System field — stamped by `saveRecord` on every write so the TableView
  // update-monitor sees edits.
  // `.default(null)`, never a bare `.optional()`: the TableView update-
  // monitor runs a CLASSIC `orderBy(ultimaModificacao, 'desc').limit(1)`,
  // which EXCLUDES documents missing the key — so a dropped key hides the
  // row from the staleness check, silently. Pinned by
  // `defaultQuery.sortKeyPresence.test.ts`.
  ultimaModificacao: millisSinceEpoch().nullable().default(null),
});

export type Deposito = z.infer<typeof depositoSchema>;

export const depositoMeta: CollectionMetadata = {
  collectionPath: 'depositos',
  permissions: {
    read: PERM_ESTOQUE_READ,
    write: PERM_ESTOQUE_WRITE,
    delete: PERM_ESTOQUE_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
    columns: ['nome', 'ativo'],
  },
};

export const deposito = { schema: depositoSchema, meta: depositoMeta };
