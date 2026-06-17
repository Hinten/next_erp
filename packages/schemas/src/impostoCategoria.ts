import { z } from 'zod';
import { millisSinceEpoch } from './datetime';
import type { CollectionMetadata } from './types';

// Mirrors PERM.impostoCategoria in packages/auth/src/permissions.ts (byte 12;
// relocated from the mis-assigned 78-80 — bit 80 belongs to arquivo.read).
const PERM_IMPOSTO_CATEGORIA_READ = 1n << 96n;
const PERM_IMPOSTO_CATEGORIA_WRITE = 1n << 97n;
const PERM_IMPOSTO_CATEGORIA_DELETE = 1n << 98n;

/**
 * ImpostoCategoria — subcoleção
 * `categorias/{categoriaId}/impostocategoria/{auto-id}`.
 * Per-categoria Imposto override; the orchestrator's
 * `resolveItemImposto` cascade falls through to it after `impostoProduto`
 * misses.
 *
 * Same `impostoOperacaoOuterRef` scope pointer as `impostoProduto`: null
 * = any operação; otherwise only matches the specified operação.
 *
 * Imposto blob fields are pass-through and validated downstream by the
 * tribute engine — see `impostoProduto` for the rationale.
 */
export const impostoCategoriaSchema = z
  .object({
    id: z.string().nullable().default(null),
    impostoOperacaoOuterRef: z.string().nullable().default(null),
    dataCadastro: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();

export type ImpostoCategoria = z.infer<typeof impostoCategoriaSchema>;

export const impostoCategoriaMeta: CollectionMetadata = {
  collectionPath: 'categorias/{categoriaId}/impostocategoria',
  permissions: {
    read: PERM_IMPOSTO_CATEGORIA_READ,
    write: PERM_IMPOSTO_CATEGORIA_WRITE,
    delete: PERM_IMPOSTO_CATEGORIA_DELETE,
  },
};

export const impostoCategoria = {
  schema: impostoCategoriaSchema,
  meta: impostoCategoriaMeta,
};
