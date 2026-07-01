/**
 * RTC IBS/CBS code tables — a vendored **seed** of Anexo III (`cClassTrib`) +
 * the CST IBS/CBS indicators, plus the structural CST↔cClassTrib validator
 * (NT 2025.002).
 *
 * **Pure module: no zod, no node deps.** It lives in `@delfrance/schemas`
 * alongside the tribute schemas + the other fiscal `*_LABELS`, so the shared
 * imposto editor (apps/web `RtcSection`) and the emit-time tribute schema
 * (`imposto/tribute.ts` → `parseRtcConfig`) validate against one source of truth.
 *
 * **This is a verified SEED, not the full table.** The complete ~250-code
 * Anexo III is Portal-published (SVRS "Conformidade Fácil" mirror, since
 * 06/05/2025) and changes outside the NT cycle; we vendor only the codes
 * verified against that mirror. The produto UI lets the operator **free-type**
 * any code not yet seeded (with a non-blocking warning), so a stale seed never
 * blocks a registration. Refresh routine:
 * `.claude/skills/nfe/references/sources/nt/2025/cClassTrib-CST-tables-SOURCE.md`.
 */

/** One Anexo III row (the columns we use: code + its CST + description). */
export interface CClassTribEntry {
  /** 6 digits. Its first 3 digits equal `cst` (SEFAZ structural rule). */
  readonly cClassTrib: string;
  /** 3 digits. */
  readonly cst: string;
  readonly descricao: string;
}

/**
 * CST IBS/CBS indicator codes (NT 2025.002 / IT 2025.002, "Indicadores CST").
 * Small and stable — defined by LC 214/2025. Drives the CST suggestion list.
 *
 * The descriptions are **best-effort UI hints** derived from the SVRS Anexo III
 * groupings; reconcile them against the official IT 2025.002 CST table on
 * refresh. Validation never depends on this text — only on the structural rule.
 */
export const CST_IBSCBS_LABELS: Readonly<Record<string, string>> = {
  '000': 'Tributação integral',
  '010': 'Tributação com alíquotas uniformes',
  '011': 'Tributação com alíquotas uniformes (assistência à saúde / funerária)',
  '200': 'Alíquota reduzida',
  '220': 'Tributação com alíquota fixa',
  '221': 'Tributação com alíquota fixa (proporcional)',
  '222': 'Tributação com alíquota fixa (transporte internacional de passageiros)',
  '400': 'Isenção',
  '410': 'Imunidade e não incidência',
  '510': 'Diferimento',
  '515': 'Diferimento com redução de alíquota',
  '550': 'Suspensão',
  '620': 'Tributação monofásica',
  '800': 'Transferência de crédito',
  '810': 'Crédito presumido',
  '811': 'Crédito presumido (operações de ajuste)',
  '820': 'Tributação com base em documento específico',
  '830': 'Exclusão da base de cálculo',
};

/** Sorted CST codes (the picker's suggestion list). */
export const CST_IBSCBS_CODES: readonly string[] = Object.keys(CST_IBSCBS_LABELS);

/**
 * Verified cClassTrib seed. Only codes confirmed against the SVRS mirror (with
 * their descriptions) are listed — currently the **CST-000 "tributação
 * integral" family**, which is what a Simples Nacional taxable sale uses. The
 * long tail (immunities, reductions, suspensions, …) is reached via free-entry
 * today and folded in here on the next full-table refresh.
 */
export const CCLASSTRIB_SEED: readonly CClassTribEntry[] = [
  {
    cClassTrib: '000001',
    cst: '000',
    descricao: 'Situações tributadas integralmente pelo IBS e CBS',
  },
  { cClassTrib: '000002', cst: '000', descricao: 'Exploração de via (pedágio)' },
  {
    cClassTrib: '000003',
    cst: '000',
    descricao: 'Regime automotivo — projetos incentivados (art. 311)',
  },
  {
    cClassTrib: '000004',
    cst: '000',
    descricao: 'Regime automotivo — projetos incentivados (art. 312)',
  },
  {
    cClassTrib: '000005',
    cst: '000',
    descricao: 'Operação com EAC destinado à mistura com gasolina A',
  },
];

const SEED_BY_CST = new Map<string, CClassTribEntry[]>();
const SEED_INDEX = new Map<string, CClassTribEntry>();
for (const entry of CCLASSTRIB_SEED) {
  SEED_INDEX.set(entry.cClassTrib, entry);
  const bucket = SEED_BY_CST.get(entry.cst);
  if (bucket) bucket.push(entry);
  else SEED_BY_CST.set(entry.cst, [entry]);
}

/**
 * The SEFAZ **structural** rule (RV UB13/UB14): a well-formed cClassTrib's
 * first 3 digits equal the CST. This is always correct (independent of any
 * vendored table), so it is the only check the emit-time schema enforces.
 */
export function cstClassTribStructurallyValid(cst: string, cClassTrib: string): boolean {
  return /^\d{3}$/.test(cst) && /^\d{6}$/.test(cClassTrib) && cClassTrib.slice(0, 3) === cst;
}

export type CstClassTribValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'cst-mismatch' | 'not-in-table' };

/**
 * Validate a CST↔cClassTrib pair for the **UI** (richer than the schema rule):
 * - `cst-mismatch` — fails the structural rule (will be rejected by SEFAZ).
 * - `not-in-table` — structurally valid but absent from our vendored seed; a
 *   soft signal only (the seed is a subset), never blocks emission.
 */
export function validateCstClassTrib(cst: string, cClassTrib: string): CstClassTribValidation {
  if (!cstClassTribStructurallyValid(cst, cClassTrib)) return { ok: false, reason: 'cst-mismatch' };
  if (!SEED_INDEX.has(cClassTrib)) return { ok: false, reason: 'not-in-table' };
  return { ok: true };
}

/** Seed entries for a CST (all entries when `cst` is empty). */
export function cClassTribEntriesForCst(
  cst: string | null | undefined,
): readonly CClassTribEntry[] {
  if (!cst) return CCLASSTRIB_SEED;
  return SEED_BY_CST.get(cst) ?? [];
}

/** Seed cClassTrib codes for a CST (the Autocomplete suggestion list). */
export function cClassTribCodesForCst(cst: string | null | undefined): string[] {
  return cClassTribEntriesForCst(cst).map((e) => e.cClassTrib);
}

/** Description for a seeded cClassTrib (null when the code isn't in the seed). */
export function cClassTribDescricao(cClassTrib: string | null | undefined): string | null {
  if (!cClassTrib) return null;
  return SEED_INDEX.get(cClassTrib)?.descricao ?? null;
}
