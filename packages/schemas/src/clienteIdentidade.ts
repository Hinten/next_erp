import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';

/**
 * Strong cliente identities indexed by the server-side marketplace resolver.
 *
 * This is deliberately an Admin-only schema, with no CollectionMetadata entry:
 * browser clients never read or write the coordination index. The value itself
 * is not retained here — the deterministic document id is its SHA-256 digest.
 */
export const clienteIdentidadeTipoSchema = z.enum(['cpf_cnpj', 'idEstrangeiro', 'idMercadoLivre']);

export type ClienteIdentidadeTipo = z.infer<typeof clienteIdentidadeTipoSchema>;

export const clienteIdentidadeSchema = z.object({
  tipo: clienteIdentidadeTipoSchema,
  clienteIds: z.array(z.string().min(1)).default([]),
  /** Milliseconds since epoch, matching clienteSchema's stamps. */
  ultimaModificacao: millisSinceEpoch(),
});

export type ClienteIdentidade = z.infer<typeof clienteIdentidadeSchema>;
