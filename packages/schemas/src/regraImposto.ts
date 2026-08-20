import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { taxConfigFields } from './imposto/tribute';
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
 */
export const regraImpostoSchema = z.object({
  id: z.string().nullable().default(null),
  nome: z.string().min(1).max(255).nullable().default(null),
  produtos: z.array(z.string()).default([]),
  categorias: z.array(z.string()).default([]),
  ncms: z.array(z.string()).default([]),
  // Dados Gerais (lenient strings, optional — a rule may omit them; the
  // resolver re-validates via the engine `impostoSchema`).
  origem: z.string().nullable().optional(),
  cfop: z.string().nullable().optional(),
  /** Legacy Flutter wire key (uppercase). Read fallback for `cfop` — never written by the new editor. */
  CFOP: z.string().nullable().optional(),
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
