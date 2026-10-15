/**
 * RTC IBS/CBS code tables — Anexo III (`cClassTrib`) and the CST IBS/CBS
 * indicator table (NT 2025.002), plus the structural CST↔cClassTrib validator.
 *
 * **Pure module: no zod, no node deps.** It lives in `@delfrance/schemas`
 * alongside the tribute schemas + the other fiscal `*_LABELS`, so the shared
 * imposto editor (apps/web `RtcSection`) and the emit-time tribute schema
 * (`imposto/tribute.ts` → `parseRtcConfig`) validate against one source of truth.
 *
 * The data itself is a dated snapshot of the public SVRS "Conformidade Fácil"
 * table, filtered to the rows valid for NF-e — see `cclasstrib.data.ts` for the
 * provenance. SEFAZ revises it outside the NT cycle, so table MEMBERSHIP is only
 * ever a UI warning: the emit-time check is the structural rule alone, and the
 * operator can still free-type a code the snapshot does not know yet.
 */
import { CCLASSTRIB_TABELA, CST_IBSCBS_TABELA } from './cclasstrib.data';

export { CCLASSTRIB_PROVENIENCIA, CCLASSTRIB_TABELA, CST_IBSCBS_TABELA } from './cclasstrib.data';

/** Where a vendored RTC table came from, and how much of it we kept. */
export interface ProvenienciaTabelaRtc {
  readonly fonte: string;
  /** YYYY-MM-DD the page was read. */
  readonly obtidoEm: string;
  /** YYYY-MM-DD of the newest row publication the page carried, when it says. */
  readonly publicadoAte: string | null;
  /** The subset kept, in words (e.g. the DF-e filter). */
  readonly filtro: string | null;
  /** Row count after the filter — pinned by the integrity test. */
  readonly linhas: number;
}

/**
 * CST-level indicators — which IBS/CBS groups a CST requires or forbids. Named
 * after the NT's `ind_g*` columns; the SVRS field each one is read from is in
 * the comment, so a refresh can map a renamed column back.
 */
export const IND_CST_IBSCBS = {
  /** `IndExigeTrib` — the item carries `gIBSCBS` (`ind_gIBSCBS`). */
  exigeTributacao: 'exigeTributacao',
  /** `IndReducaoBc` — redução de base de cálculo. */
  reducaoBC: 'reducaoBC',
  /** `IndReducaoAliq` — `gRed` (`ind_gRed`). */
  reducaoAliquota: 'reducaoAliquota',
  /** `IndTransferenciaCred` — `gTransfCred` (`ind_gTransfCred`). */
  transferenciaCredito: 'transferenciaCredito',
  /** `IndDiferimento` — `gDif` (`ind_gDif`). */
  diferimento: 'diferimento',
  /** `IndMonofasica` — `gIBSCBSMono` (`ind_gIBSCBSMono`). */
  monofasica: 'monofasica',
  /** `IndCredPresIbsZfm` — `gCredPresIBSZFM` (`ind_gCredPresIBSZFM`). */
  credPresIbsZfm: 'credPresIbsZfm',
  /** `IndAjusteCompet` — `gAjusteCompet` (`ind_gAjusteCompet`). */
  ajusteCompetencia: 'ajusteCompetencia',
} as const;
export type IndicadorCstIbsCbs = (typeof IND_CST_IBSCBS)[keyof typeof IND_CST_IBSCBS];

/** cClassTrib-level indicators (SVRS field in each comment). */
export const IND_CCLASSTRIB = {
  /** `IndTribRegular` — `gTribRegular` (`ind_gTribRegular`). */
  tribRegular: 'tribRegular',
  /** `IndPermiteCredPres` — `gCredPresOper` is allowed, never required. */
  credPresOper: 'credPresOper',
  /** `IndEstornoCred` — `gEstornoCred` (`ind_gEstornoCred`). */
  estornoCred: 'estornoCred',
  /** `IndMonoVal` — `gMonoPadrao` (`ind_gMonoPadrao`). */
  monoPadrao: 'monoPadrao',
  /** `IndMonoRetem` — `gMonoReten` (`ind_gMonoReten`). */
  monoRetencao: 'monoRetencao',
  /** `IndMonoRet` — `gMonoRet` (`ind_gMonoRet`). */
  monoRetido: 'monoRetido',
  /** `IndMonoDif` — `gMonoDif` (`ind_gMonoDif`). */
  monoDiferimento: 'monoDiferimento',
  /** `IndPbioDiferenca` — biocombustível percentage-difference rows. */
  pBioDiferenca: 'pBioDiferenca',
} as const;
export type IndicadorCClassTrib = (typeof IND_CCLASSTRIB)[keyof typeof IND_CCLASSTRIB];

/** Tipo de alíquota of a cClassTrib (SVRS `TipoAliq`, labels from the page's filter). */
export const TIPO_ALIQUOTA_RTC = {
  fixa: 1,
  padrao: 2,
  semAliquota: 3,
  uniformeNacional: 4,
  uniformeSetorial: 5,
} as const;
export type TipoAliquotaRtc = (typeof TIPO_ALIQUOTA_RTC)[keyof typeof TIPO_ALIQUOTA_RTC];

export const TIPO_ALIQUOTA_RTC_LABELS: Readonly<Record<TipoAliquotaRtc, string>> = {
  1: 'Fixa',
  2: 'Padrão',
  3: 'Sem Alíquota',
  4: 'Uniforme Nacional',
  5: 'Uniforme Setorial',
};

/** One CST IBS/CBS row. */
export interface CstIbsCbsEntry {
  /** 3 digits. */
  readonly cst: string;
  /** The official CST name, verbatim. */
  readonly descricao: string;
  readonly ind: readonly IndicadorCstIbsCbs[];
}

/** One Anexo III row valid for NF-e. */
export interface CClassTribEntry {
  /** 6 digits. Its first 3 digits equal `cst` (SEFAZ structural rule). */
  readonly cClassTrib: string;
  /** 3 digits. */
  readonly cst: string;
  /** The page's "Descrição Reduzida" (whitespace-folded). */
  readonly descricao: string;
  readonly tipoAliquota: TipoAliquotaRtc;
  /** Percentual de redução da alíquota do IBS (0–100). */
  readonly pRedIBS: number;
  /** Percentual de redução da alíquota da CBS (0–100). */
  readonly pRedCBS: number;
  readonly ind: readonly IndicadorCClassTrib[];
  /** YYYY-MM-DD the code became valid. */
  readonly inicioVigencia: string;
}

/**
 * CST IBS/CBS labels — the OFFICIAL names, derived from the table so the two
 * cannot drift. Drives the CST picker.
 */
export const CST_IBSCBS_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CST_IBSCBS_TABELA.map((e) => [e.cst, e.descricao]),
);

/** CST codes, sorted ascending (the picker's suggestion list). */
export const CST_IBSCBS_CODES: readonly string[] = Object.keys(CST_IBSCBS_LABELS).sort();

const POR_CST = new Map<string, CClassTribEntry[]>();
const POR_CODIGO = new Map<string, CClassTribEntry>();
for (const entry of CCLASSTRIB_TABELA) {
  POR_CODIGO.set(entry.cClassTrib, entry);
  const bucket = POR_CST.get(entry.cst);
  if (bucket) bucket.push(entry);
  else POR_CST.set(entry.cst, [entry]);
}
const CST_POR_CODIGO = new Map(CST_IBSCBS_TABELA.map((e) => [e.cst, e]));

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
 * - `not-in-table` — structurally valid but absent from the NF-e rows of the
 *   dated snapshot (`CCLASSTRIB_PROVENIENCIA.obtidoEm`). SEFAZ adds codes
 *   outside the NT cycle, so this is a soft signal only — never blocks emission.
 */
export function validateCstClassTrib(cst: string, cClassTrib: string): CstClassTribValidation {
  if (!cstClassTribStructurallyValid(cst, cClassTrib)) return { ok: false, reason: 'cst-mismatch' };
  if (!POR_CODIGO.has(cClassTrib)) return { ok: false, reason: 'not-in-table' };
  return { ok: true };
}

/** Table rows for a CST (all rows when `cst` is empty). */
export function cClassTribEntriesForCst(
  cst: string | null | undefined,
): readonly CClassTribEntry[] {
  if (!cst) return CCLASSTRIB_TABELA;
  return POR_CST.get(cst) ?? [];
}

/** cClassTrib codes for a CST (the Autocomplete suggestion list). */
export function cClassTribCodesForCst(cst: string | null | undefined): string[] {
  return cClassTribEntriesForCst(cst).map((e) => e.cClassTrib);
}

/** The row for a cClassTrib, or null when the snapshot does not know it. Exact match only. */
export function cClassTribEntry(cClassTrib: string | null | undefined): CClassTribEntry | null {
  if (!cClassTrib) return null;
  return POR_CODIGO.get(cClassTrib) ?? null;
}

/** Description for a known cClassTrib (null when the code isn't in the table). */
export function cClassTribDescricao(cClassTrib: string | null | undefined): string | null {
  return cClassTribEntry(cClassTrib)?.descricao ?? null;
}

/** The CST row, or null for an unknown CST. Exact match only. */
export function cstIbsCbsEntry(cst: string | null | undefined): CstIbsCbsEntry | null {
  if (!cst) return null;
  return CST_POR_CODIGO.get(cst) ?? null;
}
