/**
 * Simples Nacional tributary engine.
 *
 * Public entry points for the NF-e orchestrator:
 *
 *   - `buildImpostoXml(imposto, item)`  per-item `<imposto>` XML
 *   - `aggregateTotals(items)`          ICMSTot aggregation
 *   - `buildTotalXml(totals)`           `<total>` XML
 *   - `buildTranspXml(opts?)`           `<transp>` XML
 *   - `buildPagXml(payments)`           `<pag>` XML
 *
 * Schema mirrors of the Flutter Imposto + ConfiguracaoICMS + confPIS /
 * confCOFINS live in `./schemas` — the orchestrator can `.parse()` raw
 * Firestore data through them at the boundary.
 *
 * Scope: **Simples Nacional only** (CSOSN 101–900). Regime Normal CST
 * is Phase D; the dispatcher throws `NFeTributeError` if a non-SN CRT
 * arrives.
 */
export { buildImpostoXml, NFeTributeError } from './imposto';
export {
  aggregateISSQN,
  aggregateRetTrib,
  aggregateTotals,
  buildTotalXml,
  type ISSQNExtras,
  type RtcTotalSummary,
  type TotalAggregation,
} from './total';
export {
  buildIBSCBS,
  buildIS,
  computeRtcItemValues,
  rtcTestRatesForYear,
  type RtcItemValues,
} from './rtc';
export {
  CCLASSTRIB_SEED,
  CST_IBSCBS_CODES,
  CST_IBSCBS_LABELS,
  cClassTribCodesForCst,
  cClassTribDescricao,
  cClassTribEntriesForCst,
  cstClassTribStructurallyValid,
  validateCstClassTrib,
  type CClassTribEntry,
  type CstClassTribValidation,
} from './cclasstrib';
export { buildTranspXml, modFreteSchema, type ModFrete } from './transp';
export { buildPagXml, paymentSchema, tPagSchema, type Payment, type TPag } from './pag';
export {
  TributeFormatError,
  fmtMoney,
  fmtMoneyOpt,
  fmtQuantity,
  fmtRate,
  fmtRateOpt,
  fmtUnitValue,
  fmtUnitValueOpt,
  roundReais,
} from './format';
export {
  configuracaoIBSCBSSchema,
  configuracaoISRtcSchema,
  cstIpiSchema,
  cstPisCofinsSchema,
  configuracaoICMSSchema,
  configuracaoIPISchema,
  configuracaoISSQNSchema,
  confPISSchema,
  confCOFINSSchema,
  crtSchema,
  csosnSchema,
  impostoSchema,
  indISSSchema,
  indIncentivoSchema,
  IPI_TRIB_CSTS,
  modBCSchema,
  modBCSTSchema,
  origemSchema,
  retencaoSchema,
  tributeItemSchema,
  type ConfCOFINS,
  type ConfPIS,
  type ConfiguracaoIBSCBS,
  type ConfiguracaoICMS,
  type ConfiguracaoIPI,
  type ConfiguracaoISRtc,
  type ConfiguracaoISSQN,
  type Crt,
  type Csosn,
  type CstIpi,
  type Imposto,
  type IndISS,
  type IndIncentivo,
  type ModBC,
  type ModBCST,
  type Origem,
  type Retencao,
  type TributeItem,
} from './schemas';
