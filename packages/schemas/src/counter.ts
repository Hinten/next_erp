import { z } from 'zod';
import type { CollectionMetadata } from './types';

// The counter collection is gated by the pedido permission bits: the only
// counter today is the pedido `numero` sequence, allocated in the same client
// transaction that creates a pedido, so anyone who can create a pedido must be
// able to read and bump it. Mirrors `PERM.pedido` from @delfrance/auth (kept as
// local literals like the other schema files).
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * A monotonic sequence counter. Each doc in the `counters` collection is a
 * singleton keyed by purpose (currently only `pedido`) holding the last value
 * handed out. Allocation is a client `runTransaction` read-increment-write —
 * the browser equivalent of the NF-e numeração counter
 * (`packages/integrations/nfe/src/numeracao/`) — which is why the sequence is
 * gap-free and unique even under concurrent creates. `FieldValue.increment`
 * can't return the new value, so a transactional read-modify-write is required.
 */
export const counterSchema = z.object({
  value: z.number().int().nonnegative().default(0).describe('Valor'),
});

export type Counter = z.infer<typeof counterSchema>;

export const counterMeta: CollectionMetadata = {
  collectionPath: 'counters',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
};

export const counter = { schema: counterSchema, meta: counterMeta };
