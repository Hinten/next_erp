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
  aggregateTotals,
  buildTotalXml,
  type TotalAggregation,
} from './total';
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
  round2,
} from './format';
export {
  cstPisCofinsSchema,
  configuracaoICMSSchema,
  confPISSchema,
  confCOFINSSchema,
  crtSchema,
  csosnSchema,
  impostoSchema,
  modBCSchema,
  modBCSTSchema,
  origemSchema,
  tributeItemSchema,
  type ConfCOFINS,
  type ConfPIS,
  type ConfiguracaoICMS,
  type Crt,
  type Csosn,
  type Imposto,
  type ModBC,
  type ModBCST,
  type Origem,
  type TributeItem,
} from './schemas';
