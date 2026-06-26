/**
 * Tributary input schemas — the **Flutter-shape** Imposto + ConfiguracaoICMS
 * for the Simples Nacional surface.
 *
 * These mirror the Dart classes in
 * `.old/packages/operacao_fiscal/lib/src/models.dart` (`confICMSSN101` …
 * `confICMSSN900`, `confPIS`, `ConfiguracaoPISST`). Inputs carry **numbers**
 * (the way Firestore stores them); the dispatcher in `imposto.ts` converts
 * them to the SEFAZ wire shape (strings, validated by the codegen-emitted
 * `NFeSchemas` from `src/types/nfe-schema-zod.ts`).
 *
 * **Scope**: Simples Nacional only (CSOSN 101 / 102 / 103 / 201 / 202 /
 * 203 / 300 / 400 / 500 / 900). Regime Normal (CST 00 / 10 / 20 / …)
 * is a Phase D follow-up; the dispatcher throws a clear "not
 * implemented" error if a Regime Normal CST shows up here.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums (mirror Flutter enums one-to-one)
// ---------------------------------------------------------------------------

/** CRT — Código de Regime Tributário. */
export const crtSchema = z.enum(['1', '2', '3', '4']);
export type Crt = z.infer<typeof crtSchema>;

/** CSOSN codes for Simples Nacional. */
export const csosnSchema = z.enum([
  '101',
  '102',
  '103',
  '201',
  '202',
  '203',
  '300',
  '400',
  '500',
  '900',
]);
export type Csosn = z.infer<typeof csosnSchema>;

/** modBC — Modalidade de determinação da BC do ICMS. */
export const modBCSchema = z.enum(['0', '1', '2', '3']);
export type ModBC = z.infer<typeof modBCSchema>;

/** modBCST — Modalidade de determinação da BC do ICMS ST. */
export const modBCSTSchema = z.enum(['0', '1', '2', '3', '4', '5']);
export type ModBCST = z.infer<typeof modBCSTSchema>;

/** Origem da mercadoria (codegen also has this). */
export const origemSchema = z.enum(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
export type Origem = z.infer<typeof origemSchema>;

/** CST PIS / COFINS (the most common codes; full surface = ~25 codes). */
export const cstPisCofinsSchema = z.enum([
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '49',
  '50',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '70',
  '71',
  '72',
  '73',
  '74',
  '75',
  '98',
  '99',
]);
export type CstPisCofins = z.infer<typeof cstPisCofinsSchema>;

// ---------------------------------------------------------------------------
// CSOSN sub-configs (mirror Flutter confICMSSN* classes)
// ---------------------------------------------------------------------------

/** confICMSSN101 — CSOSN 101 (com permissão de crédito). */
export const confICMSSN101Schema = z.object({
  pCredSN: z.number().nonnegative(),
  vCredICMSSN: z.number().nonnegative(),
});

/** confICMSSN201 — CSOSN 201 (com crédito + ST). */
export const confICMSSN201Schema = z.object({
  pCredSN: z.number().nonnegative(),
  vCredICMSSN: z.number().nonnegative(),
  modBCST: modBCSTSchema,
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative(),
  pICMSST: z.number().nonnegative(),
  vICMSST: z.number().nonnegative(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
});

/** confICMSSN202ou203 — CSOSN 202 / 203 (ST sem crédito). */
export const confICMSSN202ou203Schema = z.object({
  modBCST: modBCSTSchema,
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative(),
  pICMSST: z.number().nonnegative(),
  vICMSST: z.number().nonnegative(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
});

/** confICMSSN500 — CSOSN 500 (ST já retido anteriormente). */
export const confICMSSN500Schema = z.object({
  vBCSTRet: z.number().nonnegative().optional().nullable(),
  pST: z.number().nonnegative().optional().nullable(),
  vICMSSubstituto: z.number().nonnegative().optional().nullable(),
  vICMSSTRet: z.number().nonnegative().optional().nullable(),
  vBCFCPSTRet: z.number().nonnegative().optional().nullable(),
  pFCPSTRet: z.number().nonnegative().optional().nullable(),
  vFCPSTRet: z.number().nonnegative().optional().nullable(),
  pRedBCEfet: z.number().nonnegative().optional().nullable(),
  vBCEfet: z.number().nonnegative().optional().nullable(),
  pICMSEfet: z.number().nonnegative().optional().nullable(),
  vICMSEfet: z.number().nonnegative().optional().nullable(),
});

/** indISS — Indicador da exigibilidade do ISS (XSD enumeration). */
export const indISSSchema = z.enum(['1', '2', '3', '4', '5', '6', '7']);
export type IndISS = z.infer<typeof indISSSchema>;

/** indIncentivo — Indicador de incentivo fiscal (1=sim, 2=não). */
export const indIncentivoSchema = z.enum(['1', '2']);
export type IndIncentivo = z.infer<typeof indIncentivoSchema>;

/** confICMSSN900 — CSOSN 900 (kitchen sink). */
export const confICMSSN900Schema = z.object({
  modBC: modBCSchema.optional().nullable(),
  vBC: z.number().nonnegative().optional().nullable(),
  pRedBC: z.number().nonnegative().optional().nullable(),
  pICMS: z.number().nonnegative().optional().nullable(),
  vICMS: z.number().nonnegative().optional().nullable(),
  modBCST: modBCSTSchema.optional().nullable(),
  pMVAST: z.number().nonnegative().optional().nullable(),
  pRedBCST: z.number().nonnegative().optional().nullable(),
  vBCST: z.number().nonnegative().optional().nullable(),
  pICMSST: z.number().nonnegative().optional().nullable(),
  vICMSST: z.number().nonnegative().optional().nullable(),
  vBCFCPST: z.number().nonnegative().optional().nullable(),
  pFCPST: z.number().nonnegative().optional().nullable(),
  vFCPST: z.number().nonnegative().optional().nullable(),
  pCredSN: z.number().nonnegative().optional().nullable(),
  vCredICMSSN: z.number().nonnegative().optional().nullable(),
});

// ---------------------------------------------------------------------------
// ConfiguracaoICMS — mirror of the Flutter class (SN surface)
// ---------------------------------------------------------------------------

/**
 * Mirror of `ConfiguracaoICMS` (`.old/packages/operacao_fiscal/lib/src/models.dart:712`).
 * Carries `crt`, the active `csosn` code, and exactly one matching sub-config.
 * Regime Normal CST fields exist on the Flutter side but are intentionally
 * out of scope here — the dispatcher throws on `crt='3'`.
 */
export const configuracaoICMSSchema = z.object({
  crt: crtSchema,
  csosn: csosnSchema.nullable(),
  csosn101: confICMSSN101Schema.optional().nullable(),
  csosn201: confICMSSN201Schema.optional().nullable(),
  csosn202ou203: confICMSSN202ou203Schema.optional().nullable(),
  csosn500: confICMSSN500Schema.optional().nullable(),
  csosn900: confICMSSN900Schema.optional().nullable(),
});
export type ConfiguracaoICMS = z.infer<typeof configuracaoICMSSchema>;

// ---------------------------------------------------------------------------
// confPIS + ConfiguracaoPISST — mirror of the Flutter classes
// ---------------------------------------------------------------------------

export const confPISSchema = z.object({
  CST: cstPisCofinsSchema,
  pPIS: z.number().nonnegative().optional().nullable(),
  vAliqProd: z.number().nonnegative().optional().nullable(),
});
export type ConfPIS = z.infer<typeof confPISSchema>;

export const confCOFINSSchema = z.object({
  CST: cstPisCofinsSchema,
  pCOFINS: z.number().nonnegative().optional().nullable(),
  vAliqProd: z.number().nonnegative().optional().nullable(),
});
export type ConfCOFINS = z.infer<typeof confCOFINSSchema>;

// ---------------------------------------------------------------------------
// configuracaoIPI — mirror of the Flutter class (per-item IPI)
// ---------------------------------------------------------------------------

/** IPI CST codes — XSD `IPITrib` (tributado) + `IPINT` (não tributado). */
export const cstIpiSchema = z.enum([
  '00',
  '01',
  '02',
  '03',
  '04',
  '05',
  '49',
  '50',
  '51',
  '52',
  '53',
  '54',
  '55',
  '99',
]);
export type CstIpi = z.infer<typeof cstIpiSchema>;

/** The set of CSTs that emit `<IPITrib>`; the rest emit `<IPINT>`. */
export const IPI_TRIB_CSTS = new Set<CstIpi>(['00', '49', '50', '99']);

/**
 * Mirror of the Flutter `ConfiguracaoIPI` slot on Imposto. Carries the
 * `cEnq` (XSD-required, 1-3 chars — Código de Enquadramento Legal,
 * typically `'999'` for "outros") and a single CST that picks the
 * `<IPITrib>` vs `<IPINT>` wire variant. Tributado fields are kept
 * optional here (the builder enforces `vIPI` when the CST is IPITrib).
 */
export const configuracaoIPISchema = z.object({
  cEnq: z.string().min(1).max(3),
  CST: cstIpiSchema,
  vBC: z.number().nonnegative().optional().nullable(),
  pIPI: z.number().nonnegative().optional().nullable(),
  qUnid: z.number().nonnegative().optional().nullable(),
  vUnid: z.number().nonnegative().optional().nullable(),
  vIPI: z.number().nonnegative().optional().nullable(),
});
export type ConfiguracaoIPI = z.infer<typeof configuracaoIPISchema>;

// ---------------------------------------------------------------------------
// configuracaoISSQN — mirror of the Flutter class (per-item ISSQN)
// ---------------------------------------------------------------------------

/**
 * Mirror of the Flutter `ConfiguracaoISSQN` slot on Imposto. Driven
 * directly by the XSD `<ISSQN>` shape — required: vBC, vAliq, vISSQN,
 * cMunFG (7-digit IBGE), cListServ (Lei Complementar 116/2003), indISS,
 * indIncentivo. The XSD makes `<imposto>` carry **either** `<ICMS>` **or**
 * `<ISSQN>` (xs:choice). When `configuracaoISSQN` is set on an item,
 * the dispatcher emits `<ISSQN>` and skips `<ICMS>`.
 */
export const configuracaoISSQNSchema = z.object({
  vBC: z.number().nonnegative(),
  vAliq: z.number().nonnegative(),
  vISSQN: z.number().nonnegative(),
  cMunFG: z.string().regex(/^\d{7}$/),
  cListServ: z.string().regex(/^\d{2}\.\d{2}$|^\d{4,5}$/),
  vDeducao: z.number().nonnegative().optional().nullable(),
  vOutro: z.number().nonnegative().optional().nullable(),
  vDescIncond: z.number().nonnegative().optional().nullable(),
  vDescCond: z.number().nonnegative().optional().nullable(),
  vISSRet: z.number().nonnegative().optional().nullable(),
  indISS: indISSSchema,
  cServico: z.string().min(1).max(20).optional().nullable(),
  cMun: z
    .string()
    .regex(/^\d{7}$/)
    .optional()
    .nullable(),
  cPais: z
    .string()
    .regex(/^\d{1,4}$/)
    .optional()
    .nullable(),
  nProcesso: z.string().min(1).max(30).optional().nullable(),
  indIncentivo: indIncentivoSchema,
});
export type ConfiguracaoISSQN = z.infer<typeof configuracaoISSQNSchema>;

// ---------------------------------------------------------------------------
// retencao — per-item retention values (rolled up into <total><retTrib>)
// ---------------------------------------------------------------------------

/**
 * Per-item retention block. Retentions surface on the NF-e at the
 * `<total><retTrib>` level (aggregator sums per-item values). The XSD
 * carries 7 wire fields: vRetPIS, vRetCOFINS, vRetCSLL, vBCIRRF, vIRRF,
 * vBCRetPrev, vRetPrev. The Flutter-parity schema keeps the matching
 * BCs (vBCPIS / vBCCOFINS / vBCCSLL) so downstream tooling has access
 * to them, but those three are not emitted to SEFAZ.
 */
export const retencaoSchema = z.object({
  vBCPIS: z.number().nonnegative().optional().nullable(),
  vRetPIS: z.number().nonnegative().optional().nullable(),
  vBCCOFINS: z.number().nonnegative().optional().nullable(),
  vRetCOFINS: z.number().nonnegative().optional().nullable(),
  vBCCSLL: z.number().nonnegative().optional().nullable(),
  vRetCSLL: z.number().nonnegative().optional().nullable(),
  vBCIRRF: z.number().nonnegative().optional().nullable(),
  vIRRF: z.number().nonnegative().optional().nullable(),
  vBCRetPrev: z.number().nonnegative().optional().nullable(),
  vRetPrev: z.number().nonnegative().optional().nullable(),
});
export type Retencao = z.infer<typeof retencaoSchema>;

// ---------------------------------------------------------------------------
// configuracaoIBSCBS — Reforma Tributária do Consumo (RTC) item-level input
// ---------------------------------------------------------------------------

/**
 * RTC `IS` (Imposto Seletivo) per-item sub-config. Optional — only goods in
 * the Anexo I NCM list. `pIS` (ad valorem over a base) OR `pISEspec` (per
 * unit, with `qTrib`) drives the value; the builder computes `vIS`.
 */
export const configuracaoISRtcSchema = z.object({
  CSTIS: z.string().regex(/^\d{3}$/),
  cClassTribIS: z.string().regex(/^\d{6}$/),
  vBCIS: z.number().nonnegative().optional().nullable(),
  pIS: z.number().nonnegative().optional().nullable(),
  pISEspec: z.number().nonnegative().optional().nullable(),
  uTrib: z.string().min(1).max(6).optional().nullable(),
  qTrib: z.number().nonnegative().optional().nullable(),
});
export type ConfiguracaoISRtc = z.infer<typeof configuracaoISRtcSchema>;

/**
 * `configuracaoIBSCBS` — the per-item **Reforma Tributária (IBS/CBS/IS)**
 * input (NT 2025.002). Mirrors the wire `TTribNFe` / `TCIBS` (codegen
 * `nfe-schema.ts`) in the Flutter-number convention: numbers in, SEFAZ
 * strings out via the dispatcher (`tribute/rtc.ts`).
 *
 * Only the **"tributação integral"** shape is modelled (CST + cClassTrib +
 * the three alíquotas); diferimento / redução / monofásica / crédito
 * presumido subgroups are deliberately out of scope (future NT-driven
 * follow-up). The CST/cClassTrib codes are validated **by pattern only** —
 * the Anexo III/IV tables are Portal-published, not vendored.
 *
 * `vBC` defaults to the item `vProd` when null (the Simples Nacional posture,
 * mirroring PIS/COFINS in `imposto.ts`). The IBS portion is split UF +
 * Município; `vIBS` is computed as their sum.
 */
export const configuracaoIBSCBSSchema = z.object({
  CST: z.string().regex(/^\d{3}$/),
  cClassTrib: z.string().regex(/^\d{6}$/),
  vBC: z.number().nonnegative().optional().nullable(),
  pIBSUF: z.number().nonnegative(),
  pIBSMun: z.number().nonnegative(),
  pCBS: z.number().nonnegative(),
  is: configuracaoISRtcSchema.optional().nullable(),
});
export type ConfiguracaoIBSCBS = z.infer<typeof configuracaoIBSCBSSchema>;

// ---------------------------------------------------------------------------
// Top-level Imposto — what `pedido.itens[i].imposto` should be
// ---------------------------------------------------------------------------

/**
 * The per-item `Imposto` blob as stamped by Flutter on
 * `pedido.itens[i].imposto`. Mirrors the Dart `Imposto` class
 * (`.old/packages/produtos/lib/src/models.dart:2848`).
 *
 * The tribute engine itself only uses `origem` + `configuracao*`. The
 * other fields (`cfop`, `cfopInterestadual`, `NCM`, `CEST`, `unidade`)
 * are stamped here so the orchestrator can read everything-fiscal from
 * a single per-item blob — matches the Flutter source of truth.
 */
export const impostoSchema = z.object({
  origem: origemSchema,
  /** CFOP for intra-state operations (4 digits, e.g. '5102'). */
  cfop: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .nullable(),
  /** CFOP for interstate operations (4 digits, e.g. '6102'). */
  cfopInterestadual: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .nullable(),
  /** NCM classification (8 digits). */
  NCM: z
    .string()
    .regex(/^\d{8}$/)
    .optional()
    .nullable(),
  /** CEST classification (7 digits) — when the product is in the CEST list. */
  CEST: z
    .string()
    .regex(/^\d{7}$/)
    .optional()
    .nullable(),
  /** Unidade comercial (e.g. 'UN'). */
  unidade: z.string().min(1).max(6).optional().nullable(),
  configuracaoICMS: configuracaoICMSSchema.optional().nullable(),
  configuracaoISSQN: configuracaoISSQNSchema.optional().nullable(),
  configuracaoPIS: confPISSchema.optional().nullable(),
  configuracaoCOFINS: confCOFINSSchema.optional().nullable(),
  configuracaoIPI: configuracaoIPISchema.optional().nullable(),
  retencao: retencaoSchema.optional().nullable(),
  /**
   * Reforma Tributária (IBS/CBS/IS) per-item config — NT 2025.002. Stored
   * **leniently** (`z.unknown`) so the resolver's `impostoSchema.safeParse`
   * never fails on a half-filled blob — a partial RTC registration must not
   * silently disable the item's whole imposto (the resolver falls through to
   * the next tier on any parse failure). The strict shape is
   * `configuracaoIBSCBSSchema`, enforced at build time by `parseRtcConfig`, and
   * only when the orchestrator opts in (`{ emitRtc: true }`, per-filial
   * `nfeConfig.emitirReformaTributaria`, off by default).
   */
  configuracaoIBSCBS: z.unknown().optional(),
});
export type Imposto = z.infer<typeof impostoSchema>;

/**
 * Per-item value context the dispatcher needs alongside the Imposto rules.
 * Fed by the orchestrator from `ItemDoPedido` (price × quantity).
 */
export const tributeItemSchema = z.object({
  /** Pre-rounded item line total: `(precoDeVenda - desconto) × qCom`. */
  vProd: z.number().nonnegative(),
});
export type TributeItem = z.infer<typeof tributeItemSchema>;
