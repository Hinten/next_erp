import { z } from 'zod';
import type { CollectionMetadata } from './types';

// Mirror `PERM.pedido` from @delfrance/auth.
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * MotivoIncidente — taxonomia de motivos de incidente/devolução em pedidos.
 * Mirrors `MotivoIncidente` em `.old/packages/pedido/lib/src/models.dart`.
 */
export const motivoIncidenteSchema = z.object({
  nome: z.string().min(1).describe('Nome'),
  ativo: z.boolean().default(true).describe('Ativo'),
  // System field — stamped by `saveRecord` on every write so the TableView
  // update-monitor sees edits.
  ultimaModificacao: z.string().datetime().nullable().optional(),
});

export type MotivoIncidente = z.infer<typeof motivoIncidenteSchema>;

export const motivoIncidenteMeta: CollectionMetadata = {
  collectionPath: 'motivosincidentes',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
  },
};

export const motivoIncidente = {
  schema: motivoIncidenteSchema,
  meta: motivoIncidenteMeta,
};
