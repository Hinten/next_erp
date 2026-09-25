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
 *   - incomplete XSD sub-group (CSOSN 201/202/203/500/900)
 *   - unknown CSOSN value
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
  type Origem,
  type TributeItem,
  CRT,
  CST_PIS_COFINS,
  IPI_TRIB_CSTS,
  impostoSchema,
  tributeItemSchema,
} from './schemas';
import type {
  TIpi,
  TNFe_infNFe_det_imposto,
  TNFe_infNFe_det_imposto_ICMS,
  TNFe_infNFe_det_imposto_ISSQN,
  TNFe_infNFe_det_imposto_COFINS,
  TNFe_infNFe_det_imposto_PIS,
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
  const impostoValue: TNFe_infNFe_det_imposto =
    imposto.configuracaoISSQN != null
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
 * One `xs:sequence minOccurs="0"` sub-group of an ICMSSN variant, named by
 * the sub-config's own field names (typed, so a misspelt member fails
 * typecheck). `required` are the group's members without `minOccurs="0"`;
 * `optional` are the ones with it. An optional member still opens the group,
 * so on its own it forces every required member.
 */
type XsdGroup<T> = {
  label: string;
  required: readonly (keyof T & string)[];
  optional?: readonly (keyof T & string)[];
};

type ConfICMSSN201 = NonNullable<ConfiguracaoICMS['csosn201']>;
type ConfICMSSN202ou203 = NonNullable<ConfiguracaoICMS['csosn202ou203']>;
type ConfICMSSN500 = NonNullable<ConfiguracaoICMS['csosn500']>;
type ConfICMSSN900 = NonNullable<ConfiguracaoICMS['csosn900']>;

// The group tables below transcribe `generated/moc7.0/schemas/leiauteNFe_v4.00.xsd`
// — the XSD `validateXsd` and SEFAZ enforce, so it is the authority. Line
// ranges cite that file; each table lists its groups in XSD document order.

/**
 * FCP-ST (Fundo de Combate à Pobreza retido por ST): ICMSSN201 xsd:4016-4032,
 * ICMSSN202 xsd:4122-4138, ICMSSN900 xsd:4345-4361 (nested inside the ST
 * sequence there — see ICMSSN900_GROUPS).
 */
const FCP_ST_GROUP = {
  label: 'FCP-ST',
  required: ['vBCFCPST', 'pFCPST', 'vFCPST'],
} as const satisfies XsdGroup<ConfICMSSN201 | ConfICMSSN202ou203 | ConfICMSSN900>;

/** ICMSSN500 (xsd:4142-4230): three independent optional sub-groups. */
const ICMSSN500_GROUPS = [
  // xsd:4167-4188
  {
    label: 'ICMS-ST retido',
    required: ['vBCSTRet', 'pST', 'vICMSSTRet'],
    optional: ['vICMSSubstituto'],
  },
  // xsd:4189-4205
  { label: 'FCP-ST retido', required: ['vBCFCPSTRet', 'pFCPSTRet', 'vFCPSTRet'] },
  // xsd:4206-4227
  { label: 'ICMS efetivo', required: ['pRedBCEfet', 'vBCEfet', 'pICMSEfet', 'vICMSEfet'] },
] as const satisfies ReadonlyArray<XsdGroup<ConfICMSSN500>>;

/**
 * ICMSSN900 (xsd:4231-4377). The FCP-ST sequence is NESTED inside the ICMS-ST
 * one (xsd:4345-4361 within 4295-4362), so its trio is listed as optional
 * members of 'ICMS-ST' — an FCP-ST member with no ST group is schema-invalid —
 * and keeps its own all-or-nothing group besides.
 */
const ICMSSN900_GROUPS = [
  // xsd:4255-4294
  {
    label: 'ICMS próprio',
    required: ['modBC', 'vBC', 'pICMS', 'vICMS'],
    optional: ['pRedBC'],
  },
  // xsd:4295-4362
  {
    label: 'ICMS-ST',
    required: ['modBCST', 'vBCST', 'pICMSST', 'vICMSST'],
    optional: ['pMVAST', 'pRedBCST', 'vBCFCPST', 'pFCPST', 'vFCPST'],
  },
  FCP_ST_GROUP,
  // xsd:4363-4374
  { label: 'crédito SN', required: ['pCredSN', 'vCredICMSSN'] },
] as const satisfies ReadonlyArray<XsdGroup<ConfICMSSN900>>;

/**
 * Every `xs:sequence minOccurs="0"` sub-group is all-or-nothing on the wire:
 * absent is legal, complete is legal, anything in between is schema-invalid.
 * The individual `fmtMoneyOpt` / `fmtRateOpt` calls would happily emit a
 * partial group (only the non-null members), which SEFAZ rejects (cStat 215).
 * Fail fast at build time instead, before any field is formatted, naming the
 * CSOSN, each incomplete group and its missing required members — every
 * violation in one error, in XSD order, so the operator fixes them in one pass.
 *
 * Presence is `!= null`: 0 and '0' are legitimate values (the schema is
 * nonnegative; `modBC` '0' is a real modalidade), so they count as present.
 */
function assertXsdGroupsComplete<T extends object>(
  csosn: string,
  cfg: T,
  groups: ReadonlyArray<XsdGroup<T>>,
): void {
  const isPresent = (field: keyof T & string): boolean => cfg[field] != null;
  const violations: string[] = [];
  for (const group of groups) {
    const missing = group.required.filter((field) => !isPresent(field));
    if (missing.length === 0) continue; // complete
    const opened = missing.length < group.required.length || (group.optional ?? []).some(isPresent);
    if (!opened) continue; // absent
    violations.push(`${group.label} missing: ${missing.join(', ')}`);
  }
  if (violations.length > 0) {
    throw new NFeTributeError(
      `CSOSN '${csosn}': XSD sub-groups must be emitted complete or omitted — ` +
        violations.join('; '),
    );
  }
}

function buildICMS(config: ConfiguracaoICMS, origem: Origem): TNFe_infNFe_det_imposto_ICMS {
  if (config.crt === CRT.regimeNormal) {
    throw new NFeTributeError(
      'CRT=3 (Regime Normal) is not implemented in this engine (Phase D). ' +
        'Use Simples Nacional configs only.',
    );
  }
  if (config.crt === CRT.meiSimplesNacional) {
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
      assertXsdGroupsComplete('201', c, [FCP_ST_GROUP]);
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
        throw new NFeTributeError(`CSOSN '${csosn}' requires \`configuracaoICMS.csosn202ou203\``);
      }
      assertXsdGroupsComplete(csosn, c, [FCP_ST_GROUP]);
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
      assertXsdGroupsComplete('500', c, ICMSSN500_GROUPS);
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
      assertXsdGroupsComplete('900', c, ICMSSN900_GROUPS);
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

function buildPIS(cfg: ConfPIS | null | undefined, item: TributeItem): TNFe_infNFe_det_imposto_PIS {
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
    case CST_PIS_COFINS.tributavelAliquotaBasica:
    case CST_PIS_COFINS.tributavelAliquotaDiferenciada: {
      // PISAliq — needs vBC + pPIS + vPIS. vBC = vProd (Simples Nacional
      // common posture); pPIS from config; vPIS = vBC × pPIS / 100.
      if (cfg.pPIS == null) {
        throw new NFeTributeError(`PIS CST=${cfg.CST} requires \`pPIS\``);
      }
      const vBC = item.vProd;
      const vPIS = roundReais((vBC * cfg.pPIS) / 100);
      return {
        PISAliq: {
          CST: cfg.CST,
          vBC: fmtMoneyOpt('vBC', vBC)!,
          pPIS: fmtRateOpt('pPIS', cfg.pPIS)!,
          vPIS: fmtMoneyOpt('vPIS', vPIS)!,
        },
      };
    }
    case CST_PIS_COFINS.tributavelAliquotaPorUnidade: {
      // PISQtde — by quantity (vAliqProd × qBCProd).
      if (cfg.vAliqProd == null) {
        throw new NFeTributeError('PIS CST=03 requires `vAliqProd`');
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
    case CST_PIS_COFINS.tributavelMonofasicaRevendaAliquotaZero:
    case CST_PIS_COFINS.tributavelSubstituicaoTributaria:
    case CST_PIS_COFINS.tributavelAliquotaZero:
    case CST_PIS_COFINS.isentaContribuicao:
    case CST_PIS_COFINS.semIncidenciaContribuicao:
    case CST_PIS_COFINS.suspensaoContribuicao: {
      // PISNT — não tributado.
      return { PISNT: { CST: cfg.CST } };
    }
    case CST_PIS_COFINS.outrasOperacoesSaida:
    case CST_PIS_COFINS.creditoExclusivoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoExclusivoNaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoExclusivoExportacao:
    case CST_PIS_COFINS.creditoTributadaENaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoNaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoTributadaENaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoExclusivoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoExclusivoNaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoExclusivoExportacao:
    case CST_PIS_COFINS.creditoPresumidoTributadaENaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoNaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoTributadaENaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoOutrasOperacoes:
    case CST_PIS_COFINS.aquisicaoSemDireitoCredito:
    case CST_PIS_COFINS.aquisicaoComIsencao:
    case CST_PIS_COFINS.aquisicaoComSuspensao:
    case CST_PIS_COFINS.aquisicaoAliquotaZero:
    case CST_PIS_COFINS.aquisicaoSemIncidencia:
    case CST_PIS_COFINS.aquisicaoSubstituicaoTributaria:
    case CST_PIS_COFINS.outrasOperacoesEntrada:
    case CST_PIS_COFINS.outrasOperacoes: {
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

function buildCOFINSByCST(cfg: ConfCOFINS, item: TributeItem): TNFe_infNFe_det_imposto_COFINS {
  switch (cfg.CST) {
    case CST_PIS_COFINS.tributavelAliquotaBasica:
    case CST_PIS_COFINS.tributavelAliquotaDiferenciada: {
      if (cfg.pCOFINS == null) {
        throw new NFeTributeError(`COFINS CST=${cfg.CST} requires \`pCOFINS\``);
      }
      const vBC = item.vProd;
      const vCOFINS = roundReais((vBC * cfg.pCOFINS) / 100);
      return {
        COFINSAliq: {
          CST: cfg.CST,
          vBC: fmtMoneyOpt('vBC', vBC)!,
          pCOFINS: fmtRateOpt('pCOFINS', cfg.pCOFINS)!,
          vCOFINS: fmtMoneyOpt('vCOFINS', vCOFINS)!,
        },
      };
    }
    case CST_PIS_COFINS.tributavelAliquotaPorUnidade: {
      if (cfg.vAliqProd == null) {
        throw new NFeTributeError('COFINS CST=03 requires `vAliqProd`');
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
    case CST_PIS_COFINS.tributavelMonofasicaRevendaAliquotaZero:
    case CST_PIS_COFINS.tributavelSubstituicaoTributaria:
    case CST_PIS_COFINS.tributavelAliquotaZero:
    case CST_PIS_COFINS.isentaContribuicao:
    case CST_PIS_COFINS.semIncidenciaContribuicao:
    case CST_PIS_COFINS.suspensaoContribuicao:
      return { COFINSNT: { CST: cfg.CST } };
    // All remaining cases fall through to COFINSOutr (credit/presumed + acquisition + others)
    case CST_PIS_COFINS.outrasOperacoesSaida:
    case CST_PIS_COFINS.creditoExclusivoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoExclusivoNaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoExclusivoExportacao:
    case CST_PIS_COFINS.creditoTributadaENaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoNaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoTributadaENaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoExclusivoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoExclusivoNaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoExclusivoExportacao:
    case CST_PIS_COFINS.creditoPresumidoTributadaENaoTributadaMercadoInterno:
    case CST_PIS_COFINS.creditoPresumidoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoNaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoTributadaENaoTributadaMercadoInternoEExportacao:
    case CST_PIS_COFINS.creditoPresumidoOutrasOperacoes:
    case CST_PIS_COFINS.aquisicaoSemDireitoCredito:
    case CST_PIS_COFINS.aquisicaoComIsencao:
    case CST_PIS_COFINS.aquisicaoComSuspensao:
    case CST_PIS_COFINS.aquisicaoAliquotaZero:
    case CST_PIS_COFINS.aquisicaoSemIncidencia:
    case CST_PIS_COFINS.aquisicaoSubstituicaoTributaria:
    case CST_PIS_COFINS.outrasOperacoesEntrada:
    case CST_PIS_COFINS.outrasOperacoes:
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
