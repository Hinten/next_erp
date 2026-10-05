/**
 * **`tax_info` — the Brazilian tax block, built from ONE resolved `Imposto`.**
 *
 * `add_item` / `update_item` carry an optional `tax_info` object. On a BR shop
 * Shopee validates it **all-or-nothing**: a block missing one member is refused
 * with `error_param` and the detail *"all BR tax field should be empty or be
 * filled at same time"*. So there are exactly two legitimate outcomes, and this
 * module answers only those two — **the whole block, or no block at all**.
 *
 * That is Lucas's Q2 decision, and it is the reason every "missing" path here
 * ends in a {@link MotivoTaxInfoOmitido} rather than in a placeholder. A
 * partial block would not degrade gracefully; it would be *refused*, taking the
 * whole listing with it.
 *
 * ## The TEN members, and the ICMS one is regime-parameterised
 *
 * `ncm`, `cest`, `origin`, **`csosn` XOR `icms_cst`**, `pis`, `cofins`,
 * `pis_cofins_cst`, `same_state_cfop`, `diff_state_cfop`, `measure_unit`.
 * Exactly one of `csosn` / `icms_cst` is ever present — chosen by
 * `configuracaoICMS.crt` — so the emitted object always has ten keys, never
 * nine and never eleven.
 *
 * ⚠️ **The key set is CONSTANT by construction.** Under an all-or-nothing
 * validator a key set that varies with the data is exactly what makes "the BR
 * set" untestable: one produto would send eleven keys and another ten, and only
 * one of them would be refused. `Object.keys(taxInfo)` is therefore pinned by a
 * test, not by a convention.
 *
 * ## What is NEVER sent, and why no code path can send it
 *
 * `operation_type`, `export_cfop` and `federal_state_taxes` are the three
 * **seller constants** — values that describe the SHOP, not the produto.
 * Lucas's Q2b cut them: they would have been guesses injected through a config
 * module nobody could fill correctly, and a guessed constant inside an
 * all-or-nothing block fails the block for every produto at once. Sending them
 * is tracked as a follow-up (**#1610**) and is deliberately NOT a TODO here —
 * the fields are absent from {@link TaxInfoShopee}, so adding one is a type
 * error rather than an omission somebody has to remember.
 *
 * Also never sent, for the same key-set-constancy reason: `ex_tipi`
 * (`imposto.extipi` exists and the legacy Flutter exporter sent it, but the
 * documentation gives no evidence it is a BR-set member, and a key present only
 * when the data happens to carry it is the variable key set above), `fci_num`,
 * `recopi_num`, `additional_info`, `group_item_info`, `tax_type` (TW),
 * `invoice_option` / `vat_rate` (PL), `hs_code` / `tax_code` (IN).
 *
 * ⚠️ **UNVERIFIED (registers 67/68).** *Which* fields the BR validator counts
 * is still unmeasured. The 2026-09-17 sandbox probe accepted both a full
 * ten-member block and the same block minus `cofins`, and the read-back carried
 * no `tax_info` at all — the SG test shop does not exercise the BR validator.
 * The ten-member set is therefore the documentation's, not the wire's.
 *
 * ## The three legacy traps, each one a live defect
 *
 * 1. `pis` is a **percentage** (`configuracaoPIS.pPIS`). The Flutter exporter
 *    sent `vAliqProd` — a per-unit monetary value, a sibling field one
 *    character away on the same schema — which produces a plausible-looking
 *    wrong number nothing would ever flag.
 * 2. `cofins` was sent as `null`, **always**, which made every legacy block
 *    permanently partial.
 * 3. `pis_cofins_cst` was the literal `'99'`, with the legacy's own comment
 *    admitting it did not know where the value came from. Here it is the CST
 *    the two configs **agree** on, and a disagreement refuses the block rather
 *    than silently preferring PIS's.
 *
 * ## Folds
 *
 * Two functions here decide that two values are "the same", and neither reaches
 * for one of the repo's inventoried equivalence helpers — a pt-BR decimal reader
 * on a wire that wants a dot is the concrete hazard, and the import would
 * additionally pull this file into that inventory.
 * {@link formatarPercentual} folds every number within half a centesimal to one
 * string (its rounding is the canonical `roundReais`, which is not such a
 * helper; see its own docblock for why it is not `.toFixed(2)` either);
 * {@link cstConcordante} folds two CST codes to one only on exact equality, by
 * hand. Each has a PAIR test and a NEAR-MISS test.
 *
 * ## Purity
 *
 * No clock, no Firestore, no Shopee call. The `Imposto` arrives already
 * resolved — `lerImpostoDoProduto.ts` is the reader, and it is the only module
 * of this pair that touches a database.
 */
import { roundReais } from '@delfrance/core/money';
import {
  CRT,
  type ConfCOFINS,
  type ConfPIS,
  type CstPisCofins,
  type Imposto,
} from '@delfrance/schemas';

import { MEASURE_UNIT_SHOPEE, SEM_CEST_SHOPEE, SEM_NCM_SHOPEE } from './constantesAnuncio';

/**
 * The BR block exactly as the request body carries it — **every value a
 * string**, ten keys, no optionals beyond the regime XOR.
 *
 * The two ICMS members are declared optional so the XOR is expressible; exactly
 * one of them is present on every value this module builds, and
 * {@link montarTaxInfo} is the only producer.
 */
export interface TaxInfoShopee {
  readonly ncm: string;
  readonly cest: string;
  readonly origin: string;
  /** Simples Nacional (CRT 1 / 2 / 4). Mutually exclusive with {@link TaxInfoShopee.icms_cst}. */
  readonly csosn?: string;
  /** Regime Normal (CRT 3). Mutually exclusive with {@link TaxInfoShopee.csosn}. */
  readonly icms_cst?: string;
  readonly pis: string;
  readonly cofins: string;
  readonly pis_cofins_cst: string;
  readonly same_state_cfop: string;
  readonly diff_state_cfop: string;
  readonly measure_unit: string;
}

/**
 * Why the block was omitted.
 *
 * ⚠️ **Persisted** — it reaches the link document's `taxInfoOmitido` and a 422
 * body — so it is not free to rename, and a member nothing can produce is
 * forbidden (the `kit-nao-importado` rule in `produtos/errosImportacao.ts`).
 *
 * Nine of the eleven are produced by {@link montarTaxInfo} and each has a
 * fixture in this module's suite. The other two are produced elsewhere, on
 * purpose:
 *
 * - `sem-operacao` — by `lerImpostoDoProduto.ts`, when the conta carries no
 *   `operacaoOuterRef` or the operação document is gone. There is no operação
 *   to see from inside a pure mapper.
 * - `recusado-incompleto` — by the publisher's ONE-SHOT `tax_info` retry: when
 *   Shopee refuses a block we believed complete, the identical body is re-sent
 *   **minus the `tax_info` key**, at most once, and the listing records this
 *   member. That retry lives in `anuncios/publicarAnuncio.ts` and is the only
 *   thing that may write this value.
 */
export type MotivoTaxInfoOmitido =
  | 'sem-operacao'
  | 'sem-imposto'
  | 'sem-icms'
  | 'sem-csosn'
  | 'sem-cst-icms'
  | 'sem-pis'
  | 'sem-cofins'
  | 'cst-pis-cofins-divergente'
  | 'sem-cfop'
  | 'sem-cfop-interestadual'
  | 'recusado-incompleto';

/**
 * Named members of {@link MotivoTaxInfoOmitido}. Producers write
 * `MOTIVO_TAX_INFO_OMITIDO.semPis`, never the raw slug — the key↔slug pairing
 * is pinned by a test, so a typo is a compile error on one side and a red test
 * on the other.
 */
export const MOTIVO_TAX_INFO_OMITIDO = {
  semOperacao: 'sem-operacao',
  semImposto: 'sem-imposto',
  semIcms: 'sem-icms',
  semCsosn: 'sem-csosn',
  semCstIcms: 'sem-cst-icms',
  semPis: 'sem-pis',
  semCofins: 'sem-cofins',
  cstPisCofinsDivergente: 'cst-pis-cofins-divergente',
  semCfop: 'sem-cfop',
  semCfopInterestadual: 'sem-cfop-interestadual',
  recusadoIncompleto: 'recusado-incompleto',
} as const satisfies Record<string, MotivoTaxInfoOmitido>;

/** The whole block, or the reason there is none. Never both, never neither. */
export type ResultadoTaxInfo =
  | { readonly taxInfo: TaxInfoShopee; readonly omitido: null }
  | { readonly taxInfo: null; readonly omitido: MotivoTaxInfoOmitido };

/**
 * The ICMS member the regime demands: its value when the document carries it,
 * and — always — which omission motivo applies when it does not.
 *
 * ⚠️ `motivoSeAusente` rides the SAME switch that picks the member, and that is
 * the point: the regime is tested once. A shape that answered only
 * `{csosn} | {icms_cst} | null` would force the caller to re-derive the regime
 * to name the motivo, which is two copies of one rule with a comment claiming
 * they agree.
 */
export type ResultadoMembroIcms =
  | {
      readonly membro: { readonly csosn: string } | { readonly icms_cst: string };
      readonly omitido: null;
    }
  | { readonly membro: null; readonly omitido: MotivoTaxInfoOmitido };

/**
 * Format a tax percentage for the wire: **a dot and exactly two decimals**.
 *
 * ⚠️ **Not `.toFixed(2)`, and not because of a style preference.**
 * `delfrance/no-ad-hoc-money-rounding` bans that call outright outside a short
 * allow-list of XSD/API serializers, so the rounding goes through the canonical
 * `roundReais` — which IS `Number(n.toFixed(2))`, so the result is identical
 * value for value — and only the fixed WIDTH is built here, by padding. That is
 * `pagamentoMapping.ts`'s `chaveDeOrdem` precedent in this same app, and it is
 * the honest split: the part the rule cares about (which way a x.xx5 edge
 * leans) is the shared helper's, and the part it does not (a trailing zero) is
 * a string operation.
 *
 * ⚠️ And **never** one of the repo's shared decimal readers: they are
 * inventoried equivalence-fold helpers, so two things would go wrong at once —
 * this file would join that inventory, and a pt-BR localiser would put a comma
 * on a wire that wants a dot, which Shopee refuses for the whole block.
 *
 * The fold: everything within half a centesimal collapses to one string
 * (`1.65` and `1.6500001` are both `'1.65'`); one centesimal apart stays
 * distinct (`1.654` → `'1.65'`, `1.655` → `'1.66'`). A zero rate is `'0.00'` —
 * a real value, never `''` and never `'0'`.
 *
 * Domain: a finite, non-negative rate. `confPISSchema.pPIS` is
 * `z.number().nonnegative()`, which refuses `NaN`, and no stored percentage is
 * exponential — so no scientific-notation arm is written for a value this
 * module cannot receive.
 */
export function formatarPercentual(n: number): string {
  const arredondado = roundReais(n);
  const [inteiro = '0', fracao = ''] = String(arredondado).split('.');
  return `${inteiro}.${fracao.padEnd(2, '0')}`;
}

/**
 * The single CST the PIS and COFINS configs agree on, or `null` when they
 * disagree.
 *
 * ⚠️ **Exact `===`, and the disagreement refuses the whole block.** Both values
 * come from the same Zod enum, so there is no case folding, no padding and no
 * `'01'`/`'1'` ambiguity to absorb — the enum has no `'1'`. Taking PIS's value
 * when the two differ is the tempting shortcut and it is exactly the legacy
 * behaviour this module exists to replace: a fiscal code invented at the wire.
 */
export function cstConcordante(pis: CstPisCofins, cofins: CstPisCofins): string | null {
  return pis === cofins ? pis : null;
}

/**
 * The regime XOR — **TOTAL over `crtSchema`'s four members**.
 *
 * CRT 3 (Regime Normal) sends `icms_cst`; CRT 1, 2 and 4 (the Simples Nacional
 * family) send `csosn`. The seller is CRT 1 today, so the `icms_cst` arm never
 * fires in production — it is here because a mapper that throws on a regime it
 * "cannot see" fails the day an operator changes the operação.
 *
 * Takes the field as the `Imposto` declares it (nullable and optional), so a
 * missing `configuracaoICMS` is answered here rather than at every call site.
 */
export function membroIcms(cfg: Imposto['configuracaoICMS']): ResultadoMembroIcms {
  if (cfg == null) return { membro: null, omitido: MOTIVO_TAX_INFO_OMITIDO.semIcms };

  if (cfg.crt === CRT.regimeNormal) {
    const cst = cfg.cst;
    if (cst == null) return { membro: null, omitido: MOTIVO_TAX_INFO_OMITIDO.semCstIcms };
    return { membro: { icms_cst: cst }, omitido: null };
  }

  const csosn = cfg.csosn;
  if (csosn == null) return { membro: null, omitido: MOTIVO_TAX_INFO_OMITIDO.semCsosn };
  return { membro: { csosn }, omitido: null };
}

/** The `{ taxInfo: null }` arm, spelled once so every refusal has one shape. */
function omitir(omitido: MotivoTaxInfoOmitido): ResultadoTaxInfo {
  return { taxInfo: null, omitido };
}

/**
 * Build the BR block from one resolved {@link Imposto}, or say why there is
 * none. **Pure** — no reads, no clock, no constants parameter.
 *
 * The checks run in BR-set order and the FIRST missing member decides the
 * motivo, so the answer is stable and an operator sees the first thing to fix
 * rather than an arbitrary one.
 *
 * ⚠️ `ncm` and `cest` are the two members that cannot refuse: `'00'` is
 * Shopee's own documented escape for both, and the placeholder is only ever
 * reached when the OTHER eight members are present — an incomplete block is
 * omitted whole, never patched field by field. No left-padding either: a
 * resolved `Imposto` cannot carry a six-digit NCM (the schema's regex is eight
 * digits), so padding would only ever mask a value the schema already refused.
 */
export function montarTaxInfo(imposto: Imposto | null): ResultadoTaxInfo {
  if (imposto == null) return omitir(MOTIVO_TAX_INFO_OMITIDO.semImposto);

  const icms = membroIcms(imposto.configuracaoICMS);
  if (icms.membro == null) return omitir(icms.omitido);

  const pis: ConfPIS | null = imposto.configuracaoPIS ?? null;
  if (pis == null || pis.pPIS == null) return omitir(MOTIVO_TAX_INFO_OMITIDO.semPis);

  const cofins: ConfCOFINS | null = imposto.configuracaoCOFINS ?? null;
  if (cofins == null || cofins.pCOFINS == null) return omitir(MOTIVO_TAX_INFO_OMITIDO.semCofins);

  const cst = cstConcordante(pis.CST, cofins.CST);
  if (cst == null) return omitir(MOTIVO_TAX_INFO_OMITIDO.cstPisCofinsDivergente);

  const cfop = imposto.cfop;
  if (cfop == null) return omitir(MOTIVO_TAX_INFO_OMITIDO.semCfop);

  const cfopInterestadual = imposto.cfopInterestadual;
  if (cfopInterestadual == null) return omitir(MOTIVO_TAX_INFO_OMITIDO.semCfopInterestadual);

  return {
    taxInfo: {
      ncm: imposto.NCM ?? SEM_NCM_SHOPEE,
      cest: imposto.CEST ?? SEM_CEST_SHOPEE,
      origin: imposto.origem,
      ...icms.membro,
      pis: formatarPercentual(pis.pPIS),
      cofins: formatarPercentual(cofins.pCOFINS),
      pis_cofins_cst: cst,
      same_state_cfop: cfop,
      diff_state_cfop: cfopInterestadual,
      measure_unit: MEASURE_UNIT_SHOPEE,
    },
    omitido: null,
  };
}
