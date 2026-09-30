/**
 * Nota de crédito / nota de débito (finNFe 5 / 6, NT 2025.002 v1.40) — the
 * fixed facts that decide how such a nota is built. Pure data plus two small
 * functions; the rules that JUDGE a nota live in `regrasDoDocumento.ts`.
 *
 *  - Which cClassTrib a tipo binds its items to (RV UB14-60/70/80): one table
 *    per direction. UB14-60's own table ("cClassTrib x tpNFCredito /
 *    tpNFDebito") is exactly their inverse, so it is DERIVED here, never typed
 *    a third time; `notaCreditoDebito.test.ts` pins that claim row by row.
 *  - Which tax groups an item may carry (RV B25-80, cStat 1001): IBS/CBS only,
 *    except the tipos whose goods physically move (crédito 03, débito 07).
 *
 * ⚠️ `tpNFCredito` 06 (retorno por recusa parcial, NT v1.40) is NOT modelled —
 * the vendored XSD predates it (see `operacao.ts`). When it arrives it joins
 * crédito 03 in `modoGruposImposto` and in the VC02-07/VC02-10 exceptions.
 */
import {
  FIN_NFE_OPERACAO,
  TP_NF_CREDITO,
  TP_NF_DEBITO,
  type TpNFCredito,
  type TpNFDebito,
} from '../operacao';
import { IND_CCLASSTRIB, IND_CST_IBSCBS, cClassTribEntry, cstIbsCbsEntry } from './cclasstrib';

/**
 * UB14-70 (cStat 1200) — the cClassTrib every item of a nota de débito must
 * carry. A tipo missing here is "Não limitar" in the NT (04 multa e juros, 06
 * pagamento antecipado).
 */
export const CCLASSTRIB_DO_TP_NF_DEBITO: Readonly<Partial<Record<TpNFDebito, string>>> = {
  [TP_NF_DEBITO.transferenciaCreditoCooperativa]: '800002',
  [TP_NF_DEBITO.anulacaoCreditoSaidaImuneIsenta]: '811001',
  [TP_NF_DEBITO.debitoNotaNaoProcessada]: '811002',
  [TP_NF_DEBITO.transferenciaCreditoSucessao]: '800001',
  [TP_NF_DEBITO.perdaEstoque]: '410030',
  [TP_NF_DEBITO.desenquadramentoSimples]: '811003',
};

/**
 * UB14-80 (cStat 1201) — the same for a nota de crédito. "Não limitar": 01
 * multa e juros, 03 retorno, 04 redução de valores (and 06, once modelled).
 */
export const CCLASSTRIB_DO_TP_NF_CREDITO: Readonly<Partial<Record<TpNFCredito, string>>> = {
  [TP_NF_CREDITO.creditoPresumidoZfm]: '810001',
  [TP_NF_CREDITO.transferenciaCreditoSucessao]: '800001',
};

/** The tipo of a nota de crédito/débito, as the two `ide` fields carry it. */
export interface TipoNotaAjuste {
  readonly finNFe: number;
  readonly tpNFDebito: TpNFDebito | null;
  readonly tpNFCredito: TpNFCredito | null;
}

/**
 * The cClassTrib this nota's tipo binds its items to (UB14-70/80), or `null`
 * when the tipo does not limit it — or the nota is not a crédito/débito, or
 * carries the wrong tipo field for its finalidade (B25.1/B25.2 report that).
 */
export function cClassTribDoTipo(t: TipoNotaAjuste): string | null {
  if (t.finNFe === FIN_NFE_OPERACAO.debito && t.tpNFDebito != null) {
    return CCLASSTRIB_DO_TP_NF_DEBITO[t.tpNFDebito] ?? null;
  }
  if (t.finNFe === FIN_NFE_OPERACAO.credito && t.tpNFCredito != null) {
    return CCLASSTRIB_DO_TP_NF_CREDITO[t.tpNFCredito] ?? null;
  }
  return null;
}

const CCLASSTRIB_VINCULADOS: ReadonlySet<string> = new Set([
  ...Object.values(CCLASSTRIB_DO_TP_NF_DEBITO),
  ...Object.values(CCLASSTRIB_DO_TP_NF_CREDITO),
]);

/**
 * UB14-60 (cStat 1202) — `true` when the cClassTrib is one that only a
 * specific nota de crédito/débito may carry (410030, 800001, 800002, 810001,
 * 811001, 811002, 811003).
 */
export function cClassTribVinculadoATipoDeNota(cClassTrib: string): boolean {
  return CCLASSTRIB_VINCULADOS.has(cClassTrib);
}

/**
 * UB14-60 (cStat 1202) — may an item with this cClassTrib ride on this nota?
 * Always `true` for a cClassTrib no tipo binds; otherwise only on the nota
 * whose tipo binds it (800001 is the one code both directions share: débito 05
 * AND crédito 05).
 */
export function cClassTribCompativelComTipo(cClassTrib: string, t: TipoNotaAjuste): boolean {
  if (!cClassTribVinculadoATipoDeNota(cClassTrib)) return true;
  return cClassTribDoTipo(t) === cClassTrib;
}

/**
 * Which `<imposto>` groups an item carries:
 *  - `completo` — the ordinary nota: ICMS or ISSQN, IPI, PIS, COFINS, and
 *    IBS/CBS when the filial emits the Reforma Tributária;
 *  - `somenteIbsCbs` — IBS/CBS (and IS) alone. RV B25-80 (cStat 1001) rejects
 *    a nota de crédito/débito carrying ICMS, ISSQN, IPI, II, PIS, PIS-ST,
 *    COFINS, COFINS-ST, ICMSUFDest or impostoDevol, except the tipos listed
 *    in {@link modoGruposImposto}.
 */
export const MODO_GRUPOS_IMPOSTO = {
  completo: 'completo',
  somenteIbsCbs: 'somenteIbsCbs',
} as const;
export type ModoGruposImposto = (typeof MODO_GRUPOS_IMPOSTO)[keyof typeof MODO_GRUPOS_IMPOSTO];

/**
 * The item tax groups of a nota, from its tipo. B25-80's exceptions are the
 * tipos whose goods physically move and so keep their ICMS: crédito 03
 * (retorno por recusa total), crédito 04 (redução de valores) and débito 07
 * (perda em estoque). Everything else of finNFe 5/6 is IBS/CBS only.
 */
export function modoGruposImposto(t: TipoNotaAjuste): ModoGruposImposto {
  if (t.finNFe === FIN_NFE_OPERACAO.credito) {
    return t.tpNFCredito === TP_NF_CREDITO.retornoRecusaTotal ||
      t.tpNFCredito === TP_NF_CREDITO.reducaoValores
      ? MODO_GRUPOS_IMPOSTO.completo
      : MODO_GRUPOS_IMPOSTO.somenteIbsCbs;
  }
  if (t.finNFe === FIN_NFE_OPERACAO.debito) {
    return t.tpNFDebito === TP_NF_DEBITO.perdaEstoque
      ? MODO_GRUPOS_IMPOSTO.completo
      : MODO_GRUPOS_IMPOSTO.somenteIbsCbs;
  }
  return MODO_GRUPOS_IMPOSTO.completo;
}

/**
 * The IBS/CBS group an item carries INSTEAD of `gIBSCBS` when its tipo binds a
 * fixed cClassTrib — none of those CSTs (410, 800, 810, 811) admits `gIBSCBS`
 * (`ind_gIBSCBS = 0`), so the adjustment group is the item's whole IBS/CBS.
 */
export const GRUPO_AJUSTE_RTC = {
  transfCred: 'gTransfCred',
  ajusteCompet: 'gAjusteCompet',
  estornoCred: 'gEstornoCred',
  credPresIBSZFM: 'gCredPresIBSZFM',
} as const;
export type GrupoAjusteRtc = (typeof GRUPO_AJUSTE_RTC)[keyof typeof GRUPO_AJUSTE_RTC];

/**
 * The adjustment group this nota's tipo puts on every item, or `null` when the
 * tipo binds no cClassTrib (the item then carries an ordinary `gIBSCBS`).
 *
 * DERIVED from the vendored Anexo III indicators (#333), never typed as a
 * tipo → group table: the cClassTrib-level `ind_gEstornoCred` (410030) wins,
 * then the CST-level `ind_gTransfCred` (800), `ind_gAjusteCompet` (811) and
 * `ind_gCredPresIBSZFM` (810). `notaCreditoDebito.test.ts` pins the result.
 */
export function grupoDeAjusteDoTipo(t: TipoNotaAjuste): GrupoAjusteRtc | null {
  const cClassTrib = cClassTribDoTipo(t);
  if (cClassTrib == null) return null;
  const entrada = cClassTribEntry(cClassTrib);
  if (entrada?.ind.includes(IND_CCLASSTRIB.estornoCred)) return GRUPO_AJUSTE_RTC.estornoCred;
  const cst = cstIbsCbsEntry(cClassTrib.slice(0, 3));
  if (cst?.ind.includes(IND_CST_IBSCBS.transferenciaCredito)) return GRUPO_AJUSTE_RTC.transfCred;
  if (cst?.ind.includes(IND_CST_IBSCBS.ajusteCompetencia)) return GRUPO_AJUSTE_RTC.ajusteCompet;
  if (cst?.ind.includes(IND_CST_IBSCBS.credPresIbsZfm)) return GRUPO_AJUSTE_RTC.credPresIBSZFM;
  return null;
}

/** `competApur` (UB113 / UB132): the apuração month, `AAAA-MM`. */
export const COMPETENCIA_AAAA_MM = /^\d{4}-(0[1-9]|1[0-2])$/;
