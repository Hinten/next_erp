import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ALIQUOTA_PIS_COFINS_LIMITE,
  GRUPOS_XSD_POR_SUBCONFIG,
  SUBCONFIG_POR_CSOSN,
  SUBCONFIGS_ICMS_SN,
  ehCrtSimplesNacional,
  usaIssqn,
  vereditoIcmsSn,
  vereditoIsRtc,
  vereditoPisCofins,
  type CrtSimplesNacional,
  type IcmsSnEmitivel,
  type VereditoIcmsSn,
  type VereditoPisCofins,
} from './regrasDeEmissao';
import {
  CRT,
  CSOSN,
  CST_PIS_COFINS,
  IND_INCENTIVO,
  IND_ISS,
  MOD_BC,
  MOD_BCST,
  confICMSSN500Schema,
  confICMSSN900Schema,
  csosnSchema,
  cstPisCofinsSchema,
  type ConfICMSSN101,
  type ConfICMSSN201,
  type ConfICMSSN202ou203,
  type ConfICMSSN500,
  type ConfICMSSN900,
  type ConfiguracaoICMS,
  type Crt,
  type Csosn,
} from './tribute';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sn(csosn: Csosn | null, extra: Partial<ConfiguracaoICMS> = {}): ConfiguracaoICMS {
  return { crt: CRT.simplesNacional, csosn, ...extra };
}

const SN101: ConfICMSSN101 = { pCredSN: 1.25, vCredICMSSN: 18.75 };
const ST_BASE = {
  modBCST: MOD_BCST.margemValorAgregado,
  vBCST: 1800,
  pICMSST: 18,
  vICMSST: 324,
} as const;
const SN201: ConfICMSSN201 = { ...SN101, ...ST_BASE };
const SN202: ConfICMSSN202ou203 = { ...ST_BASE };
const FCP_ST = { vBCFCPST: 1800, pFCPST: 2, vFCPST: 36 } as const;

const SN500_GROUP = {
  stRet: { vBCSTRet: 1500, pST: 20, vICMSSTRet: 180 },
  fcpStRet: { vBCFCPSTRet: 1500, pFCPSTRet: 2, vFCPSTRet: 30 },
  efet: { pRedBCEfet: 10, vBCEfet: 1350, pICMSEfet: 18, vICMSEfet: 243 },
} as const satisfies Record<string, ConfICMSSN500>;
const SN900_GROUP = {
  proprio: { modBC: MOD_BC.valorOperacao, vBC: 1350, pICMS: 18, vICMS: 243 },
  st: { modBCST: MOD_BCST.margemValorAgregado, vBCST: 1890, pICMSST: 18, vICMSST: 97.2 },
  fcpSt: { vBCFCPST: 1890, pFCPST: 2, vFCPST: 37.8 },
  credSN: { pCredSN: 1.25, vCredICMSSN: 18.75 },
} as const satisfies Record<string, ConfICMSSN900>;

const SN500_FULL: ConfICMSSN500 = {
  ...SN500_GROUP.stRet,
  vICMSSubstituto: 120,
  ...SN500_GROUP.fcpStRet,
  ...SN500_GROUP.efet,
};
const SN900_FULL: ConfICMSSN900 = {
  ...SN900_GROUP.proprio,
  pRedBC: 10,
  ...SN900_GROUP.st,
  pMVAST: 40,
  pRedBCST: 10,
  ...SN900_GROUP.fcpSt,
  ...SN900_GROUP.credSN,
};

/** `sub` with `field` removed (the key gone, not nulled). */
function without<T extends object>(sub: T, field: keyof T): T {
  const copy: Partial<T> = { ...sub };
  delete copy[field];
  return copy as T;
}

/** Every member of the schema set to null, then `present` on top — the stored shape. */
function nullPadded<T extends object>(shape: object, present: T): T {
  const nulls = Object.fromEntries(Object.keys(shape).map((key) => [key, null]));
  return { ...nulls, ...present } as T;
}

function veredito900(sub: ConfICMSSN900): VereditoIcmsSn {
  return vereditoIcmsSn(sn(CSOSN.outros, { csosn900: sub }));
}
function veredito500(sub: ConfICMSSN500): VereditoIcmsSn {
  return vereditoIcmsSn(sn(CSOSN.icmsCobradoAnteriormente, { csosn500: sub }));
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe('ehCrtSimplesNacional — the only Simples Nacional predicate', () => {
  it.each([CRT.simplesNacional, CRT.simplesNacionalExcessoSublimite])('CRT %s → true', (crt) => {
    expect(ehCrtSimplesNacional(crt)).toBe(true);
  });

  // Total over raw soft-read values: strict membership, no coercion.
  it.each([
    ['CRT 3 (Regime Normal)', CRT.regimeNormal],
    ['CRT 4 (MEI)', CRT.meiSimplesNacional],
    ['the number 1', 1],
    ['the number 2', 2],
    ['null', null],
    ['undefined', undefined],
    ["''", ''],
    ["' 1'", ' 1'],
    ["'01'", '01'],
  ] as const)('%s → false', (_label, crt) => {
    expect(ehCrtSimplesNacional(crt)).toBe(false);
  });

  it('narrows to CrtSimplesNacional', () => {
    const crt: Crt = CRT.simplesNacional as Crt;
    if (ehCrtSimplesNacional(crt)) expectTypeOf(crt).toEqualTypeOf<CrtSimplesNacional>();
  });
});

describe('usaIssqn — the ICMS | ISSQN xs:choice', () => {
  const issqn = {
    vBC: 500,
    vAliq: 5,
    vISSQN: 25,
    cMunFG: '3550308',
    cListServ: '01.05',
    indISS: IND_ISS.exigivel,
    indIncentivo: IND_INCENTIVO.nao,
  };

  it('an ISSQN config set → true (ISSQN wins over any ICMS config)', () => {
    expect(usaIssqn({ configuracaoISSQN: issqn, configuracaoICMS: sn(null) })).toBe(true);
  });

  it.each([
    ['null', { configuracaoISSQN: null }],
    ['undefined', { configuracaoISSQN: undefined }],
    ['absent', {}],
  ] as const)('configuracaoISSQN %s → false', (_label, imposto) => {
    expect(usaIssqn(imposto)).toBe(false);
  });

  it('narrows configuracaoISSQN to non-null', () => {
    const imposto: { configuracaoISSQN?: typeof issqn | null } = { configuracaoISSQN: issqn };
    if (usaIssqn(imposto)) {
      expectTypeOf(imposto.configuracaoISSQN).toEqualTypeOf<typeof issqn>();
    }
  });
});

// ---------------------------------------------------------------------------
// ICMS Simples Nacional
// ---------------------------------------------------------------------------

describe('SUBCONFIG_POR_CSOSN / GRUPOS_XSD_POR_SUBCONFIG — one table each', () => {
  it('names a slot (or null) for every CSOSN the schema accepts', () => {
    expect(Object.keys(SUBCONFIG_POR_CSOSN).sort()).toEqual([...csosnSchema.options].sort());
  });

  it('every slot is reached by some CSOSN and has a group list', () => {
    const reached = new Set(Object.values(SUBCONFIG_POR_CSOSN).filter((s) => s != null));
    expect([...reached].sort()).toEqual([...SUBCONFIGS_ICMS_SN].sort());
    expect(Object.keys(GRUPOS_XSD_POR_SUBCONFIG).sort()).toEqual([...SUBCONFIGS_ICMS_SN].sort());
  });
});

describe('vereditoIcmsSn — precedence: CRT, csosn, slot, groups', () => {
  it.each([CRT.regimeNormal, CRT.meiSimplesNacional])(
    'CRT %s with a leftover partial csosn500 → naoSimplesNacional',
    (crt) => {
      const icms: ConfiguracaoICMS = {
        crt,
        csosn: CSOSN.icmsCobradoAnteriormente,
        csosn500: { pST: 20 },
      };
      expect(vereditoIcmsSn(icms)).toEqual({ tipo: 'naoSimplesNacional', crt });
    },
  );

  // The CRT is checked BEFORE the CSOSN: a Regime Normal / MEI config with no
  // CSOSN is refused for its CRT, never asked for a CSOSN it cannot use.
  it.each([CRT.regimeNormal, CRT.meiSimplesNacional])(
    'CRT %s with csosn null → naoSimplesNacional, not semCsosn',
    (crt) => {
      expect(vereditoIcmsSn({ crt, csosn: null })).toEqual({ tipo: 'naoSimplesNacional', crt });
    },
  );

  it.each([CRT.simplesNacional, CRT.simplesNacionalExcessoSublimite])(
    'CRT %s with csosn null (and a partial csosn500 left over) → semCsosn',
    (crt) => {
      const icms: ConfiguracaoICMS = { crt, csosn: null, csosn500: { pST: 20 } };
      expect(vereditoIcmsSn(icms)).toEqual({ tipo: 'semCsosn', crt });
    },
  );

  it.each([
    [CSOSN.tributadaComCredito, 'csosn101'],
    [CSOSN.tributadaComCreditoComSt, 'csosn201'],
    [CSOSN.tributadaSemCreditoComSt, 'csosn202ou203'],
    [CSOSN.isencaoFaixaReceitaBrutaComSt, 'csosn202ou203'],
    [CSOSN.icmsCobradoAnteriormente, 'csosn500'],
    [CSOSN.outros, 'csosn900'],
  ] as const)('CSOSN %s with its slot absent or null → subConfigAusente %s', (csosn, slot) => {
    const esperado = { tipo: 'subConfigAusente', csosn, subConfig: slot };
    expect(vereditoIcmsSn(sn(csosn))).toEqual(esperado);
    expect(vereditoIcmsSn(sn(csosn, { [slot]: null }))).toEqual(esperado);
  });

  it("CSOSN 202 with csosn201 filled but its own slot null → names csosn202ou203, not 201's", () => {
    expect(
      vereditoIcmsSn(sn(CSOSN.tributadaSemCreditoComSt, { csosn201: SN201, csosn202ou203: null })),
    ).toEqual({
      tipo: 'subConfigAusente',
      csosn: CSOSN.tributadaSemCreditoComSt,
      subConfig: 'csosn202ou203',
    });
  });

  it.each([
    CSOSN.tributadaSemCredito,
    CSOSN.isencaoFaixaReceitaBruta,
    CSOSN.imune,
    CSOSN.naoTributada,
  ])('CSOSN %s → ok with sub null, every leftover partial slot ignored', (csosn) => {
    const icms = sn(csosn, { csosn500: { pST: 20 }, csosn900: { vBC: 1500 } });
    expect(vereditoIcmsSn(icms)).toEqual({ tipo: 'ok', csosn, sub: null });
  });

  it('CSOSN 202 reads csosn202ou203 even when csosn201 holds a partial FCP-ST trio', () => {
    const icms = sn(CSOSN.tributadaSemCreditoComSt, {
      csosn201: { ...SN201, vBCFCPST: 1800 },
      csosn202ou203: SN202,
    });
    expect(vereditoIcmsSn(icms)).toEqual({
      tipo: 'ok',
      csosn: CSOSN.tributadaSemCreditoComSt,
      sub: SN202,
    });
  });

  it('a partial group on the ACTIVE slot is reported against the actual CSOSN (203, not the slot)', () => {
    const icms = sn(CSOSN.isencaoFaixaReceitaBrutaComSt, {
      csosn202ou203: { ...SN202, pFCPST: 2 },
    });
    expect(vereditoIcmsSn(icms)).toEqual({
      tipo: 'gruposIncompletos',
      csosn: CSOSN.isencaoFaixaReceitaBrutaComSt,
      subConfig: 'csosn202ou203',
      grupos: [{ grupo: 'FCP-ST', faltando: ['vBCFCPST', 'vFCPST'] }],
    });
  });

  it.each([
    [CSOSN.tributadaComCredito, { csosn101: SN101 }, SN101],
    [
      CSOSN.tributadaComCreditoComSt,
      { csosn201: { ...SN201, ...FCP_ST } },
      { ...SN201, ...FCP_ST },
    ],
    [CSOSN.tributadaSemCreditoComSt, { csosn202ou203: SN202 }, SN202],
    [CSOSN.icmsCobradoAnteriormente, { csosn500: SN500_FULL }, SN500_FULL],
    [CSOSN.outros, { csosn900: SN900_FULL }, SN900_FULL],
  ] as const)('CSOSN %s, complete → ok carrying the sub-config', (csosn, extra, sub) => {
    expect(vereditoIcmsSn(sn(csosn, extra))).toEqual({ tipo: 'ok', csosn, sub });
  });
});

describe('vereditoIcmsSn — XSD sub-groups all-or-nothing', () => {
  it.each([
    ['CSOSN 500 with no groups', CSOSN.icmsCobradoAnteriormente, { csosn500: {} }],
    ['CSOSN 900 with no groups', CSOSN.outros, { csosn900: {} }],
    [
      'CSOSN 500 with every member null (stored, absent)',
      CSOSN.icmsCobradoAnteriormente,
      { csosn500: nullPadded(confICMSSN500Schema.shape, {}) },
    ],
    [
      'CSOSN 900 with every member null (stored, absent)',
      CSOSN.outros,
      { csosn900: nullPadded(confICMSSN900Schema.shape, {}) },
    ],
    ['CSOSN 201 with no FCP-ST trio', CSOSN.tributadaComCreditoComSt, { csosn201: SN201 }],
  ] as const)('%s → ok (absent is legal)', (_label, csosn, extra) => {
    expect(vereditoIcmsSn(sn(csosn, extra)).tipo).toBe('ok');
  });

  it.each([
    ['ICMS próprio', 'modBC'],
    ['ICMS próprio', 'vBC'],
    ['ICMS próprio', 'pICMS'],
    ['ICMS próprio', 'vICMS'],
    ['ICMS-ST', 'modBCST'],
    ['ICMS-ST', 'vBCST'],
    ['ICMS-ST', 'pICMSST'],
    ['ICMS-ST', 'vICMSST'],
    ['FCP-ST', 'vBCFCPST'],
    ['FCP-ST', 'pFCPST'],
    ['FCP-ST', 'vFCPST'],
    ['crédito SN', 'pCredSN'],
    ['crédito SN', 'vCredICMSSN'],
  ] as const)('CSOSN 900: %s without %s → exactly that group and field', (grupo, field) => {
    expect(veredito900(without(SN900_FULL, field))).toEqual({
      tipo: 'gruposIncompletos',
      csosn: CSOSN.outros,
      subConfig: 'csosn900',
      grupos: [{ grupo, faltando: [field] }],
    });
  });

  it.each([
    ['ICMS-ST retido', 'vBCSTRet'],
    ['ICMS-ST retido', 'pST'],
    ['ICMS-ST retido', 'vICMSSTRet'],
    ['FCP-ST retido', 'vBCFCPSTRet'],
    ['FCP-ST retido', 'pFCPSTRet'],
    ['FCP-ST retido', 'vFCPSTRet'],
    ['ICMS efetivo', 'pRedBCEfet'],
    ['ICMS efetivo', 'vBCEfet'],
    ['ICMS efetivo', 'pICMSEfet'],
    ['ICMS efetivo', 'vICMSEfet'],
  ] as const)('CSOSN 500: %s without %s → exactly that group and field', (grupo, field) => {
    expect(veredito500(without(SN500_FULL, field))).toEqual({
      tipo: 'gruposIncompletos',
      csosn: CSOSN.icmsCobradoAnteriormente,
      subConfig: 'csosn500',
      grupos: [{ grupo, faltando: [field] }],
    });
  });

  // An OPTIONAL member on its own still opens its group.
  it.each([
    [
      'CSOSN 500: vICMSSubstituto alone',
      () => veredito500({ vICMSSubstituto: 120 }),
      [{ grupo: 'ICMS-ST retido', faltando: ['vBCSTRet', 'pST', 'vICMSSTRet'] }],
    ],
    [
      'CSOSN 900: pRedBC alone',
      () => veredito900({ pRedBC: 10 }),
      [{ grupo: 'ICMS próprio', faltando: ['modBC', 'vBC', 'pICMS', 'vICMS'] }],
    ],
    [
      'CSOSN 900: pMVAST alone',
      () => veredito900({ pMVAST: 40 }),
      [{ grupo: 'ICMS-ST', faltando: ['modBCST', 'vBCST', 'pICMSST', 'vICMSST'] }],
    ],
    // FCP-ST is nested inside ICMS-ST: a complete trio with no ST group reports
    // only the ST clause — the trio itself is complete.
    [
      'CSOSN 900: a complete FCP-ST trio with no ST group',
      () => veredito900(SN900_GROUP.fcpSt),
      [{ grupo: 'ICMS-ST', faltando: ['modBCST', 'vBCST', 'pICMSST', 'vICMSST'] }],
    ],
  ] as const)('%s → opens its group', (_label, veredito, grupos) => {
    const v = veredito();
    expect(v.tipo).toBe('gruposIncompletos');
    if (v.tipo === 'gruposIncompletos') expect(v.grupos).toEqual(grupos);
  });

  it('every incomplete group is reported, in XSD order', () => {
    const v = veredito500({ pST: 20, pFCPSTRet: 2, vICMSEfet: 243 });
    expect(v).toEqual({
      tipo: 'gruposIncompletos',
      csosn: CSOSN.icmsCobradoAnteriormente,
      subConfig: 'csosn500',
      grupos: [
        { grupo: 'ICMS-ST retido', faltando: ['vBCSTRet', 'vICMSSTRet'] },
        { grupo: 'FCP-ST retido', faltando: ['vBCFCPSTRet', 'vFCPSTRet'] },
        { grupo: 'ICMS efetivo', faltando: ['pRedBCEfet', 'vBCEfet', 'pICMSEfet'] },
      ],
    });
  });

  // Presence is `!= null`. A numeric 0 (and MOD_BC's '0') is PRESENT, so on its
  // own it opens the group — near-misses against a `!value` regression.
  it.each([
    ['{ pRedBC: 0 } (optional member)', { pRedBC: 0 }, ['modBC', 'vBC', 'pICMS', 'vICMS']],
    ['{ vICMS: 0 } (required member)', { vICMS: 0 }, ['modBC', 'vBC', 'pICMS']],
    [
      '{ modBC: MOD_BC.margemValorAgregado }',
      { modBC: MOD_BC.margemValorAgregado },
      ['vBC', 'pICMS', 'vICMS'],
    ],
  ] as const)('CSOSN 900: %s alone opens ICMS próprio (0 is present)', (_label, sub, faltando) => {
    const v = veredito900(sub);
    expect(v.tipo).toBe('gruposIncompletos');
    if (v.tipo === 'gruposIncompletos') {
      expect(v.grupos).toEqual([{ grupo: 'ICMS próprio', faltando: [...faltando] }]);
    }
  });

  // The equal pair: a COMPLETE group holding zeros is complete.
  it('CSOSN 900: a complete group whose members are 0 / modBC 0 → ok', () => {
    const sub: ConfICMSSN900 = {
      modBC: MOD_BC.margemValorAgregado,
      vBC: 0,
      pRedBC: 0,
      pICMS: 0,
      vICMS: 0,
    };
    expect(veredito900(sub)).toEqual({ tipo: 'ok', csosn: CSOSN.outros, sub });
  });

  // A stored null reads exactly like a missing key: it neither opens nor completes.
  it('CSOSN 900: an explicit null member reads as absent', () => {
    const partial = nullPadded<ConfICMSSN900>(confICMSSN900Schema.shape, {
      modBC: MOD_BC.valorOperacao,
      vBC: 1500,
      vICMS: 270,
    });
    const v = veredito900(partial);
    expect(v.tipo).toBe('gruposIncompletos');
    if (v.tipo === 'gruposIncompletos') {
      expect(v.grupos).toEqual([{ grupo: 'ICMS próprio', faltando: ['pICMS'] }]);
    }
  });
});

describe('vereditoIcmsSn — the ok verdict carries the TYPED sub-config', () => {
  it('each CSOSN narrows `sub` to its own slot (null for 102/103/300/400)', () => {
    type Ok<C extends Csosn> = Extract<IcmsSnEmitivel, { csosn: C }>['sub'];
    expectTypeOf<Ok<typeof CSOSN.tributadaComCredito>>().toEqualTypeOf<ConfICMSSN101>();
    expectTypeOf<Ok<typeof CSOSN.tributadaComCreditoComSt>>().toEqualTypeOf<ConfICMSSN201>();
    expectTypeOf<Ok<typeof CSOSN.tributadaSemCreditoComSt>>().toEqualTypeOf<ConfICMSSN202ou203>();
    expectTypeOf<
      Ok<typeof CSOSN.isencaoFaixaReceitaBrutaComSt>
    >().toEqualTypeOf<ConfICMSSN202ou203>();
    expectTypeOf<Ok<typeof CSOSN.icmsCobradoAnteriormente>>().toEqualTypeOf<ConfICMSSN500>();
    expectTypeOf<Ok<typeof CSOSN.outros>>().toEqualTypeOf<ConfICMSSN900>();
    expectTypeOf<Ok<typeof CSOSN.tributadaSemCredito>>().toEqualTypeOf<null>();
    expectTypeOf<Ok<typeof CSOSN.isencaoFaixaReceitaBruta>>().toEqualTypeOf<null>();
    expectTypeOf<Ok<typeof CSOSN.imune>>().toEqualTypeOf<null>();
    expectTypeOf<Ok<typeof CSOSN.naoTributada>>().toEqualTypeOf<null>();
  });

  it('naoSimplesNacional carries only the non-SN CRTs', () => {
    expectTypeOf<Extract<VereditoIcmsSn, { tipo: 'naoSimplesNacional' }>['crt']>().toEqualTypeOf<
      typeof CRT.regimeNormal | typeof CRT.meiSimplesNacional
    >();
  });
});

// ---------------------------------------------------------------------------
// PIS / COFINS
// ---------------------------------------------------------------------------

const ALIQUOTAS = [null, 0, 0.65, 999.9999, 1000] as const;
const VALIQPRODS = [null, 0, 0.5] as const;

describe('vereditoPisCofins — every CST is classified', () => {
  it.each(cstPisCofinsSchema.options)('CST %s → a verdict for every operand pair', (cst) => {
    for (const aliquota of ALIQUOTAS) {
      for (const vAliqProd of VALIQPRODS) {
        const v = vereditoPisCofins(cst, aliquota, vAliqProd);
        expect(v).toBeDefined();
        expect(v.cst).toBe(cst);
      }
    }
  });

  it('the ok groups partition the CSTs 2 / 1 / 6 / 24 (Aliq / Qtde / NT / Outr)', () => {
    const grupos = cstPisCofinsSchema.options.map((cst) => {
      const v = vereditoPisCofins(cst, 0.65, 0.5);
      return v.tipo === 'ok' ? v.grupo : v.tipo === 'ambasAliquotas' ? 'Outr' : v.tipo;
    });
    const contagem = Object.fromEntries(
      ['Aliq', 'Qtde', 'NT', 'Outr'].map((g) => [g, grupos.filter((x) => x === g).length]),
    );
    expect(contagem).toEqual({ Aliq: 2, Qtde: 1, NT: 6, Outr: 24 });
  });
});

describe('vereditoPisCofins — Aliq (CST 01/02)', () => {
  it.each([CST_PIS_COFINS.tributavelAliquotaBasica, CST_PIS_COFINS.tributavelAliquotaDiferenciada])(
    'CST %s: the rate decides, vAliqProd is never read',
    (cst) => {
      const esperado: Record<string, VereditoPisCofins> = {
        null: { tipo: 'aliquotaAusente', cst },
        0: { tipo: 'ok', grupo: 'Aliq', cst, aliquota: 0 },
        0.65: { tipo: 'ok', grupo: 'Aliq', cst, aliquota: 0.65 },
        999.9999: { tipo: 'ok', grupo: 'Aliq', cst, aliquota: 999.9999 },
        1000: { tipo: 'aliquotaForaDoFormato', cst, aliquota: 1000 },
      };
      for (const aliquota of ALIQUOTAS) {
        for (const vAliqProd of VALIQPRODS) {
          expect(vereditoPisCofins(cst, aliquota, vAliqProd)).toEqual(esperado[String(aliquota)]);
        }
      }
    },
  );

  it('undefined reads like null', () => {
    expect(
      vereditoPisCofins(CST_PIS_COFINS.tributavelAliquotaBasica, undefined, undefined),
    ).toEqual({ tipo: 'aliquotaAusente', cst: CST_PIS_COFINS.tributavelAliquotaBasica });
  });

  it('near-miss: a rate of 0 is a configured 0% (== null, not falsy)', () => {
    expect(vereditoPisCofins(CST_PIS_COFINS.tributavelAliquotaBasica, 0, null).tipo).toBe('ok');
  });

  it('near-miss: no rate but a vAliqProd → still aliquotaAusente', () => {
    expect(vereditoPisCofins(CST_PIS_COFINS.tributavelAliquotaBasica, null, 5)).toEqual({
      tipo: 'aliquotaAusente',
      cst: CST_PIS_COFINS.tributavelAliquotaBasica,
    });
  });

  it('the bound is exclusive at ALIQUOTA_PIS_COFINS_LIMITE (TDec_0302a04)', () => {
    expect(ALIQUOTA_PIS_COFINS_LIMITE).toBe(1000);
    const cst = CST_PIS_COFINS.tributavelAliquotaBasica;
    expect(vereditoPisCofins(cst, 999.9999, null).tipo).toBe('ok');
    expect(vereditoPisCofins(cst, 1000, null).tipo).toBe('aliquotaForaDoFormato');
    expect(vereditoPisCofins(cst, 1234.5, null)).toEqual({
      tipo: 'aliquotaForaDoFormato',
      cst,
      aliquota: 1234.5,
    });
  });
});

describe('vereditoPisCofins — Qtde (CST 03)', () => {
  const cst = CST_PIS_COFINS.tributavelAliquotaPorUnidade;

  it('vAliqProd decides, the percent (even out of format) is never read', () => {
    const esperado: Record<string, VereditoPisCofins> = {
      null: { tipo: 'vAliqProdAusente', cst },
      0: { tipo: 'ok', grupo: 'Qtde', cst, vAliqProd: 0 },
      0.5: { tipo: 'ok', grupo: 'Qtde', cst, vAliqProd: 0.5 },
    };
    for (const aliquota of ALIQUOTAS) {
      for (const vAliqProd of VALIQPRODS) {
        expect(vereditoPisCofins(cst, aliquota, vAliqProd)).toEqual(esperado[String(vAliqProd)]);
      }
    }
  });

  it('near-miss: vAliqProd 0 is a configured rate (== null, not falsy)', () => {
    expect(vereditoPisCofins(cst, null, 0)).toEqual({
      tipo: 'ok',
      grupo: 'Qtde',
      cst,
      vAliqProd: 0,
    });
  });
});

describe('vereditoPisCofins — NT (CST 04–09)', () => {
  it.each([
    CST_PIS_COFINS.tributavelMonofasicaRevendaAliquotaZero,
    CST_PIS_COFINS.tributavelSubstituicaoTributaria,
    CST_PIS_COFINS.tributavelAliquotaZero,
    CST_PIS_COFINS.isentaContribuicao,
    CST_PIS_COFINS.semIncidenciaContribuicao,
    CST_PIS_COFINS.suspensaoContribuicao,
  ])('CST %s → ok NT whatever the operands, even out of format', (cst) => {
    for (const aliquota of ALIQUOTAS) {
      for (const vAliqProd of VALIQPRODS) {
        expect(vereditoPisCofins(cst, aliquota, vAliqProd)).toEqual({
          tipo: 'ok',
          grupo: 'NT',
          cst,
        });
      }
    }
  });
});

describe('vereditoPisCofins — Outr (CST 49–99): a rate counts only when > 0', () => {
  const cst = CST_PIS_COFINS.outrasOperacoesSaida;
  const zero = { tipo: 'ok', grupo: 'Outr', cst, base: { modo: 'zero' } } as const;
  const quantidade = {
    tipo: 'ok',
    grupo: 'Outr',
    cst,
    base: { modo: 'quantidade', vAliqProd: 0.5 },
  } as const;
  const valor = (aliquota: number) =>
    ({ tipo: 'ok', grupo: 'Outr', cst, base: { modo: 'valor', aliquota } }) as const;
  const ambas = { tipo: 'ambasAliquotas', cst } as const;
  const fora = { tipo: 'aliquotaForaDoFormato', cst, aliquota: 1000 } as const;

  // aliquota × vAliqProd {null, 0, 0.5}
  it.each([
    [null, [zero, zero, quantidade]],
    [0, [zero, zero, quantidade]],
    [0.65, [valor(0.65), valor(0.65), ambas]],
    [999.9999, [valor(999.9999), valor(999.9999), ambas]],
    [1000, [fora, fora, ambas]],
  ] as const)('aliquota %s', (aliquota, esperados) => {
    VALIQPRODS.forEach((vAliqProd, i) => {
      expect(vereditoPisCofins(cst, aliquota, vAliqProd)).toEqual(esperados[i]);
    });
  });

  it.each([
    ['0 / 0.5 → quantidade (the 0 percent is no second rate)', 0, 0.5, quantidade],
    ['0.0001 / 0.5 → ambasAliquotas (the smallest positive rate counts)', 0.0001, 0.5, ambas],
    ['1000 / 0.5 → ambasAliquotas, before the rate bound', 1000, 0.5, ambas],
    ['1000 alone → aliquotaForaDoFormato', 1000, null, fora],
    ['undefined / undefined → zero', undefined, undefined, zero],
  ] as const)('near-miss %s', (_label, aliquota, vAliqProd, esperado) => {
    expect(vereditoPisCofins(cst, aliquota, vAliqProd)).toEqual(esperado);
  });

  it('every CST 49–99 answers alike', () => {
    for (const outr of [
      CST_PIS_COFINS.creditoExclusivoTributadaMercadoInterno,
      CST_PIS_COFINS.creditoPresumidoOutrasOperacoes,
      CST_PIS_COFINS.outrasOperacoesEntrada,
      CST_PIS_COFINS.outrasOperacoes,
    ]) {
      expect(vereditoPisCofins(outr, 0.65, 0.5)).toEqual({ tipo: 'ambasAliquotas', cst: outr });
      expect(vereditoPisCofins(outr, null, null)).toEqual({ ...zero, cst: outr });
    }
  });
});

describe('vereditoIsRtc — the IS value mode (#1696 review)', () => {
  const porUnidade = { pIS: null, pISEspec: 1.25, qTrib: 4, uTrib: 'UN' };

  it('pISEspec + qTrib + uTrib is a per-unit IS, carrying the operands', () => {
    expect(vereditoIsRtc(porUnidade)).toEqual({
      tipo: 'porUnidade',
      pISEspec: 1.25,
      qTrib: 4,
      uTrib: 'UN',
    });
  });

  it.each([
    ['null', null],
    ['blank', ''],
  ])(
    'a per-unit IS whose uTrib is %s → uTribAusente (the XSD pairs it with qTrib)',
    (_l, uTrib) => {
      expect(vereditoIsRtc({ ...porUnidade, uTrib })).toEqual({ tipo: 'uTribAusente' });
    },
  );

  it('pIS wins: an ad valorem IS needs no uTrib, even beside a half-filled per-unit rate', () => {
    // Near-miss of the case above: the same missing uTrib, but the mode is ad valorem.
    expect(vereditoIsRtc({ ...porUnidade, pIS: 2, uTrib: null })).toEqual({
      tipo: 'adValorem',
      pIS: 2,
    });
    // A stored 0 is a configured 0% rate, not an absent one.
    expect(vereditoIsRtc({ ...porUnidade, pIS: 0 })).toEqual({ tipo: 'adValorem', pIS: 0 });
  });

  it('no complete mode → semAliquota (qTrib alone, pISEspec alone, nothing)', () => {
    expect(vereditoIsRtc({ ...porUnidade, pISEspec: null })).toEqual({ tipo: 'semAliquota' });
    expect(vereditoIsRtc({ ...porUnidade, qTrib: null })).toEqual({ tipo: 'semAliquota' });
    expect(vereditoIsRtc({ pIS: null, pISEspec: null, qTrib: null, uTrib: null })).toEqual({
      tipo: 'semAliquota',
    });
  });
});
