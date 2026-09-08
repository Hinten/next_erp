import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { indEscalaField, nveField, taxConfigFields } from './imposto/tribute';
import type { CollectionMetadata } from './types';

// Mirrors PERM.regraImposto in packages/auth/src/permissions.ts (byte 12;
// relocated from the mis-assigned 81-83 — 81-82 belong to arquivo).
const PERM_REGRA_IMPOSTO_READ = 1n << 99n;
const PERM_REGRA_IMPOSTO_WRITE = 1n << 100n;
const PERM_REGRA_IMPOSTO_DELETE = 1n << 101n;

/**
 * RegraImposto — subcoleção `operacao/{operacaoId}/regras/{auto-id}`.
 * Per-operação Imposto rule; the resolver's last fallback before the
 * pedido item carries no resolvable imposto (in which case emission
 * fails loudly).
 *
 * Matching arrays use OR semantics: a rule matches an item when ANY of
 * its produtoUid / categoriaUid / NCM appears in the rule's respective
 * array. Empty arrays do not match (so an empty rule never fires).
 * When multiple rules match, the first one in the loaded order wins
 * (Flutter parity — Firestore order, no priority field).
 *
 * **Wire = the legacy Flutter shape, read verbatim (#398/#423).** The
 * Firestore collection ID is `regras` (the legacy Dart getter was NAMED
 * `regraimposto`, but its collectionId was `'regras'`). Legacy docs carry
 * an UPPERCASE `CFOP` (kept here as a read fallback — the resolver folds it
 * into the engine's lowercase `cfop`), path-shaped `produtos`/`categorias`
 * entries (`produtos/<uid>`, sometimes `documents/...`-prefixed, sometimes
 * bare uids — the legacy writers were inconsistent; matching is by trailing
 * segment), and free-form NCMs (matched digits-only via `normalizeNCM`, so
 * the element schema is deliberately lenient — the MacrosTab form normalizes
 * entries and rejects non-8-digit NCMs before writing). Legacy-written docs
 * resolve natively — no migration.
 *
 * `nome` is optional but recommended for UI / audit.
 *
 * Imposto blob fields are **typed** (`taxConfigFields`, shared with the tribute
 * engine via `@delfrance/schemas`) rather than pass-through.
 *
 * Two more legacy wire fields, modeled as their own field rather than merged
 * into a new-app counterpart (same posture as the `CFOP`/`cfop` pair above —
 * a consumer that needs the fold does it itself, the schema just stops
 * dropping the raw value):
 * - `estados` — `List` of UF codes (`_$RegraImpostoToJson`'s
 *   `ufsOperacaoToJson`) that scopes the rule to specific interstate
 *   destinations. Not yet consumed by the resolver's match semantics
 *   (deferred to #422) — modeled here so a legacy doc round-trips.
 * - `timeStamp` (capital S) — the legacy ms-epoch creation stamp; the new
 *   editor stamps `dataCadastro` instead and never ORIGINATES a `timeStamp`
 *   (`MacrosTab` round-trips an existing one unchanged on save, same as
 *   `estados`, but mints neither on create). ⚠️ NOT auto-folded into
 *   `dataCadastro`: a legacy doc carrying only `timeStamp` still sorts as
 *   undated wherever a consumer orders by `dataCadastro` (e.g. the Macros
 *   tab's list query) — same gap the field had before this schema modeled it
 *   at all, since `dataCadastro` itself is unchanged.
 *
 * ⚠️ `NVE`/`indEscala` carry their wire types through the shared `nveField()` /
 * `indEscalaField()` (`./imposto/tribute`), whose READ-tolerant preprocess is
 * what lets an already-stored scalar still parse — see those helpers for why a
 * bare type swap would turn a failed whole-document parse into a wrong NF-e.
 * Since #466 all three tax collections share that definition, so a fold change
 * lands on every tier at once instead of drifting between them.
 */
export const regraImpostoSchema = z.object({
  id: z.string().nullable().default(null),
  nome: z.string().min(1).max(255).nullable().default(null),
  produtos: z.array(z.string()).default([]),
  categorias: z.array(z.string()).default([]),
  ncms: z.array(z.string()).default([]),
  // Dados Gerais — a rule may omit any of them; the resolver re-validates
  // via the engine `impostoSchema`. Mostly lenient strings; NVE/indEscala
  // are typed to the legacy wire (see their own comments below).
  origem: z.string().nullable().optional(),
  cfop: z.string().nullable().optional(),
  /** Legacy Flutter wire key (uppercase). Read fallback for `cfop` — never written by the new editor. */
  CFOP: z.string().nullable().optional(),
  cfopInterestadual: z.string().nullable().optional(),
  NCM: z.string().nullable().optional(),
  /** Legacy `List<String>?` wire, read-tolerant of the old scalar. See {@link nveField}. */
  NVE: nveField(),
  CEST: z.string().nullable().optional(),
  /** Legacy `bool?` wire, read-tolerant of the old scalar. See {@link indEscalaField}. */
  indEscala: indEscalaField(),
  CNPJFab: z.string().nullable().optional(),
  cBenef: z.string().nullable().optional(),
  extipi: z.string().nullable().optional(),
  unidade: z.string().nullable().optional(),
  compoeValorTotalDaNFe: z.boolean().nullable().optional(),
  /** UF codes scoping the rule to specific destinations. See class doc. */
  estados: z.array(z.string()).nullable().default(null),
  ...taxConfigFields,
  dataCadastro: millisSinceEpoch().nullable().default(null),
  /** Legacy wire key (capital S). Read fallback for `dataCadastro`. */
  timeStamp: millisSinceEpoch().nullable().default(null),
});

export type RegraImposto = z.infer<typeof regraImpostoSchema>;

export const regraImpostoMeta: CollectionMetadata = {
  collectionPath: 'operacao/{operacaoId}/regras',
  permissions: {
    read: PERM_REGRA_IMPOSTO_READ,
    write: PERM_REGRA_IMPOSTO_WRITE,
    delete: PERM_REGRA_IMPOSTO_DELETE,
  },
};

export const regraImposto = {
  schema: regraImpostoSchema,
  meta: regraImpostoMeta,
};
