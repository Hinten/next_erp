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
 *
 * **No `.passthrough()`** (already dropped ahead of this audit, #398/#423) —
 * a plain (strip-policy) `z.object`. On READ, `parseSoftRead` (`@delfrance/data`)
 * still tolerates an unmodeled key (strips it silently); on WRITE,
 * `parseForWrite`/`parseMergePatch` notice the strip and re-parse `.strict()`,
 * so a genuinely unknown top-level key throws instead of silently persisting.
 *
 * Field-level audit against `_$ImpostoCategoriaToJson`
 * (`.old/packages/produtos/lib/src/models.g.dart:581`, #467) surfaced three wire
 * mismatches:
 *   - **`CFOP`** is written UPPERCASE on this collection (unlike
 *     `impostoProduto`'s lowercase `cfop`) — fixed here as a read fallback,
 *     same pattern as `regraImposto`; the resolver folds it into the engine's
 *     lowercase `cfop`. This one is a pure read-path addition — the shared
 *     `ImpostoConfigEditor` never writes `CFOP`, so it carries no write-path risk.
 *   - **`NVE`** is a `List<String>?` on the wire, not a scalar string.
 *   - **`indEscala`** is a `bool?` on the wire, not a string.
 *
 * The last two are **deliberately left as lenient strings** rather than
 * retyped to match the wire: `NVE`/`indEscala` are rendered by the shared
 * `ImpostoConfigEditor` (`apps/web/components/imposto/DadosGeraisSection.tsx`)
 * as plain text inputs producing `string | null`, and the same editor also
 * backs `impostoProduto` and `regraImposto`, which keep the identical
 * `z.string()` typing. Retyping only this collection's fields broke the
 * categoria save path two ways — `impostoCategoriaSchema.parse()` throwing on
 * the editor's string value, and `categoriaImpostoCarriesInfo`
 * (`apps/web/lib/categorias/clientPort.ts`) misreading a non-string value as
 * "no info" and silently deleting the doc instead of writing it — caught in
 * review on this issue's own PR (#467). Properly modeling these needs a
 * coordinated change (a multi-value input for `NVE`, a boolean control for
 * `indEscala`, `categoriaImpostoCarriesInfo`'s string-emptiness check, and a
 * decision on whether `impostoProduto`/`regraImposto` retype too, since they
 * share the editor) — left as a follow-up, not bundled into this passthrough
 * removal.
 */
export const impostoCategoriaSchema = z.object({
  id: z.string().nullable().default(null),
  impostoCategoriaOperacaoOuterRef: idRefSchema.nullable().default(null),
  // Dados Gerais (lenient strings, optional — a categoria override may omit
  // them; the resolver re-validates via the engine `impostoSchema`).
  origem: z.string().nullable().optional(),
  cfop: z.string().nullable().optional(),
  /** Legacy Flutter wire key (uppercase). Read fallback for `cfop` — never written by the new editor. */
  CFOP: z.string().nullable().optional(),
  cfopInterestadual: z.string().nullable().optional(),
  NCM: z.string().nullable().optional(),
  // Wire is `List<String>?` (see class doc) — kept as a lenient string; the
  // editor writes a plain string and `categoriaImpostoCarriesInfo` keys off
  // `typeof v === 'string'` for emptiness.
  NVE: z.string().nullable().optional(),
  CEST: z.string().nullable().optional(),
  // Wire is `bool?` (see class doc) — kept as a lenient string, same reason as `NVE`.
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
