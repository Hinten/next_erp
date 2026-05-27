/**
 * Per-item `<imposto>` builder.
 *
 * Dispatches on `imposto.configuracaoICMS.csosn` for Simples Nacional
 * (CRT='1' or '2'), constructs the matching wire-shape ICMS variant
 * (`ICMSSN101` … `ICMSSN900`), wraps it with PIS + COFINS, and emits
 * the XML via the same `serializeFragment` the rest of the package uses.
 *
 * Mirrors `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:_getICMS`
 * (lines 990–1109). Throws `NFeTributeError` on:
 *   - CRT='3' (Regime Normal — Phase D)
 *   - CRT='4' (MEI)
 *   - missing CSOSN
 *   - missing required sub-config for the active CSOSN
 *   - unknown CSOSN value
 */
import { z } from 'zod';

import {
  fmtMoneyOpt,
  fmtQuantity,
  fmtRateOpt,
} from './format';
import {
  type ConfCOFINS,
  type ConfPIS,
  type ConfiguracaoICMS,
  type ConfiguracaoIPI,
  type Imposto,
  type Origem,
  type TributeItem,
  IPI_TRIB_CSTS,
  impostoSchema,
  tributeItemSchema,
} from './schemas';
import type {
  TIpi,
  TNFe_infNFe_det_imposto,
  TNFe_infNFe_det_imposto_ICMS,
  TNFe_infNFe_det_imposto_COFINS,
  TNFe_infNFe_det_imposto_PIS,
} from '../types/nfe-schema';
import { serializeFragment, type XmlValue } from '../xml';

export class NFeTributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeTributeError';
  }
}

/** Public entry — validates inputs, dispatches, and emits the `<imposto>` XML. */
export function buildImpostoXml(rawImposto: unknown, rawItem: unknown): string {
  const imposto = parseInput(impostoSchema, rawImposto, 'imposto');
  const item = parseInput(tributeItemSchema, rawItem, 'item');

  const icms = buildICMS(imposto.configuracaoICMS, imposto.origem);
  const pis = buildPIS(imposto.configuracaoPIS, item);
  const cofins = buildCOFINS(imposto.configuracaoCOFINS, item);

  const impostoValue: TNFe_infNFe_det_imposto = { ICMS: icms, PIS: pis, COFINS: cofins };
  if (imposto.configuracaoIPI != null) {
    impostoValue.IPI = buildIPI(imposto.configuracaoIPI);
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

function buildICMS(
  config: ConfiguracaoICMS,
  origem: Origem,
): TNFe_infNFe_det_imposto_ICMS {
  if (config.crt === '3') {
    throw new NFeTributeError(
      'CRT=3 (Regime Normal) is not implemented in this engine (Phase D). ' +
        'Use Simples Nacional configs only.',
    );
  }
  if (config.crt === '4') {
    throw new NFeTributeError('CRT=4 (MEI) is not implemented.');
  }
  // CRT='1' (Simples Nacional) or '2' (SN excesso) — both use CSOSN.

  const csosn = config.csosn;
  if (csosn == null) {
    throw new NFeTributeError(`CRT=${config.crt} requires a non-null csosn`);
  }

  switch (csosn) {
    case '101': {
      if (config.csosn101 == null) {
        throw new NFeTributeError("CSOSN '101' requires `configuracaoICMS.csosn101`");
      }
      return {
        ICMSSN101: {
          orig: origem,
          CSOSN: '101',
          pCredSN: fmtRateOpt('pCredSN', config.csosn101.pCredSN)!,
          vCredICMSSN: fmtMoneyOpt('vCredICMSSN', config.csosn101.vCredICMSSN)!,
        },
      };
    }
    case '102':
    case '103':
    case '300':
    case '400': {
      // ICMSSN102 covers all four: orig + CSOSN, no values.
      return { ICMSSN102: { orig: origem, CSOSN: csosn } };
    }
    case '201': {
      const c = config.csosn201;
      if (c == null) {
        throw new NFeTributeError("CSOSN '201' requires `configuracaoICMS.csosn201`");
      }
      return {
        ICMSSN201: {
          orig: origem,
          CSOSN: '201',
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
    case '202':
    case '203': {
      const c = config.csosn202ou203;
      if (c == null) {
        throw new NFeTributeError(
          `CSOSN '${csosn}' requires \`configuracaoICMS.csosn202ou203\``,
        );
      }
      return {
        ICMSSN202: {
          orig: origem,
          CSOSN: csosn,
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
    case '500': {
      const c = config.csosn500;
      if (c == null) {
        throw new NFeTributeError("CSOSN '500' requires `configuracaoICMS.csosn500`");
      }
      return {
        ICMSSN500: {
          orig: origem,
          CSOSN: '500',
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
    case '900': {
      const c = config.csosn900;
      if (c == null) {
        throw new NFeTributeError("CSOSN '900' requires `configuracaoICMS.csosn900`");
      }
      return {
        ICMSSN900: {
          orig: origem,
          CSOSN: '900',
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
 * variant; the other numeric fields are optional and emitted only when
 * provided.
 */
function buildIPI(cfg: ConfiguracaoIPI): TIpi {
  if (IPI_TRIB_CSTS.has(cfg.CST)) {
    if (cfg.vIPI == null) {
      throw new NFeTributeError(`IPI CST=${cfg.CST} (IPITrib) requires \`vIPI\``);
    }
    const ipiTrib: TIpi['IPITrib'] = {
      CST: cfg.CST as '00' | '49' | '50' | '99',
      vIPI: fmtMoneyOpt('vIPI', cfg.vIPI)!,
    };
    const vBC = fmtMoneyOpt('vBC', cfg.vBC);
    if (vBC != null) ipiTrib.vBC = vBC;
    const pIPI = fmtRateOpt('pIPI', cfg.pIPI);
    if (pIPI != null) ipiTrib.pIPI = pIPI;
    if (cfg.qUnid != null) ipiTrib.qUnid = fmtQuantity('qUnid', cfg.qUnid);
    if (cfg.vUnid != null) ipiTrib.vUnid = fmtQuantity('vUnid', cfg.vUnid);
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
// PIS / COFINS dispatchers
// ---------------------------------------------------------------------------

function buildPIS(
  cfg: ConfPIS | null | undefined,
  item: TributeItem,
): TNFe_infNFe_det_imposto_PIS {
  // Default for SN: PIS NT (CST 07 — não tributado).
  if (cfg == null) return { PISNT: { CST: '07' } };
  return buildPISByCST(cfg, item);
}

function buildCOFINS(
  cfg: ConfCOFINS | null | undefined,
  item: TributeItem,
): TNFe_infNFe_det_imposto_COFINS {
  // Default for SN: COFINS NT (CST 07).
  if (cfg == null) return { COFINSNT: { CST: '07' } };
  return buildCOFINSByCST(cfg, item);
}

function buildPISByCST(cfg: ConfPIS, item: TributeItem): TNFe_infNFe_det_imposto_PIS {
  switch (cfg.CST) {
    case '01':
    case '02': {
      // PISAliq — needs vBC + pPIS + vPIS. vBC = vProd (Simples Nacional
      // common posture); pPIS from config; vPIS = vBC × pPIS / 100.
      if (cfg.pPIS == null) {
        throw new NFeTributeError(`PIS CST=${cfg.CST} requires \`pPIS\``);
      }
      const vBC = item.vProd;
      const vPIS = Math.round(vBC * cfg.pPIS) / 100;
      return {
        PISAliq: {
          CST: cfg.CST,
          vBC: fmtMoneyOpt('vBC', vBC)!,
          pPIS: fmtRateOpt('pPIS', cfg.pPIS)!,
          vPIS: fmtMoneyOpt('vPIS', vPIS)!,
        },
      };
    }
    case '03': {
      // PISQtde — by quantity (vAliqProd × qBCProd).
      if (cfg.vAliqProd == null) {
        throw new NFeTributeError("PIS CST=03 requires `vAliqProd`");
      }
      return {
        PISQtde: {
          CST: '03',
          qBCProd: '1.0000',
          vAliqProd: cfg.vAliqProd.toFixed(4),
          vPIS: fmtMoneyOpt('vPIS', cfg.vAliqProd)!,
        },
      };
    }
    case '04':
    case '05':
    case '06':
    case '07':
    case '08':
    case '09': {
      // PISNT — não tributado.
      return { PISNT: { CST: cfg.CST } };
    }
    case '49':
    case '50':
    case '51':
    case '52':
    case '53':
    case '54':
    case '55':
    case '56':
    case '60':
    case '61':
    case '62':
    case '63':
    case '64':
    case '65':
    case '66':
    case '67':
    case '70':
    case '71':
    case '72':
    case '73':
    case '74':
    case '75':
    case '98':
    case '99': {
      // PISOutr — outras operações. SEFAZ XSD models PISOutr as
      // CST, then xs:choice ( vBC + pPIS | qBCProd + vAliqProd ), then vPIS.
      // Codegen-emitted type has all four as optional, but xmllint-wasm
      // (and SEFAZ) reject omitting the choice — the validator says
      // "vPIS not expected, expected vBC or qBCProd". For SN flows
      // that arrive here without a configured rate, emit the
      // value-based variant with zeros.
      return {
        PISOutr: {
          CST: cfg.CST,
          vBC: '0.00',
          pPIS: '0.0000',
          vPIS: '0.00',
        },
      };
    }
  }
}

function buildCOFINSByCST(
  cfg: ConfCOFINS,
  item: TributeItem,
): TNFe_infNFe_det_imposto_COFINS {
  switch (cfg.CST) {
    case '01':
    case '02': {
      if (cfg.pCOFINS == null) {
        throw new NFeTributeError(`COFINS CST=${cfg.CST} requires \`pCOFINS\``);
      }
      const vBC = item.vProd;
      const vCOFINS = Math.round(vBC * cfg.pCOFINS) / 100;
      return {
        COFINSAliq: {
          CST: cfg.CST,
          vBC: fmtMoneyOpt('vBC', vBC)!,
          pCOFINS: fmtRateOpt('pCOFINS', cfg.pCOFINS)!,
          vCOFINS: fmtMoneyOpt('vCOFINS', vCOFINS)!,
        },
      };
    }
    case '03': {
      if (cfg.vAliqProd == null) {
        throw new NFeTributeError("COFINS CST=03 requires `vAliqProd`");
      }
      return {
        COFINSQtde: {
          CST: '03',
          qBCProd: '1.0000',
          vAliqProd: cfg.vAliqProd.toFixed(4),
          vCOFINS: fmtMoneyOpt('vCOFINS', cfg.vAliqProd)!,
        },
      };
    }
    case '04':
    case '05':
    case '06':
    case '07':
    case '08':
    case '09':
      return { COFINSNT: { CST: cfg.CST } };
    default:
      // COFINSOutr — same XSD shape + same posture as PISOutr above:
      // emit vBC + pCOFINS + vCOFINS with zeros so xmllint-wasm /
      // SEFAZ accept the xs:choice.
      return {
        COFINSOutr: {
          CST: cfg.CST,
          vBC: '0.00',
          pCOFINS: '0.0000',
          vCOFINS: '0.00',
        },
      };
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
