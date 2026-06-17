import { z } from 'zod';
import { millisSinceEpoch } from './datetime';
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
  ultimaModificacao: millisSinceEpoch().nullable().optional(),
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
  },
};

export const deposito = { schema: depositoSchema, meta: depositoMeta };
