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
 * ImpostoCategoria — subcoleção `categorias/{categoriaId}/imposto/{doc-id}`.
 * Per-categoria Imposto override; the orchestrator's
 * `resolveItemImposto` cascade falls through to it after `impostoProduto`
 * misses.
 *
 * **Wire = the legacy Flutter shape, verbatim (#398/#423).** The Firestore
 * collection ID is `imposto` (the legacy Dart getter was NAMED
 * `impostocategoria`, but its collectionId was `'imposto'`), and the scope
 * pointer keeps the legacy key `impostoCategoriaOperacaoOuterRef`: null =
 * any operação; otherwise only matches the specified operação
 * (`operacao/<id>`). Same ROLE as the produto-level pointer, different key —
 * `impostoProduto` keeps Flutter's typo key `impostoOpercaoOuterRef` (no
 * second "a"). The migrated corpus is keyed that way, so legacy-written docs
 * resolve natively — no migration, no dual-read.
 *
 * Imposto blob fields are **typed** (`taxConfigFields`, shared with the tribute
 * engine via `@delfrance/schemas`) — see `impostoProduto` for the rationale.
 */
export const impostoCategoriaSchema = z.object({
  id: z.string().nullable().default(null),
  impostoCategoriaOperacaoOuterRef: idRefSchema.nullable().default(null),
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
  collectionPath: 'categorias/{categoriaId}/imposto',
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
