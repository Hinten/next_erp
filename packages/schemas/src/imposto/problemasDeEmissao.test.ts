import { describe, expect, it } from 'vitest';

import { issuesDeEmissaoDasLinhas, problemasDeEmissaoDoImposto } from './problemasDeEmissao';
import {
  CRT,
  CSOSN,
  CST_PIS_COFINS,
  IND_INCENTIVO,
  IND_ISS,
  MOD_BC,
  ORIGEM,
  type Crt,
  type Csosn,
  type CstPisCofins,
} from './tribute';

// ---------------------------------------------------------------------------
// Fixtures — a REACHABLE tier doc (origem set, parses under impostoSchema)
// unless a test says otherwise.
// ---------------------------------------------------------------------------

function nivel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { origem: ORIGEM.nacional, ...over };
}

function icms(
  csosn: Csosn | null,
  over: Record<string, unknown> = {},
  crt: Crt = CRT.simplesNacional,
): Record<string, unknown> {
  return { configuracaoICMS: { crt, csosn, ...over } };
}

function pis(CST: CstPisCofins, pPIS: number | null, vAliqProd: number | null = null) {
  return { configuracaoPIS: { CST, pPIS, vAliqProd } };
}

function cofins(CST: CstPisCofins, pCOFINS: number | null, vAliqProd: number | null = null) {
  return { configuracaoCOFINS: { CST, pCOFINS, vAliqProd } };
}

/** CSOSN 500 with only `pST` of the ICMS-ST retido trio — the issue's shape. */
const PARCIAL_500 = icms(CSOSN.icmsCobradoAnteriormente, { csosn500: { pST: 20 } });

const PROBLEMA_PARCIAL_500 = {
  campos: ['configuracaoICMS.csosn500.vBCSTRet', 'configuracaoICMS.csosn500.vICMSSTRet'],
  mensagem:
    'CSOSN 500: o grupo "ICMS-ST retido" está incompleto — falta vBCSTRet, vICMSSTRet. ' +
    'Preencha o grupo inteiro ou deixe-o todo vazio.',
};

const ISSQN = {
  vBC: 500,
  vAliq: 5,
  vISSQN: 25,
  cMunFG: '3550308',
  cListServ: '01.05',
  indISS: IND_ISS.exigivel,
  indIncentivo: IND_INCENTIVO.nao,
};

// ---------------------------------------------------------------------------
// ICMS Simples Nacional
// ---------------------------------------------------------------------------

describe('problemasDeEmissaoDoImposto — ICMS Simples Nacional', () => {
  it('an incomplete XSD sub-group → one problem naming the group and its missing members', () => {
    expect(problemasDeEmissaoDoImposto(nivel(PARCIAL_500))).toEqual([PROBLEMA_PARCIAL_500]);
  });

  it('every incomplete group is its own problem, in XSD order', () => {
    const doc = nivel(
      icms(CSOSN.icmsCobradoAnteriormente, { csosn500: { pST: 20, pFCPSTRet: 2 } }),
    );
    expect(problemasDeEmissaoDoImposto(doc)).toEqual([
      PROBLEMA_PARCIAL_500,
      {
        campos: ['configuracaoICMS.csosn500.vBCFCPSTRet', 'configuracaoICMS.csosn500.vFCPSTRet'],
        mensagem:
          'CSOSN 500: o grupo "FCP-ST retido" está incompleto — falta vBCFCPSTRet, vFCPSTRet. ' +
          'Preencha o grupo inteiro ou deixe-o todo vazio.',
      },
    ]);
  });

  it('CSOSN 900 names its own group (ICMS próprio) and slot', () => {
    const doc = nivel(icms(CSOSN.outros, { csosn900: { vBC: 1500 } }));
    expect(problemasDeEmissaoDoImposto(doc)).toEqual([
      {
        campos: [
          'configuracaoICMS.csosn900.modBC',
          'configuracaoICMS.csosn900.pICMS',
          'configuracaoICMS.csosn900.vICMS',
        ],
        mensagem:
          'CSOSN 900: o grupo "ICMS próprio" está incompleto — falta modBC, pICMS, vICMS. ' +
          'Preencha o grupo inteiro ou deixe-o todo vazio.',
      },
    ]);
  });

  it('a CSOSN whose sub-config is null → points at the CSOSN select', () => {
    expect(problemasDeEmissaoDoImposto(nivel(icms(CSOSN.outros, { csosn900: null })))).toEqual([
      {
        campos: ['configuracaoICMS.csosn'],
        mensagem: 'CSOSN 900: os campos do CSOSN 900 não foram preenchidos.',
      },
    ]);
  });

  it('CSOSN 203 names 203, not the slot it shares with 202', () => {
    const doc = nivel(icms(CSOSN.isencaoFaixaReceitaBrutaComSt));
    expect(problemasDeEmissaoDoImposto(doc)).toEqual([
      {
        campos: ['configuracaoICMS.csosn'],
        mensagem: 'CSOSN 203: os campos do CSOSN 203 não foram preenchidos.',
      },
    ]);
  });

  it('a Simples Nacional CRT with no CSOSN → asks for the CSOSN', () => {
    expect(problemasDeEmissaoDoImposto(nivel(icms(null)))).toEqual([
      { campos: ['configuracaoICMS.csosn'], mensagem: 'ICMS: selecione o CSOSN.' },
    ]);
    expect(
      problemasDeEmissaoDoImposto(nivel(icms(null, {}, CRT.simplesNacionalExcessoSublimite))),
    ).toEqual([{ campos: ['configuracaoICMS.csosn'], mensagem: 'ICMS: selecione o CSOSN.' }]);
  });

  describe('near-misses that the engine emits → []', () => {
    it.each([
      ['a complete ICMS-ST retido group', { csosn500: { vBCSTRet: 100, pST: 20, vICMSSTRet: 20 } }],
      ['an empty sub-config', { csosn500: {} }],
      ['a null-padded absent group', { csosn500: { vBCSTRet: null, pST: null } }],
      [
        'a complete group holding zeros',
        { csosn500: { vBCSTRet: 0, pST: 0, vICMSSubstituto: 0, vICMSSTRet: 0 } },
      ],
    ])('CSOSN 500 with %s', (_label, sub) => {
      expect(problemasDeEmissaoDoImposto(nivel(icms(CSOSN.icmsCobradoAnteriormente, sub)))).toEqual(
        [],
      );
    });

    it('CSOSN 102 ignores a leftover partial csosn500 (it reads no slot)', () => {
      const doc = nivel(icms(CSOSN.tributadaSemCredito, { csosn500: { pST: 20 } }));
      expect(problemasDeEmissaoDoImposto(doc)).toEqual([]);
    });

    it('a complete CSOSN 900 ICMS próprio group with modBC 0 is complete', () => {
      const doc = nivel(
        icms(CSOSN.outros, {
          csosn900: { modBC: MOD_BC.margemValorAgregado, vBC: 1500, pICMS: 0, vICMS: 0 },
        }),
      );
      expect(problemasDeEmissaoDoImposto(doc)).toEqual([]);
    });

    it('CRT 3 (Regime Normal) with a leftover partial csosn500 → [] (not this check)', () => {
      const doc = nivel(
        icms(CSOSN.icmsCobradoAnteriormente, { csosn500: { pST: 20 } }, CRT.regimeNormal),
      );
      expect(problemasDeEmissaoDoImposto(doc)).toEqual([]);
    });

    it('an ISSQN item never reads its ICMS config', () => {
      const doc = nivel({
        ...icms(CSOSN.outros, { csosn900: { vBC: 1500 } }),
        configuracaoISSQN: ISSQN,
      });
      expect(problemasDeEmissaoDoImposto(doc)).toEqual([]);
    });

    it('a reachable tier with no ICMS config → [] (the neither-ICMS-nor-ISSQN rule is out of scope)', () => {
      expect(problemasDeEmissaoDoImposto(nivel({ configuracaoICMS: null }))).toEqual([]);
      expect(problemasDeEmissaoDoImposto(nivel())).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// PIS / COFINS
// ---------------------------------------------------------------------------

describe('problemasDeEmissaoDoImposto — PIS / COFINS', () => {
  it.each([
    [
      'CST 01 without a rate',
      pis(CST_PIS_COFINS.tributavelAliquotaBasica, null),
      { campos: ['configuracaoPIS.pPIS'], mensagem: 'PIS (CST 01): preencha a alíquota (%).' },
    ],
    [
      'CST 02 with a rate of 1000',
      pis(CST_PIS_COFINS.tributavelAliquotaDiferenciada, 1000),
      {
        campos: ['configuracaoPIS.pPIS'],
        mensagem: 'PIS (CST 02): a alíquota (%) deve ser menor que 1000.',
      },
    ],
    [
      'CST 03 without vAliqProd',
      pis(CST_PIS_COFINS.tributavelAliquotaPorUnidade, 0.65),
      {
        campos: ['configuracaoPIS.vAliqProd'],
        mensagem: 'PIS (CST 03): preencha a alíquota por unidade (R$).',
      },
    ],
    [
      'CST 49 with both rates',
      pis(CST_PIS_COFINS.outrasOperacoesSaida, 0.65, 0.1),
      {
        campos: ['configuracaoPIS.pPIS', 'configuracaoPIS.vAliqProd'],
        mensagem:
          'PIS (CST 49): preencha só a alíquota (%) ou só a alíquota por unidade (R$), não as duas.',
      },
    ],
    [
      'CST 99 with a percent rate of 1000',
      pis(CST_PIS_COFINS.outrasOperacoes, 1000),
      {
        campos: ['configuracaoPIS.pPIS'],
        mensagem: 'PIS (CST 99): a alíquota (%) deve ser menor que 1000.',
      },
    ],
  ])('PIS: %s', (_label, cfg, problema) => {
    expect(problemasDeEmissaoDoImposto(nivel(cfg))).toEqual([problema]);
  });

  it.each([
    [
      'CST 01 without a rate',
      cofins(CST_PIS_COFINS.tributavelAliquotaBasica, null),
      {
        campos: ['configuracaoCOFINS.pCOFINS'],
        mensagem: 'COFINS (CST 01): preencha a alíquota (%).',
      },
    ],
    [
      'CST 01 with a rate of 1000',
      cofins(CST_PIS_COFINS.tributavelAliquotaBasica, 1000),
      {
        campos: ['configuracaoCOFINS.pCOFINS'],
        mensagem: 'COFINS (CST 01): a alíquota (%) deve ser menor que 1000.',
      },
    ],
    [
      'CST 03 without vAliqProd',
      cofins(CST_PIS_COFINS.tributavelAliquotaPorUnidade, null),
      {
        campos: ['configuracaoCOFINS.vAliqProd'],
        mensagem: 'COFINS (CST 03): preencha a alíquota por unidade (R$).',
      },
    ],
    [
      'CST 49 with both rates',
      cofins(CST_PIS_COFINS.outrasOperacoesSaida, 3, 0.2),
      {
        campos: ['configuracaoCOFINS.pCOFINS', 'configuracaoCOFINS.vAliqProd'],
        mensagem:
          'COFINS (CST 49): preencha só a alíquota (%) ou só a alíquota por unidade (R$), não as duas.',
      },
    ],
  ])('COFINS: %s', (_label, cfg, problema) => {
    expect(problemasDeEmissaoDoImposto(nivel(cfg))).toEqual([problema]);
  });

  describe('near-misses the engine emits → []', () => {
    it.each([
      ['CST 01 at 0% (a configured zero)', pis(CST_PIS_COFINS.tributavelAliquotaBasica, 0)],
      ['CST 01 at 999.9999%', pis(CST_PIS_COFINS.tributavelAliquotaBasica, 999.9999)],
      ['CST 03 with vAliqProd 0', pis(CST_PIS_COFINS.tributavelAliquotaPorUnidade, null, 0)],
      ['CST 49 with pPIS 0 + vAliqProd 0.5', pis(CST_PIS_COFINS.outrasOperacoesSaida, 0, 0.5)],
      ['CST 49 with pPIS 0.65 alone', pis(CST_PIS_COFINS.outrasOperacoesSaida, 0.65)],
      ['CST 49 with nothing configured', pis(CST_PIS_COFINS.outrasOperacoesSaida, null)],
      ['CST 07 with both rates (NT reads none)', pis(CST_PIS_COFINS.isentaContribuicao, 1, 1)],
    ])('%s', (_label, cfg) => {
      expect(problemasDeEmissaoDoImposto(nivel(cfg))).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Order, the tier gate, totality
// ---------------------------------------------------------------------------

describe('problemasDeEmissaoDoImposto — order, reachability, totality', () => {
  it('lists PIS, then COFINS, then ICMS — the engine build order', () => {
    const doc = nivel({
      ...PARCIAL_500,
      ...cofins(CST_PIS_COFINS.tributavelAliquotaBasica, null),
      ...pis(CST_PIS_COFINS.outrasOperacoesSaida, 0.65, 0.1),
    });
    expect(problemasDeEmissaoDoImposto(doc).map((p) => p.campos[0])).toEqual([
      'configuracaoPIS.pPIS',
      'configuracaoCOFINS.pCOFINS',
      'configuracaoICMS.csosn500.vBCSTRet',
    ]);
  });

  // The engine only builds a tier doc that parses under impostoSchema; one
  // that does not is never read, so it is never rejected either.
  it.each([
    ['origem null', { ...PARCIAL_500, origem: null }],
    ['origem absent', { ...PARCIAL_500 }],
    ['a malformed NCM', nivel({ ...PARCIAL_500, NCM: '123' })],
    ['a malformed cfop', nivel({ ...PARCIAL_500, cfop: '51' })],
  ])('an unreachable tier (%s) → []', (_label, doc) => {
    expect(problemasDeEmissaoDoImposto(doc)).toEqual([]);
  });

  it('the same partial row with origem set → the problem (equal pair of the gate)', () => {
    expect(problemasDeEmissaoDoImposto({ ...PARCIAL_500, origem: ORIGEM.nacional })).toEqual([
      PROBLEMA_PARCIAL_500,
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 7],
    ['an array', [PARCIAL_500]],
    ['a PIS CST off the enum', nivel({ configuracaoPIS: { CST: '1', pPIS: null } })],
    [
      'a PIS CST stored as a number',
      nivel({ configuracaoPIS: { CST: 49, pPIS: 1, vAliqProd: 1 } }),
    ],
    ['a PIS config without CST', nivel({ configuracaoPIS: {} })],
    ['a CSOSN off the enum', nivel(icms('999' as Csosn, { csosn500: { pST: 20 } }))],
    [
      'a CRT stored as a number',
      nivel({ configuracaoICMS: { crt: 1, csosn: CSOSN.icmsCobradoAnteriormente, csosn500: {} } }),
    ],
    [
      'a sub-config that is not an object',
      nivel(icms(CSOSN.icmsCobradoAnteriormente, { csosn500: 'x' })),
    ],
  ])('a raw soft-read value (%s) → [] without throwing', (_label, raw) => {
    expect(() => problemasDeEmissaoDoImposto(raw)).not.toThrow();
    expect(problemasDeEmissaoDoImposto(raw)).toEqual([]);
  });

  it('ignores keys impostoSchema does not model (an operação or regra doc passes whole)', () => {
    const operacao = nivel({
      ...PARCIAL_500,
      nome: 'Venda',
      tipo: 1,
      ehFiscal: true,
      macros: null,
    });
    expect(problemasDeEmissaoDoImposto(operacao)).toEqual([PROBLEMA_PARCIAL_500]);
  });
});

// ---------------------------------------------------------------------------
// Rows → issues
// ---------------------------------------------------------------------------

describe('issuesDeEmissaoDasLinhas', () => {
  it('maps row i, problem p to `${campo}.${i}.${first field}`', () => {
    const ok = nivel(icms(CSOSN.tributadaSemCredito));
    expect(issuesDeEmissaoDasLinhas([ok, nivel(PARCIAL_500)], 'impostos')).toEqual([
      {
        path: 'impostos.1.configuracaoICMS.csosn500.vBCSTRet',
        message: PROBLEMA_PARCIAL_500.mensagem,
      },
    ]);
  });

  it('one issue per problem, rows in order', () => {
    const linhas = [
      nivel(pis(CST_PIS_COFINS.outrasOperacoesSaida, 0.65, 0.1)),
      {},
      nivel(PARCIAL_500),
    ];
    expect(issuesDeEmissaoDasLinhas(linhas, 'impostos').map((i) => i.path)).toEqual([
      'impostos.0.configuracaoPIS.pPIS',
      'impostos.2.configuracaoICMS.csosn500.vBCSTRet',
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
    ['only unreachable rows', [PARCIAL_500, {}, null]],
  ])('%s → []', (_label, linhas) => {
    expect(issuesDeEmissaoDasLinhas(linhas, 'impostos')).toEqual([]);
  });

  it('a raw non-array value (a z.unknown field) → [] without throwing', () => {
    const raw = { 0: nivel(PARCIAL_500) } as unknown as unknown[];
    expect(issuesDeEmissaoDasLinhas(raw, 'impostos')).toEqual([]);
  });
});
