import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CRT, CSOSN, CST, CST_PIS_COFINS, ORIGEM, type Imposto } from '@delfrance/schemas';

import { MEASURE_UNIT_SHOPEE, SEM_CEST_SHOPEE, SEM_NCM_SHOPEE } from './constantesAnuncio';
import {
  MOTIVO_TAX_INFO_OMITIDO,
  cstConcordante,
  formatarPercentual,
  membroIcms,
  montarTaxInfo,
  type MotivoTaxInfoOmitido,
} from './taxInfoPublicacao';

/* ---------------------------------- fixtures ------------------------------ */

const NCM = '61091000';
const CEST = '2806300';
const CFOP = '5102';
const CFOP_INTER = '6102';

/**
 * A COMPLETE Imposto in the shop's real regime (CRT 1, Simples Nacional), using
 * the schema's REAL field names — `configuracaoPIS` / `configuracaoCOFINS` /
 * `configuracaoICMS`, not the design brief's `confPIS` / `confCOFINS`, which do
 * not exist on `impostoSchema`.
 */
function impostoCompleto(parcial: Partial<Imposto> = {}): Imposto {
  return {
    origem: ORIGEM.nacional,
    NCM,
    CEST,
    cfop: CFOP,
    cfopInterestadual: CFOP_INTER,
    configuracaoICMS: {
      crt: CRT.simplesNacional,
      csosn: CSOSN.tributadaSemCredito,
      cst: null,
    },
    configuracaoPIS: {
      CST: CST_PIS_COFINS.tributavelAliquotaBasica,
      pPIS: 1.65,
      vAliqProd: null,
    },
    configuracaoCOFINS: {
      CST: CST_PIS_COFINS.tributavelAliquotaBasica,
      pCOFINS: 7.6,
      vAliqProd: null,
    },
    ...parcial,
  };
}

/** The ten keys, sorted — the literal the wire's key set is pinned against. */
const DEZ_CHAVES_CRT1 = [
  'cest',
  'cofins',
  'csosn',
  'diff_state_cfop',
  'measure_unit',
  'ncm',
  'origin',
  'pis',
  'pis_cofins_cst',
  'same_state_cfop',
];

const FONTE_MODULO = readFileSync(
  fileURLToPath(new URL('./taxInfoPublicacao.ts', import.meta.url)),
  'utf8',
);

/** The module's source with every comment removed — what the WIRE can see. */
const CODIGO_SEM_COMENTARIOS = FONTE_MODULO.replace(/\/\*[\s\S]*?\*\//g, '').replace(
  /^\s*\/\/.*$/gm,
  '',
);

/* -------------------------------------------------------------------------- */
/*                     (1) o bloco inteiro — o caminho felizes                */
/* -------------------------------------------------------------------------- */

describe('montarTaxInfo — o bloco completo', () => {
  it('monta o bloco BR inteiro a partir de um Imposto CRT 1 completo', () => {
    const resultado = montarTaxInfo(impostoCompleto());

    expect(resultado.omitido).toBeNull();
    expect(resultado.taxInfo).toEqual({
      ncm: '61091000',
      cest: '2806300',
      origin: '0',
      csosn: '102',
      pis: '1.65',
      cofins: '7.60',
      pis_cofins_cst: '01',
      same_state_cfop: '5102',
      diff_state_cfop: '6102',
      measure_unit: 'UN',
    });
  });

  it('todo valor do bloco é uma STRING — nenhum número escapa para o corpo', () => {
    const { taxInfo } = montarTaxInfo(impostoCompleto());
    expect(taxInfo).not.toBeNull();
    if (taxInfo == null) return;
    for (const [chave, valor] of Object.entries(taxInfo)) {
      expect(typeof valor, `${chave} deveria ser string`).toBe('string');
    }
  });

  it("um NCM ausente vira '00', nunca uma string vazia e nunca com zeros à esquerda", () => {
    const { taxInfo } = montarTaxInfo(impostoCompleto({ NCM: null }));
    expect(taxInfo?.ncm).toBe(SEM_NCM_SHOPEE);
    expect(taxInfo?.ncm).toBe('00');
  });

  it("um CEST ausente vira '00'", () => {
    const { taxInfo } = montarTaxInfo(impostoCompleto({ CEST: null }));
    expect(taxInfo?.cest).toBe(SEM_CEST_SHOPEE);
  });

  it("measure_unit é exatamente 'UN' — nunca 'UNID' (announcement 1260)", () => {
    const { taxInfo } = montarTaxInfo(impostoCompleto());
    expect(taxInfo?.measure_unit).toBe('UN');
    expect(taxInfo?.measure_unit).toBe(MEASURE_UNIT_SHOPEE);
  });
});

/* -------------------------------------------------------------------------- */
/*            (2) o conjunto de chaves — as três constantes de vendedor        */
/* -------------------------------------------------------------------------- */

describe('o conjunto de chaves é CONSTANTE', () => {
  it('o bloco tem exatamente DEZ chaves — as três constantes de vendedor NÃO são enviadas', () => {
    const { taxInfo } = montarTaxInfo(impostoCompleto());
    expect(taxInfo).not.toBeNull();
    expect(Object.keys(taxInfo ?? {}).sort()).toEqual(DEZ_CHAVES_CRT1);
    expect(Object.keys(taxInfo ?? {})).toHaveLength(10);

    // Um `undefined` sob a chave conta como chave para `Object.keys`, então a
    // asserção acima só vale junto desta: as três não estão lá de jeito nenhum.
    expect(taxInfo).not.toHaveProperty('operation_type');
    expect(taxInfo).not.toHaveProperty('export_cfop');
    expect(taxInfo).not.toHaveProperty('federal_state_taxes');
    expect(taxInfo).not.toHaveProperty('ex_tipi');
  });

  it('nenhum CAMINHO DE CÓDIGO do módulo soletra as três constantes de vendedor (#1610)', () => {
    // O docblock as nomeia de propósito — é lá que a decisão está registrada —,
    // então a asserção é sobre o código com os comentários REMOVIDOS. Uma
    // asserção sobre o arquivo cru seria vermelha por causa da própria
    // documentação e seria removida na primeira vez que alguém a lesse.
    expect(FONTE_MODULO).toContain('operation_type');
    for (const proibida of [
      'operation_type',
      'export_cfop',
      'federal_state_taxes',
      'ex_tipi',
      'tax_type',
      'invoice_option',
      'hs_code',
    ]) {
      expect(CODIGO_SEM_COMENTARIOS, `${proibida} não pode ter caminho de código`).not.toContain(
        proibida,
      );
    }
  });

  it('o módulo não declara nenhuma constante com o prefixo do PACOTE', () => {
    // O prefixo `SHOPEE_` significa "um limite que a WIRE declara" e mora em
    // `@delfrance/integrations-shopee`. Uma cópia local é como dois números
    // divergem (o probe mediu 50 onde as páginas dizem 20).
    expect(CODIGO_SEM_COMENTARIOS).not.toContain('export const SHOPEE_');
  });
});

/* -------------------------------------------------------------------------- */
/*                 (3) INTEIRO ou NULO — a caminhada do conjunto              */
/* -------------------------------------------------------------------------- */

describe('o bloco é INTEIRO ou NULO', () => {
  const caminhada: [string, Imposto | null, MotivoTaxInfoOmitido][] = [
    ['um Imposto ausente', null, MOTIVO_TAX_INFO_OMITIDO.semImposto],
    [
      'configuracaoICMS nulo',
      impostoCompleto({ configuracaoICMS: null }),
      MOTIVO_TAX_INFO_OMITIDO.semIcms,
    ],
    [
      'csosn nulo em CRT 1',
      impostoCompleto({
        configuracaoICMS: { crt: CRT.simplesNacional, csosn: null, cst: null },
      }),
      MOTIVO_TAX_INFO_OMITIDO.semCsosn,
    ],
    [
      'cst nulo em CRT 3',
      impostoCompleto({
        configuracaoICMS: { crt: CRT.regimeNormal, csosn: null, cst: null },
      }),
      MOTIVO_TAX_INFO_OMITIDO.semCstIcms,
    ],
    [
      'configuracaoPIS nulo',
      impostoCompleto({ configuracaoPIS: null }),
      MOTIVO_TAX_INFO_OMITIDO.semPis,
    ],
    [
      'pPIS nulo',
      impostoCompleto({
        configuracaoPIS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: null },
      }),
      MOTIVO_TAX_INFO_OMITIDO.semPis,
    ],
    [
      'configuracaoCOFINS nulo',
      impostoCompleto({ configuracaoCOFINS: null }),
      MOTIVO_TAX_INFO_OMITIDO.semCofins,
    ],
    [
      'pCOFINS nulo',
      impostoCompleto({
        configuracaoCOFINS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pCOFINS: null },
      }),
      MOTIVO_TAX_INFO_OMITIDO.semCofins,
    ],
    [
      'CSTs de PIS e COFINS divergentes',
      impostoCompleto({
        configuracaoCOFINS: {
          CST: CST_PIS_COFINS.tributavelAliquotaDiferenciada,
          pCOFINS: 7.6,
        },
      }),
      MOTIVO_TAX_INFO_OMITIDO.cstPisCofinsDivergente,
    ],
    ['cfop nulo', impostoCompleto({ cfop: null }), MOTIVO_TAX_INFO_OMITIDO.semCfop],
    [
      'cfopInterestadual nulo',
      impostoCompleto({ cfopInterestadual: null }),
      MOTIVO_TAX_INFO_OMITIDO.semCfopInterestadual,
    ],
  ];

  it.each(caminhada)(
    'o bloco é INTEIRO ou NULO — nunca uma chave a menos: %s',
    (_rotulo, imposto, motivo) => {
      const resultado = montarTaxInfo(imposto);
      expect(resultado.taxInfo).toBeNull();
      expect(resultado.omitido).toBe(motivo);
    },
  );

  it('NCM e CEST são as DUAS exceções — ausentes não recusam, viram o escape do Shopee', () => {
    const resultado = montarTaxInfo(impostoCompleto({ NCM: null, CEST: null }));
    expect(resultado.omitido).toBeNull();
    expect(resultado.taxInfo?.ncm).toBe('00');
    expect(resultado.taxInfo?.cest).toBe('00');
    expect(Object.keys(resultado.taxInfo ?? {}).sort()).toEqual(DEZ_CHAVES_CRT1);
  });
});

/* -------------------------------------------------------------------------- */
/*                     (4) formatarPercentual — PAR + QUASE-IGUAL             */
/* -------------------------------------------------------------------------- */

describe('formatarPercentual — a dobra decimal', () => {
  it("PAR: 1.65 e 1.6500001 formatam ambos '1.65'", () => {
    expect(formatarPercentual(1.65)).toBe('1.65');
    expect(formatarPercentual(1.6500001)).toBe('1.65');
    expect(formatarPercentual(1.65)).toBe(formatarPercentual(1.6500001));
  });

  it("⛔ QUASE-IGUAL: 1.654 → '1.65' e 1.655 → '1.66' permanecem DISTINTOS", () => {
    expect(formatarPercentual(1.654)).toBe('1.65');
    expect(formatarPercentual(1.655)).toBe('1.66');
    expect(formatarPercentual(1.654)).not.toBe(formatarPercentual(1.655));
  });

  it("PAR: um percentual zero formata '0.00', não '' nem '0'", () => {
    expect(formatarPercentual(0)).toBe('0.00');
  });

  it('o separador decimal é um PONTO — nunca a vírgula pt-BR', () => {
    for (const n of [1.65, 7.6, 0, 18.3, 100]) {
      expect(formatarPercentual(n)).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('o bloco carrega o percentual formatado, com duas casas', () => {
    const { taxInfo } = montarTaxInfo(
      impostoCompleto({
        configuracaoPIS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: 0 },
        configuracaoCOFINS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pCOFINS: 7.6 },
      }),
    );
    expect(taxInfo?.pis).toBe('0.00');
    expect(taxInfo?.cofins).toBe('7.60');
  });
});

/* -------------------------------------------------------------------------- */
/*                       (5) cstConcordante — PAR + QUASE-IGUAL               */
/* -------------------------------------------------------------------------- */

describe('cstConcordante — a dobra dos CSTs', () => {
  it('PAR: PIS e COFINS com o MESMO CST produzem um único pis_cofins_cst', () => {
    expect(
      cstConcordante(
        CST_PIS_COFINS.tributavelAliquotaBasica,
        CST_PIS_COFINS.tributavelAliquotaBasica,
      ),
    ).toBe('01');

    const { taxInfo } = montarTaxInfo(impostoCompleto());
    expect(taxInfo?.pis_cofins_cst).toBe('01');
  });

  it("⛔ QUASE-IGUAL: PIS '01' e COFINS '02' NÃO se fundem — recusa com cst-pis-cofins-divergente", () => {
    expect(
      cstConcordante(
        CST_PIS_COFINS.tributavelAliquotaBasica,
        CST_PIS_COFINS.tributavelAliquotaDiferenciada,
      ),
    ).toBeNull();

    const resultado = montarTaxInfo(
      impostoCompleto({
        configuracaoCOFINS: { CST: CST_PIS_COFINS.tributavelAliquotaDiferenciada, pCOFINS: 7.6 },
      }),
    );
    expect(resultado.taxInfo).toBeNull();
    expect(resultado.omitido).toBe(MOTIVO_TAX_INFO_OMITIDO.cstPisCofinsDivergente);
  });

  it("⛔ pis_cofins_cst nunca é o literal '99' do legado — é o CST que os dois concordam", () => {
    const { taxInfo } = montarTaxInfo(
      impostoCompleto({
        configuracaoPIS: { CST: CST_PIS_COFINS.tributavelAliquotaZero, pPIS: 0 },
        configuracaoCOFINS: { CST: CST_PIS_COFINS.tributavelAliquotaZero, pCOFINS: 0 },
      }),
    );
    expect(taxInfo?.pis_cofins_cst).toBe('06');
    expect(taxInfo?.pis_cofins_cst).not.toBe('99');
  });
});

/* -------------------------------------------------------------------------- */
/*                          (6) o regime — membroIcms                         */
/* -------------------------------------------------------------------------- */

describe('o braço do regime é TOTAL sobre crtSchema', () => {
  it('CRT 1 envia csosn e NÃO envia icms_cst', () => {
    const { taxInfo } = montarTaxInfo(impostoCompleto());
    expect(taxInfo?.csosn).toBe('102');
    expect(taxInfo).not.toHaveProperty('icms_cst');
  });

  it('CRT 3 envia icms_cst e NÃO envia csosn', () => {
    const { taxInfo } = montarTaxInfo(
      impostoCompleto({
        configuracaoICMS: {
          crt: CRT.regimeNormal,
          csosn: null,
          cst: CST.tributadaIntegralmente,
        },
      }),
    );
    expect(taxInfo?.icms_cst).toBe('00');
    expect(taxInfo).not.toHaveProperty('csosn');
    expect(Object.keys(taxInfo ?? {})).toHaveLength(10);
  });

  it('⛔ QUASE-IGUAL: CRT 3 com csosn preenchido e cst nulo é RECUSADO (sem-cst-icms), não promovido a csosn', () => {
    const resultado = montarTaxInfo(
      impostoCompleto({
        configuracaoICMS: {
          crt: CRT.regimeNormal,
          csosn: CSOSN.tributadaSemCredito,
          cst: null,
        },
      }),
    );
    expect(resultado.taxInfo).toBeNull();
    expect(resultado.omitido).toBe(MOTIVO_TAX_INFO_OMITIDO.semCstIcms);
  });

  it('CRT 2 e CRT 4 tomam o braço do csosn — o mapeador é TOTAL sobre crtSchema', () => {
    for (const crt of [CRT.simplesNacionalExcessoSublimite, CRT.meiSimplesNacional]) {
      const { taxInfo } = montarTaxInfo(
        impostoCompleto({
          configuracaoICMS: { crt, csosn: CSOSN.tributadaComCredito, cst: null },
        }),
      );
      expect(taxInfo?.csosn).toBe('101');
      expect(taxInfo).not.toHaveProperty('icms_cst');
    }
  });

  it('membroIcms nomeia o motivo do regime sem que o chamador re-derive o CRT', () => {
    expect(membroIcms(null)).toEqual({ membro: null, omitido: MOTIVO_TAX_INFO_OMITIDO.semIcms });
    expect(membroIcms({ crt: CRT.simplesNacional, csosn: null, cst: null }).omitido).toBe(
      MOTIVO_TAX_INFO_OMITIDO.semCsosn,
    );
    expect(membroIcms({ crt: CRT.regimeNormal, csosn: null, cst: null }).omitido).toBe(
      MOTIVO_TAX_INFO_OMITIDO.semCstIcms,
    );
    expect(membroIcms({ crt: CRT.simplesNacional, csosn: CSOSN.imune, cst: null }).membro).toEqual({
      csosn: '300',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                        (7) as armadilhas do legado                         */
/* -------------------------------------------------------------------------- */

describe('as armadilhas do legado', () => {
  it('⛔ o pis vem de pPIS, NUNCA de vAliqProd', () => {
    // O exportador Flutter mandava `vAliqProd` — um valor POR UNIDADE, campo
    // irmão no mesmo schema, um caractere de distância. Um Imposto com
    // vAliqProd preenchido e pPIS nulo tem de RECUSAR, não mandar 0.53.
    const resultado = montarTaxInfo(
      impostoCompleto({
        configuracaoPIS: {
          CST: CST_PIS_COFINS.tributavelAliquotaBasica,
          pPIS: null,
          vAliqProd: 0.53,
        },
      }),
    );
    expect(resultado.taxInfo).toBeNull();
    expect(resultado.omitido).toBe(MOTIVO_TAX_INFO_OMITIDO.semPis);
  });

  it('⛔ o pis com AMBOS preenchidos leva o percentual, não o valor por unidade', () => {
    const { taxInfo } = montarTaxInfo(
      impostoCompleto({
        configuracaoPIS: {
          CST: CST_PIS_COFINS.tributavelAliquotaBasica,
          pPIS: 1.65,
          vAliqProd: 0.53,
        },
      }),
    );
    expect(taxInfo?.pis).toBe('1.65');
    expect(taxInfo?.pis).not.toBe('0.53');
  });

  it('⛔ o cofins é obrigatório — um configuracaoCOFINS nulo NÃO vira um bloco parcial', () => {
    const resultado = montarTaxInfo(impostoCompleto({ configuracaoCOFINS: null }));
    expect(resultado.taxInfo).toBeNull();
    expect(resultado.omitido).toBe(MOTIVO_TAX_INFO_OMITIDO.semCofins);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (8) o vocabulário persistido                        */
/* -------------------------------------------------------------------------- */

describe('MOTIVO_TAX_INFO_OMITIDO', () => {
  it('tem exatamente ONZE membros, e a chave camelCase casa com o slug', () => {
    expect(Object.values(MOTIVO_TAX_INFO_OMITIDO)).toHaveLength(11);
    for (const [chave, slug] of Object.entries(MOTIVO_TAX_INFO_OMITIDO)) {
      const esperado = chave.replace(/[A-Z]/g, (letra) => `-${letra.toLowerCase()}`);
      expect(slug).toBe(esperado);
    }
  });

  const produziveisAqui: [MotivoTaxInfoOmitido, Imposto | null][] = [
    [MOTIVO_TAX_INFO_OMITIDO.semImposto, null],
    [MOTIVO_TAX_INFO_OMITIDO.semIcms, impostoCompleto({ configuracaoICMS: null })],
    [
      MOTIVO_TAX_INFO_OMITIDO.semCsosn,
      impostoCompleto({ configuracaoICMS: { crt: CRT.simplesNacional, csosn: null, cst: null } }),
    ],
    [
      MOTIVO_TAX_INFO_OMITIDO.semCstIcms,
      impostoCompleto({ configuracaoICMS: { crt: CRT.regimeNormal, csosn: null, cst: null } }),
    ],
    [MOTIVO_TAX_INFO_OMITIDO.semPis, impostoCompleto({ configuracaoPIS: null })],
    [MOTIVO_TAX_INFO_OMITIDO.semCofins, impostoCompleto({ configuracaoCOFINS: null })],
    [
      MOTIVO_TAX_INFO_OMITIDO.cstPisCofinsDivergente,
      impostoCompleto({
        configuracaoCOFINS: { CST: CST_PIS_COFINS.tributavelAliquotaDiferenciada, pCOFINS: 7.6 },
      }),
    ],
    [MOTIVO_TAX_INFO_OMITIDO.semCfop, impostoCompleto({ cfop: null })],
    [MOTIVO_TAX_INFO_OMITIDO.semCfopInterestadual, impostoCompleto({ cfopInterestadual: null })],
  ];

  it.each(produziveisAqui)(
    '%s é produzível por alguma entrada de montarTaxInfo',
    (motivo, imposto) => {
      expect(montarTaxInfo(imposto).omitido).toBe(motivo);
    },
  );

  it('os DOIS membros que montarTaxInfo não produz têm produtor nomeado em outro lugar', () => {
    const produzidosAqui = new Set(produziveisAqui.map(([motivo]) => motivo));
    const restantes = Object.values(MOTIVO_TAX_INFO_OMITIDO).filter(
      (motivo) => !produzidosAqui.has(motivo),
    );
    expect(restantes.sort()).toEqual(['recusado-incompleto', 'sem-operacao']);

    // `sem-operacao` é do LEITOR: nenhuma função pura vê uma operação. A suíte
    // irmã o produz de verdade, e esta asserção é a que liga as duas — sem ela a
    // reivindicação "tem produtor" viveria só num comentário.
    const fonteDoLeitor = readFileSync(
      fileURLToPath(new URL('./lerImpostoDoProduto.test.ts', import.meta.url)),
      'utf8',
    );
    expect(fonteDoLeitor).toContain('semOperacao');

    // `recusado-incompleto` é do retry de uma tentativa do publicador, que ainda
    // não existe em árvore. Aqui só a pertinência ao vocabulário é afirmada — um
    // teste que finja produzi-lo seria vácuo.
    expect(Object.values(MOTIVO_TAX_INFO_OMITIDO)).toContain('recusado-incompleto');
  });
});
