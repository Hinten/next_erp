import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { idRefSchema } from './shared/outerRef';
import { taxConfigFields } from './imposto/tribute';
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
 * Scope pointer `impostoOperacaoOuterRef`: null = any operação; otherwise
 * only matches the specified operação (`operacao/<id>`). Same ROLE as the
 * produto-level pointer, but the wire keys differ — beware:
 *   - `impostoProduto` keeps Flutter's typo key `impostoOpercaoOuterRef`
 *     (no second "a") because the produto tier reads legacy docs in place;
 *   - the legacy Flutter categoria docs used a THIRD name,
 *     `impostoCategoriaOperacaoOuterRef`, on subcollection
 *     `categorias/{id}/imposto` (not `impostocategoria`). This schema is the
 *     NEW canonical shape only; legacy categoria docs are translated by the
 *     `imposto-legacy-names` migration (`tools/migrations`) — the resolver
 *     does NOT dual-read them (#398).
 *
 * Imposto blob fields are **typed** (`taxConfigFields`, shared with the tribute
 * engine via `@delfrance/schemas`) — see `impostoProduto` for the rationale.
 */
export const impostoCategoriaSchema = z.object({
  id: z.string().nullable().default(null),
  impostoOperacaoOuterRef: idRefSchema.nullable().default(null),
  // Dados Gerais (lenient strings, optional — a categoria override may omit
  // them; the resolver re-validates via the engine `impostoSchema`).
  origem: z.string().nullable().optional(),
  cfop: z.string().nullable().optional(),
  cfopInterestadual: z.string().nullable().optional(),
  NCM: z.string().nullable().optional(),
  NVE: z.string().nullable().optional(),
  CEST: z.string().nullable().optional(),
  indEscala: z.string().nullable().optional(),
  CNPJFab: z.string().nullable().optional(),
  cBenef: z.string().nullable().optional(),
  extipi: z.string().nullable().optional(),
  unidade: z.string().nullable().optional(),
  compoeValorTotalDaNFe: z.boolean().nullable().optional(),
  ...taxConfigFields,
  dataCadastro: millisSinceEpoch().nullable().default(null),
});

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
