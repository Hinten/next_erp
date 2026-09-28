/**
 * Per-item `<imposto>` builder.
 *
 * Dispatches on `imposto.configuracaoICMS.csosn` for Simples Nacional
 * (CRT='1' or '2'), constructs the matching wire-shape ICMS variant
 * (`ICMSSN101` … `ICMSSN900`), wraps it with PIS + COFINS, and emits
 * the XML via the same `serializeFragment` the rest of the package uses.
 *
 * Mirrors `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:_getICMS`
 * (lines 990–1109).
 *
 * The CONFIG-level rules are not decided here. Which CRT, CSOSN, sub-config and
 * complete XSD sub-groups an ICMS config needs, and which PIS/COFINS group a
 * CST and its rates select, are decided, as verdicts, in `@delfrance/schemas`
 * (`src/imposto/regrasDeEmissao.ts`: `vereditoIcmsSn`, `vereditoPisCofins`,
 * `usaIssqn`), browser-safe, so the web imposto editor can check the same
 * rules before a save (#1655). This module formats a non-ok verdict into its
 * `NFeTributeError` and builds the XML from an ok one; only the item-level
 * rule (a per-unit rate needs the item `qTrib`) stays here. Throws
 * `NFeTributeError` on:
 *   - CRT='3' (Regime Normal — Phase D)
 *   - CRT='4' (MEI)
 *   - missing CSOSN
 *   - missing required sub-config for the active CSOSN
 *   - incomplete XSD sub-group (CSOSN 201/202/203/500/900)
 *   - neither an ICMS nor an ISSQN config
 *   - an imposto or item that fails its schema (an unknown CSOSN, say)
 *   - a PIS/COFINS config the XSD cannot carry: CST 01/02 without its rate,
 *     CST 03 without `vAliqProd`, a rate that does not fit TDec_0302a04, a
 *     per-unit rate without the item `qTrib`, or a CST 49–99 config with BOTH
 *     a percent and a per-unit rate
 *   - an incomplete/invalid `configuracaoIBSCBS` while `emitRtc` is on
 *     (thrown by `rtc.ts`)
 */
import type { z } from 'zod';

import { fmtMoney, fmtMoneyOpt, fmtQuantity, fmtRate, fmtRateOpt, roundReais } from './format';
import {
  type ConfCOFINS,
  type ConfPIS,
  type ConfiguracaoICMS,
  type ConfiguracaoIPI,
  type ConfiguracaoISSQN,
  type CstPisCofins,
  type IcmsSnEmitivel,
  type Imposto,
  type Origem,
  type TributeItem,
  type VereditoIcmsSn,
  type VereditoPisCofins,
  CRT,
  CSOSN,
  IPI_TRIB_CSTS,
  impostoSchema,
  tributeItemSchema,
  usaIssqn,
  vereditoIcmsSn,
  vereditoPisCofins,
} from './schemas';
import type {
  TIpi,
  TNFe_infNFe_det_imposto,
  TNFe_infNFe_det_imposto_ICMS,
  TNFe_infNFe_det_imposto_ISSQN,
  TNFe_infNFe_det_imposto_COFINS,
  TNFe_infNFe_det_imposto_COFINS_COFINSOutr,
  TNFe_infNFe_det_imposto_PIS,
  TNFe_infNFe_det_imposto_PIS_PISAliq,
  TNFe_infNFe_det_imposto_PIS_PISNT,
  TNFe_infNFe_det_imposto_PIS_PISOutr,
  TNFe_infNFe_det_imposto_PIS_PISQtde,
} from '../types/nfe-schema';
import { serializeFragment, type XmlValue } from '../xml';
import { NFeTributeError } from './errors';
import { buildIBSCBS, buildIS, parseRtcConfig } from './rtc';

// Declared in `./errors` (dependency-free, so `rtc.ts` can throw it too) and
// re-exported here under the same name for every existing importer.
export { NFeTributeError };

/**
 * Public entry — validates inputs, dispatches, and emits the `<imposto>` XML.
 *
 * `opts.emitRtc` gates the Reforma Tributária groups (NT 2025.002): when
 * false (the default), the emitted XML is byte-identical to the pre-RTC
 * output — the `IS` / `IBSCBS` keys are simply never set, so the META walker
 * omits them. The orchestrator flips it on per-filial.
 */
export function buildImpostoXml(
  rawImposto: unknown,
  rawItem: unknown,
  opts: { emitRtc?: boolean } = {},
): string {
  const imposto = parseInput(impostoSchema, rawImposto, 'imposto');
  const item = parseInput(tributeItemSchema, rawItem, 'item');

  // XSD xs:choice — every item carries either <ICMS> or <ISSQN>, not
  // both. Mirror the Flutter dispatcher: ISSQN wins when set, otherwise
  // require an ICMS config.
  const pis = buildPIS(imposto.configuracaoPIS, item);
  const cofins = buildCOFINS(imposto.configuracaoCOFINS, item);
  const impostoValue: TNFe_infNFe_det_imposto = usaIssqn(imposto)
    ? { ISSQN: buildISSQN(imposto.configuracaoISSQN), PIS: pis, COFINS: cofins }
    : {
        ICMS: buildICMS(requireICMSConfig(imposto.configuracaoICMS), imposto.origem),
        PIS: pis,
        COFINS: cofins,
      };
  if (imposto.configuracaoIPI != null) {
    impostoValue.IPI = buildIPI(imposto.configuracaoIPI);
  }
  // Reforma Tributária (NT 2025.002) — attached only when the orchestrator
  // opts in. `IS` and `IBSCBS` are sibling slots under <imposto> per the
  // codegen; the META walker emits them in XSD order.
  if (opts.emitRtc && imposto.configuracaoIBSCBS != null) {
    const rtc = parseRtcConfig(imposto.configuracaoIBSCBS);
    if (rtc.is != null) {
      impostoValue.IS = buildIS(rtc.is, item.vProd);
    }
    impostoValue.IBSCBS = buildIBSCBS(rtc, item.vProd);
  }
  return serializeFragment(
    'TNFe_infNFe_det_imposto',
    'imposto',
    impostoValue as unknown as XmlValue,
  );
}

// ---------------------------------------------------------------------------
// ICMS dispatcher
// ---------------------------------------------------------------------------

function requireICMSConfig(cfg: ConfiguracaoICMS | null | undefined): ConfiguracaoICMS {
  if (cfg == null) {
    throw new NFeTributeError('imposto requires either `configuracaoICMS` or `configuracaoISSQN`');
  }
  return cfg;
}

/**
 * The `<ICMS>` group. Whether the config can be emitted, and why not, is
 * `vereditoIcmsSn`'s decision (CRT, then CSOSN, then the CSOSN's sub-config,
 * then its XSD sub-groups — the first failing check wins); this function only
 * turns a refusal into its `NFeTributeError` and an ok verdict into XML.
 */
function buildICMS(config: ConfiguracaoICMS, origem: Origem): TNFe_infNFe_det_imposto_ICMS {
  const veredito = vereditoIcmsSn(config);
  switch (veredito.tipo) {
    case 'naoSimplesNacional':
      throw new NFeTributeError(crtNotImplementedMessage(veredito.crt));
    case 'semCsosn':
      throw new NFeTributeError(`CRT=${veredito.crt} requires a non-null csosn`);
    case 'subConfigAusente':
      throw new NFeTributeError(
        `CSOSN '${veredito.csosn}' requires \`configuracaoICMS.${veredito.subConfig}\``,
      );
    case 'gruposIncompletos':
      // A partial `xs:sequence minOccurs="0"` group is schema-invalid (SEFAZ
      // cStat 215), and the per-field `fmt*Opt` calls below would happily emit
      // one. Every violation lands in ONE error, in XSD order, so the operator
      // fixes them in one pass.
      throw new NFeTributeError(
        `CSOSN '${veredito.csosn}': XSD sub-groups must be emitted complete or omitted — ` +
          veredito.grupos
            .map(({ grupo, faltando }) => `${grupo} missing: ${faltando.join(', ')}`)
            .join('; '),
      );
    case 'ok':
      return buildICMSSN(veredito, origem);
  }
}

/** The refusal for a CRT outside Simples Nacional (Regime Normal / MEI — Phase D). */
function crtNotImplementedMessage(
  crt: Extract<VereditoIcmsSn, { tipo: 'naoSimplesNacional' }>['crt'],
): string {
  switch (crt) {
    case CRT.regimeNormal:
      return (
        'CRT=3 (Regime Normal) is not implemented in this engine (Phase D). ' +
        'Use Simples Nacional configs only.'
      );
    case CRT.meiSimplesNacional:
      return 'CRT=4 (MEI) is not implemented.';
  }
}

/**
 * The `ICMSSN*` variant of an emittable verdict. `switch (v.csosn)` narrows
 * `v.sub` to that CSOSN's own sub-config, already non-null and with every XSD
 * sub-group complete or absent.
 */
function buildICMSSN(v: IcmsSnEmitivel, origem: Origem): TNFe_infNFe_det_imposto_ICMS {
  switch (v.csosn) {
    case CSOSN.tributadaComCredito:
      return {
        ICMSSN101: {
          orig: origem,
          CSOSN: v.csosn,
          pCredSN: fmtRateOpt('pCredSN', v.sub.pCredSN)!,
          vCredICMSSN: fmtMoneyOpt('vCredICMSSN', v.sub.vCredICMSSN)!,
        },
      };
    case CSOSN.tributadaSemCredito:
    case CSOSN.isencaoFaixaReceitaBruta:
    case CSOSN.imune:
    case CSOSN.naoTributada:
      // ICMSSN102 covers all four: orig + CSOSN, no values.
      return { ICMSSN102: { orig: origem, CSOSN: v.csosn } };
    case CSOSN.tributadaComCreditoComSt: {
      const c = v.sub;
      return {
        ICMSSN201: {
          orig: origem,
          CSOSN: v.csosn,
          modBCST: c.modBCST,
          pMVAST: fmtRateOpt('pMVAST', c.pMVAST),
          pRedBCST: fmtRateOpt('pRedBCST', c.pRedBCST),
          vBCST: fmtMoneyOpt('vBCST', c.vBCST)!,
          pICMSST: fmtRateOpt('pICMSST', c.pICMSST)!,
          vICMSST: fmtMoneyOpt('vICMSST', c.vICMSST)!,
          vBCFCPST: fmtMoneyOpt('vBCFCPST', c.vBCFCPST),
          pFCPST: fmtRateOpt('pFCPST', c.pFCPST),
          vFCPST: fmtMoneyOpt('vFCPST', c.vFCPST),
          pCredSN: fmtRateOpt('pCredSN', c.pCredSN)!,
          vCredICMSSN: fmtMoneyOpt('vCredICMSSN', c.vCredICMSSN)!,
        },
      };
    }
    case CSOSN.tributadaSemCreditoComSt:
    case CSOSN.isencaoFaixaReceitaBrutaComSt: {
      const c = v.sub;
      return {
        ICMSSN202: {
          orig: origem,
          CSOSN: v.csosn,
          modBCST: c.modBCST,
          pMVAST: fmtRateOpt('pMVAST', c.pMVAST),
          pRedBCST: fmtRateOpt('pRedBCST', c.pRedBCST),
          vBCST: fmtMoneyOpt('vBCST', c.vBCST)!,
          pICMSST: fmtRateOpt('pICMSST', c.pICMSST)!,
          vICMSST: fmtMoneyOpt('vICMSST', c.vICMSST)!,
          vBCFCPST: fmtMoneyOpt('vBCFCPST', c.vBCFCPST),
          pFCPST: fmtRateOpt('pFCPST', c.pFCPST),
          vFCPST: fmtMoneyOpt('vFCPST', c.vFCPST),
        },
      };
    }
    case CSOSN.icmsCobradoAnteriormente: {
      const c = v.sub;
      return {
        ICMSSN500: {
          orig: origem,
          CSOSN: v.csosn,
          vBCSTRet: fmtMoneyOpt('vBCSTRet', c.vBCSTRet),
          pST: fmtRateOpt('pST', c.pST),
          vICMSSubstituto: fmtMoneyOpt('vICMSSubstituto', c.vICMSSubstituto),
          vICMSSTRet: fmtMoneyOpt('vICMSSTRet', c.vICMSSTRet),
          vBCFCPSTRet: fmtMoneyOpt('vBCFCPSTRet', c.vBCFCPSTRet),
          pFCPSTRet: fmtRateOpt('pFCPSTRet', c.pFCPSTRet),
          vFCPSTRet: fmtMoneyOpt('vFCPSTRet', c.vFCPSTRet),
          pRedBCEfet: fmtRateOpt('pRedBCEfet', c.pRedBCEfet),
          vBCEfet: fmtMoneyOpt('vBCEfet', c.vBCEfet),
          pICMSEfet: fmtRateOpt('pICMSEfet', c.pICMSEfet),
          vICMSEfet: fmtMoneyOpt('vICMSEfet', c.vICMSEfet),
        },
      };
    }
    case CSOSN.outros: {
      const c = v.sub;
      return {
        ICMSSN900: {
          orig: origem,
          CSOSN: v.csosn,
          modBC: c.modBC ?? undefined,
          vBC: fmtMoneyOpt('vBC', c.vBC),
          pRedBC: fmtRateOpt('pRedBC', c.pRedBC),
          pICMS: fmtRateOpt('pICMS', c.pICMS),
          vICMS: fmtMoneyOpt('vICMS', c.vICMS),
          modBCST: c.modBCST ?? undefined,
          pMVAST: fmtRateOpt('pMVAST', c.pMVAST),
          pRedBCST: fmtRateOpt('pRedBCST', c.pRedBCST),
          vBCST: fmtMoneyOpt('vBCST', c.vBCST),
          pICMSST: fmtRateOpt('pICMSST', c.pICMSST),
          vICMSST: fmtMoneyOpt('vICMSST', c.vICMSST),
          vBCFCPST: fmtMoneyOpt('vBCFCPST', c.vBCFCPST),
          pFCPST: fmtRateOpt('pFCPST', c.pFCPST),
          vFCPST: fmtMoneyOpt('vFCPST', c.vFCPST),
          pCredSN: fmtRateOpt('pCredSN', c.pCredSN),
          vCredICMSSN: fmtMoneyOpt('vCredICMSSN', c.vCredICMSSN),
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// IPI dispatcher
// ---------------------------------------------------------------------------

/**
 * Build the per-item `<IPI>` block from a `ConfiguracaoIPI`. The XSD
 * has `<IPI>` carrying `<cEnq>` then exactly one of `<IPITrib>` (CSTs
 * 00/49/50/99 — tributado, requires `vIPI`) or `<IPINT>` (every other
 * CST — não tributado, only CST). `vIPI` is required for the tributado
 * variant, and the XSD `<xs:choice>` after `<CST>` mandates exactly one
 * complete pair — `(vBC + pIPI)` (por valor) or `(qUnid + vUnid)` (por
 * quantidade) — never both and never a half pair, enforced here.
 */
function buildIPI(cfg: ConfiguracaoIPI): TIpi {
  if (IPI_TRIB_CSTS.has(cfg.CST)) {
    if (cfg.vIPI == null) {
      throw new NFeTributeError(`IPI CST=${cfg.CST} (IPITrib) requires \`vIPI\``);
    }
    // XSD `<IPITrib>` mandates an `<xs:choice>` after `<CST>`: exactly one of
    // the `(vBC + pIPI)` sequence (por valor) or the `(qUnid + vUnid)` sequence
    // (por quantidade) — never both, never a half pair. Enforce it here so a
    // doomed shape fails at build time rather than being rejected by SEFAZ.
    const hasVBC = cfg.vBC != null;
    const hasPIPI = cfg.pIPI != null;
    const hasQUnid = cfg.qUnid != null;
    const hasVUnid = cfg.vUnid != null;
    const byValue = hasVBC || hasPIPI;
    const byQuantity = hasQUnid || hasVUnid;
    if (byValue && byQuantity) {
      throw new NFeTributeError(
        `IPI CST=${cfg.CST} (IPITrib) must carry exactly one of \`(vBC + pIPI)\` or \`(qUnid + vUnid)\`, not both`,
      );
    }
    if (!byValue && !byQuantity) {
      throw new NFeTributeError(
        `IPI CST=${cfg.CST} (IPITrib) requires exactly one complete pair: \`(vBC + pIPI)\` or \`(qUnid + vUnid)\``,
      );
    }
    if (byValue && !(hasVBC && hasPIPI)) {
      throw new NFeTributeError(
        `IPI CST=${cfg.CST} (IPITrib) por valor requires both \`vBC\` and \`pIPI\` (missing \`${hasVBC ? 'pIPI' : 'vBC'}\`)`,
      );
    }
    if (byQuantity && !(hasQUnid && hasVUnid)) {
      throw new NFeTributeError(
        `IPI CST=${cfg.CST} (IPITrib) por quantidade requires both \`qUnid\` and \`vUnid\` (missing \`${hasQUnid ? 'vUnid' : 'qUnid'}\`)`,
      );
    }
    const ipiTrib: TIpi['IPITrib'] = {
      CST: cfg.CST as '00' | '49' | '50' | '99',
      vIPI: fmtMoneyOpt('vIPI', cfg.vIPI)!,
    };
    if (byValue) {
      ipiTrib.vBC = fmtMoneyOpt('vBC', cfg.vBC)!;
      ipiTrib.pIPI = fmtRateOpt('pIPI', cfg.pIPI)!;
    } else {
      ipiTrib.qUnid = fmtQuantity('qUnid', cfg.qUnid!);
      ipiTrib.vUnid = fmtQuantity('vUnid', cfg.vUnid!);
    }
    return { cEnq: cfg.cEnq, IPITrib: ipiTrib };
  }
  return {
    cEnq: cfg.cEnq,
    IPINT: {
      CST: cfg.CST as '01' | '02' | '03' | '04' | '05' | '51' | '52' | '53' | '54' | '55',
    },
  };
}

// ---------------------------------------------------------------------------
// ISSQN dispatcher
// ---------------------------------------------------------------------------

/**
 * Build the per-item `<ISSQN>` block. The XSD requires vBC, vAliq,
 * vISSQN, cMunFG (7-digit IBGE code of the service location),
 * cListServ (Lei Complementar 116/2003 code, e.g. `'01.05'`), indISS
 * (1-7) and indIncentivo (1=sim, 2=não). The optional fields ride
 * along only when set on the per-item config.
 */
function buildISSQN(cfg: ConfiguracaoISSQN): TNFe_infNFe_det_imposto_ISSQN {
  const out: TNFe_infNFe_det_imposto_ISSQN = {
    vBC: fmtMoney('vBC', cfg.vBC),
    vAliq: fmtRate('vAliq', cfg.vAliq),
    vISSQN: fmtMoney('vISSQN', cfg.vISSQN),
    cMunFG: cfg.cMunFG,
    cListServ: cfg.cListServ,
    indISS: cfg.indISS,
    indIncentivo: cfg.indIncentivo,
  };
  const vDeducao = fmtMoneyOpt('vDeducao', cfg.vDeducao);
  if (vDeducao != null) out.vDeducao = vDeducao;
  const vOutro = fmtMoneyOpt('vOutro', cfg.vOutro);
  if (vOutro != null) out.vOutro = vOutro;
  const vDescIncond = fmtMoneyOpt('vDescIncond', cfg.vDescIncond);
  if (vDescIncond != null) out.vDescIncond = vDescIncond;
  const vDescCond = fmtMoneyOpt('vDescCond', cfg.vDescCond);
  if (vDescCond != null) out.vDescCond = vDescCond;
  const vISSRet = fmtMoneyOpt('vISSRet', cfg.vISSRet);
  if (vISSRet != null) out.vISSRet = vISSRet;
  if (cfg.cServico != null) out.cServico = cfg.cServico;
  if (cfg.cMun != null) out.cMun = cfg.cMun;
  if (cfg.cPais != null) out.cPais = cfg.cPais;
  if (cfg.nProcesso != null) out.nProcesso = cfg.nProcesso;
  return out;
}

// ---------------------------------------------------------------------------
// PIS / COFINS dispatchers
// ---------------------------------------------------------------------------

// The CSTs each group carries, read off the codegen — i.e. the XSD's own
// enumerations. COFINS enumerates the same four sets as PIS.
type CstPisCofinsAliq = TNFe_infNFe_det_imposto_PIS_PISAliq['CST'];
type CstPisCofinsQtde = TNFe_infNFe_det_imposto_PIS_PISQtde['CST'];
type CstPisCofinsNT = TNFe_infNFe_det_imposto_PIS_PISNT['CST'];
type CstPisCofinsOutr = TNFe_infNFe_det_imposto_PIS_PISOutr['CST'];

/** PISOutr / COFINSOutr's `xs:choice` after `<CST>`: exactly one base sequence. */
type PisCofinsOutrBase =
  | { readonly modo: 'valor'; readonly vBC: number; readonly aliquota: number }
  | { readonly modo: 'quantidade'; readonly qBCProd: number; readonly vAliqProd: number };

/**
 * One PIS or COFINS item computation: which XSD group, its operands and its
 * value. `cst` keeps the switch-narrowed wire literal, so the builders map it
 * onto the codegen types without a cast.
 */
type PisCofinsCalc =
  | { readonly grupo: 'NT'; readonly cst: CstPisCofinsNT; readonly valor: 0 }
  | {
      readonly grupo: 'Aliq';
      readonly cst: CstPisCofinsAliq;
      readonly vBC: number;
      readonly aliquota: number;
      readonly valor: number;
    }
  | {
      readonly grupo: 'Qtde';
      readonly cst: CstPisCofinsQtde;
      readonly qBCProd: number;
      readonly vAliqProd: number;
      readonly valor: number;
    }
  | {
      readonly grupo: 'Outr';
      readonly cst: CstPisCofinsOutr;
      readonly base: PisCofinsOutrBase;
      readonly valor: number;
    };

type PisCofinsTributo = 'PIS' | 'COFINS';

/**
 * The per-unit groups' `qBCProd` is the item quantity (the det's `<qTrib>`,
 * "Quantidade Vendida" per NT 2011/004) — never a default of 1, which would
 * silently tax one unit of a multi-unit line.
 */
function requireQTrib(tributo: PisCofinsTributo, cst: CstPisCofins, item: TributeItem): number {
  if (item.qTrib == null) {
    throw new NFeTributeError(
      `${tributo} CST=${cst} por unidade (vAliqProd) requires the item quantity \`qTrib\``,
    );
  }
  return item.qTrib;
}

/**
 * The ONE PIS/COFINS computation — the item builders and
 * {@link computePisCofinsItemValues} both read it, so the emitted `<vPIS>` /
 * `<vCOFINS>` and every total summed from the helper cannot drift apart.
 *
 * Which group the config selects, and which configs the XSD cannot carry, is
 * `vereditoPisCofins`'s decision (`@delfrance/schemas`): CST 01/02 without its
 * rate, CST 03 without `vAliqProd`, a rate of 1000 or more (TDec_0302a04 has
 * at most three integer digits, and the stored schema has no upper bound — so
 * this fails at build time, where the batch pre-flight turns it into a
 * per-member 400, instead of at the pre-send XSD gate after a número was
 * allocated), and a CST 49–99 config with both rates. This function turns a
 * refusal into its `NFeTributeError` and computes an ok verdict.
 *
 * Every value is computed from the RAW configured operands and only the result
 * is rounded (`roundReais`) — the convention `computeRtcItemValues` / IS share.
 * The wire shows the operands at 4 decimals, so an operand with more decimals
 * can make the visible product differ from the emitted value by a cent; no
 * SEFAZ rule compares them, only Σ items against ICMSTot (602/603).
 *
 * - **Aliq (01/02)**: `vBC` = the item base, `valor` = vBC × rate / 100.
 * - **Qtde (03)**: `qBCProd` = the item `qTrib`, `valor` = qBCProd × vAliqProd.
 *   A missing `qTrib` throws.
 * - **NT (04–09)**: no value.
 * - **Outr (49–99)**: the XSD `xs:choice` — `(vBC + rate)` or
 *   `(qBCProd + vAliqProd)`, never both. A rate counts as configured only when
 *   it is > 0 (stored docs legitimately hold an explicit 0, e.g. for the Shopee
 *   `tax_info` block). Neither configured emits the zero `(vBC + rate)` shape,
 *   which the XSD requires even when nothing is due.
 *
 * Both `vBC` and `qBCProd` are DERIVED from the item — `confPIS`/`confCOFINS`
 * carry only `{ CST, rate, vAliqProd }` — so a config-level half pair cannot
 * exist; the only reachable half is a per-unit rate with no `qTrib`, the one
 * rule the config alone cannot decide.
 */
function calcPisCofins(
  tributo: PisCofinsTributo,
  cst: CstPisCofins,
  aliquota: number | null | undefined,
  vAliqProd: number | null | undefined,
  item: TributeItem,
): PisCofinsCalc {
  const rateName = tributo === 'PIS' ? 'pPIS' : 'pCOFINS';
  const veredito = vereditoPisCofins(cst, aliquota, vAliqProd);
  switch (veredito.tipo) {
    case 'aliquotaAusente':
      throw new NFeTributeError(`${tributo} CST=${veredito.cst} requires \`${rateName}\``);
    case 'vAliqProdAusente':
      throw new NFeTributeError(`${tributo} CST=${veredito.cst} requires \`vAliqProd\``);
    case 'aliquotaForaDoFormato':
      throw new NFeTributeError(
        `${tributo} CST=${veredito.cst}: \`${rateName}\` ${veredito.aliquota} does not fit the XSD rate ` +
          'format (TDec_0302a04, at most 999.9999)',
      );
    case 'ambasAliquotas':
      // Mirrors buildIPI's IPITrib choice: a doomed shape fails at build
      // time rather than as a SEFAZ schema rejection.
      throw new NFeTributeError(
        `${tributo} CST=${veredito.cst} (${tributo}Outr) must carry exactly one of ` +
          `\`(vBC + ${rateName})\` or \`(qBCProd + vAliqProd)\`, not both — ` +
          `configure \`${rateName}\` or \`vAliqProd\``,
      );
    case 'ok':
      return calcPisCofinsGrupo(tributo, veredito, item);
  }
}

/** The value of an ok PIS/COFINS verdict, on this item. */
function calcPisCofinsGrupo(
  tributo: PisCofinsTributo,
  veredito: Extract<VereditoPisCofins, { tipo: 'ok' }>,
  item: TributeItem,
): PisCofinsCalc {
  switch (veredito.grupo) {
    case 'NT':
      // Não tributado — the group carries the CST alone.
      return { grupo: 'NT', cst: veredito.cst, valor: 0 };
    case 'Aliq': {
      const { cst, aliquota } = veredito;
      // vBC = the item base (Simples Nacional common posture).
      const vBC = item.vProd;
      return { grupo: 'Aliq', cst, vBC, aliquota, valor: roundReais((vBC * aliquota) / 100) };
    }
    case 'Qtde': {
      const { cst, vAliqProd } = veredito;
      const qBCProd = requireQTrib(tributo, cst, item);
      return { grupo: 'Qtde', cst, qBCProd, vAliqProd, valor: roundReais(qBCProd * vAliqProd) };
    }
    case 'Outr': {
      const { cst, base } = veredito;
      switch (base.modo) {
        case 'quantidade': {
          const { vAliqProd } = base;
          const qBCProd = requireQTrib(tributo, cst, item);
          return {
            grupo: 'Outr',
            cst,
            base: { modo: 'quantidade', qBCProd, vAliqProd },
            valor: roundReais(qBCProd * vAliqProd),
          };
        }
        case 'valor': {
          const { aliquota } = base;
          const vBC = item.vProd;
          return {
            grupo: 'Outr',
            cst,
            base: { modo: 'valor', vBC, aliquota },
            valor: roundReais((vBC * aliquota) / 100),
          };
        }
        case 'zero':
          // Nothing configured: the XSD still demands one choice branch before
          // <vPIS>/<vCOFINS> (omitting it fails "vPIS not expected, expected vBC
          // or qBCProd"), so emit the value branch with zeros.
          return { grupo: 'Outr', cst, base: { modo: 'valor', vBC: 0, aliquota: 0 }, valor: 0 };
      }
    }
  }
}

function calcPIS(cfg: ConfPIS, item: TributeItem): PisCofinsCalc {
  return calcPisCofins('PIS', cfg.CST, cfg.pPIS, cfg.vAliqProd, item);
}

function calcCOFINS(cfg: ConfCOFINS, item: TributeItem): PisCofinsCalc {
  return calcPisCofins('COFINS', cfg.CST, cfg.pCOFINS, cfg.vAliqProd, item);
}

/**
 * Per-item `vPIS` / `vCOFINS` — the exact values `buildImpostoXml` emits for
 * the same config and item, and the single source for any caller that must
 * agree with them (the ICMSTot sums SEFAZ checks against the items, 602/603).
 * A null config is the SN default (PISNT/COFINSNT CST 07), which carries no
 * value: 0. Throws `NFeTributeError` exactly where the builder would.
 */
export function computePisCofinsItemValues(
  imposto: Imposto,
  item: TributeItem,
): { vPIS: number; vCOFINS: number } {
  const pis = imposto.configuracaoPIS;
  const cofins = imposto.configuracaoCOFINS;
  return {
    vPIS: pis == null ? 0 : calcPIS(pis, item).valor,
    vCOFINS: cofins == null ? 0 : calcCOFINS(cofins, item).valor,
  };
}

function buildPIS(cfg: ConfPIS | null | undefined, item: TributeItem): TNFe_infNFe_det_imposto_PIS {
  // Default for SN: PIS NT (CST 07 — não tributado).
  if (cfg == null) return { PISNT: { CST: '07' } };
  const calc = calcPIS(cfg, item);
  switch (calc.grupo) {
    case 'NT':
      return { PISNT: { CST: calc.cst } };
    case 'Aliq':
      return {
        PISAliq: {
          CST: calc.cst,
          vBC: fmtMoney('vBC', calc.vBC),
          pPIS: fmtRate('pPIS', calc.aliquota),
          vPIS: fmtMoney('vPIS', calc.valor),
        },
      };
    case 'Qtde':
      return {
        PISQtde: {
          CST: calc.cst,
          qBCProd: fmtQuantity('qBCProd', calc.qBCProd),
          vAliqProd: fmtQuantity('vAliqProd', calc.vAliqProd),
          vPIS: fmtMoney('vPIS', calc.valor),
        },
      };
    case 'Outr': {
      // Exactly one choice sequence; the META walker emits XSD order.
      const outr: TNFe_infNFe_det_imposto_PIS_PISOutr = {
        CST: calc.cst,
        vPIS: fmtMoney('vPIS', calc.valor),
      };
      if (calc.base.modo === 'valor') {
        outr.vBC = fmtMoney('vBC', calc.base.vBC);
        outr.pPIS = fmtRate('pPIS', calc.base.aliquota);
      } else {
        outr.qBCProd = fmtQuantity('qBCProd', calc.base.qBCProd);
        outr.vAliqProd = fmtQuantity('vAliqProd', calc.base.vAliqProd);
      }
      return { PISOutr: outr };
    }
  }
}

function buildCOFINS(
  cfg: ConfCOFINS | null | undefined,
  item: TributeItem,
): TNFe_infNFe_det_imposto_COFINS {
  // Default for SN: COFINS NT (CST 07).
  if (cfg == null) return { COFINSNT: { CST: '07' } };
  const calc = calcCOFINS(cfg, item);
  switch (calc.grupo) {
    case 'NT':
      return { COFINSNT: { CST: calc.cst } };
    case 'Aliq':
      return {
        COFINSAliq: {
          CST: calc.cst,
          vBC: fmtMoney('vBC', calc.vBC),
          pCOFINS: fmtRate('pCOFINS', calc.aliquota),
          vCOFINS: fmtMoney('vCOFINS', calc.valor),
        },
      };
    case 'Qtde':
      return {
        COFINSQtde: {
          CST: calc.cst,
          qBCProd: fmtQuantity('qBCProd', calc.qBCProd),
          vAliqProd: fmtQuantity('vAliqProd', calc.vAliqProd),
          vCOFINS: fmtMoney('vCOFINS', calc.valor),
        },
      };
    case 'Outr': {
      // Same XSD choice as PISOutr above.
      const outr: TNFe_infNFe_det_imposto_COFINS_COFINSOutr = {
        CST: calc.cst,
        vCOFINS: fmtMoney('vCOFINS', calc.valor),
      };
      if (calc.base.modo === 'valor') {
        outr.vBC = fmtMoney('vBC', calc.base.vBC);
        outr.pCOFINS = fmtRate('pCOFINS', calc.base.aliquota);
      } else {
        outr.qBCProd = fmtQuantity('qBCProd', calc.base.qBCProd);
        outr.vAliqProd = fmtQuantity('vAliqProd', calc.base.vAliqProd);
      }
      return { COFINSOutr: outr };
    }
  }
}

// ---------------------------------------------------------------------------
// Input parsing helper (wraps Zod errors)
// ---------------------------------------------------------------------------

function parseInput<T>(schema: z.ZodType<T>, raw: unknown, name: string): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new NFeTributeError(
    `Invalid ${name}: ${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'parse failed'}`,
  );
}

// (z + format helpers imported at the top of the file)
export { TributeFormatError } from './format';
