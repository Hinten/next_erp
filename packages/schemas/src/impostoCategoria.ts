import { z } from 'zod';
import type { CollectionMetadata } from './types';

const PERM_IMPOSTO_CATEGORIA_READ = 1n << 78n;
const PERM_IMPOSTO_CATEGORIA_WRITE = 1n << 79n;
const PERM_IMPOSTO_CATEGORIA_DELETE = 1n << 80n;

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
    dataCadastro: z.string().datetime().nullable().default(null),
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
