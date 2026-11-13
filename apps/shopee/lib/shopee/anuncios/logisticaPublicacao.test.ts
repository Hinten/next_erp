import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_LOGISTICS_FEE_TYPE,
  type ShopeeDimensionRequest,
  type ShopeeLogisticsChannel,
  shopeeLogisticsChannelSchema,
} from '@delfrance/integrations-shopee';

import { exigirAcaoSeHaComando } from '../kits/testing/exigirAcao';
import {
  UNIDADES_PARA_CM,
  type ArgsLogistica,
  type MotivoCanalPulado,
  cabeNoCanal,
  construirLogistica,
  paraCm,
} from './logisticaPublicacao';

/* ---------------------------------- fixtures ------------------------------ */

const CANAL_PADRAO = 90003;
const CANAL_IRMAO = 90005;
const CANAL_RELACIONADO = 90009;

/**
 * One channel, built THROUGH the package's own schema so every `.default(null)`
 * lands exactly as a live body would leave it — a hand-written literal would
 * quietly diverge from the shape the publisher actually receives.
 */
function canal(parcial: Record<string, unknown> = {}): ShopeeLogisticsChannel {
  return shopeeLogisticsChannelSchema.parse({
    logistics_channel_id: CANAL_PADRAO,
    enabled: true,
    fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
    ...parcial,
  });
}

const DIM_10: ShopeeDimensionRequest = {
  package_height: 10,
  package_length: 10,
  package_width: 10,
};

/**
 * ⚠️ The fixture defaults to a TRUSTED list (#2015), and that is load-bearing:
 * blocks (6) and (7) below pin the STORED pass, and three of them ('um size_id
 * $rotulo PULA', CUSTOM_PRICE 'ruim', 'valida VAZIA') would stay green on a
 * distrusted default for the wrong reason — the full pass produces the same
 * skips. The first test of block (12) pins this default.
 */
function args(parcial: Partial<ArgsLogistica> = {}): ArgsLogistica {
  return {
    canais: [canal()],
    armazenado: null,
    armazenadoConfiavel: true,
    itemIdImportavel: null,
    pesoKg: 0.5,
    dimensaoCm: DIM_10,
    ofereceFreteGratis: false,
    ...parcial,
  };
}

/* -------------------------------------------------------------------------- */
/*                    (1) every MotivoCanalPulado is producible                */
/* -------------------------------------------------------------------------- */

interface LinhaPulado {
  readonly motivo: MotivoCanalPulado;
  readonly canal: ShopeeLogisticsChannel;
  readonly pesoKg: number;
}

const PULADOS: readonly LinhaPulado[] = [
  { motivo: 'nao-habilitado-na-loja', canal: canal({ enabled: false }), pesoKg: 0.5 },
  {
    motivo: 'peso-fora-do-limite',
    canal: canal({ weight_limit: { item_max_weight: 1, item_min_weight: 0 } }),
    pesoKg: 2,
  },
  {
    motivo: 'dimensao-fora-do-limite',
    canal: canal({
      item_max_dimension: { height: 5, width: 100, length: 100, unit: 'cm', dimension_sum: 0 },
    }),
    pesoKg: 0.5,
  },
  {
    motivo: 'soma-de-dimensoes-excedida',
    canal: canal({
      item_max_dimension: { height: 100, width: 100, length: 100, unit: 'cm', dimension_sum: 29 },
    }),
    pesoKg: 0.5,
  },
  {
    motivo: 'unidade-desconhecida',
    canal: canal({
      item_max_dimension: { height: 20, width: 20, length: 20, unit: 'polegada' },
    }),
    pesoKg: 0.5,
  },
  {
    motivo: 'size-selection-sem-size-id',
    canal: canal({ fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection }),
    pesoKg: 0.5,
  },
  {
    motivo: 'custom-price-sem-tarifa',
    canal: canal({ fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice }),
    pesoKg: 0.5,
  },
];

describe('construirLogistica — os sete motivos de pular um canal', () => {
  it.each(PULADOS)('$motivo é produzível com uma fixture real', (linha) => {
    const r = construirLogistica(args({ canais: [linha.canal], pesoKg: linha.pesoKg }));
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: linha.motivo }]);
    expect(r.logistic_info).toEqual([]);
  });

  it('a lista de motivos cobre TODOS os membros do tipo — nenhum fica sem produtor', () => {
    const cobertos = new Set(PULADOS.map((l) => l.motivo));
    const todos: readonly MotivoCanalPulado[] = [
      'nao-habilitado-na-loja',
      'peso-fora-do-limite',
      'dimensao-fora-do-limite',
      'soma-de-dimensoes-excedida',
      'unidade-desconhecida',
      'size-selection-sem-size-id',
      'custom-price-sem-tarifa',
    ];
    expect([...cobertos].sort()).toEqual([...todos].sort());
  });
});

/* -------------------------------------------------------------------------- */
/*                        (2) paraCm — a tabela fechada                        */
/* -------------------------------------------------------------------------- */

describe('paraCm', () => {
  it('⚠️ PAR: "in" e "inch" são a MESMA unidade e dão o mesmo valor', () => {
    expect(paraCm(4, 'in')).toBeCloseTo(10.16, 10);
    expect(paraCm(4, 'inch')).toBe(paraCm(4, 'in'));
  });

  it('converte cada unidade da tabela', () => {
    expect(paraCm(3, 'cm')).toBe(3);
    expect(paraCm(30, 'mm')).toBeCloseTo(3, 10);
    expect(paraCm(0.03, 'm')).toBeCloseTo(3, 10);
  });

  it('⚠️ QUASE-PAR: "CM" em maiúsculas NÃO é "cm" — comparação exata, sem trim nem case fold', () => {
    expect(paraCm(4, 'CM')).toBeNull();
    expect(paraCm(4, ' cm')).toBeNull();
    expect(paraCm(4, 'Inch')).toBeNull();
  });

  it('unidade nula, ausente ou desconhecida responde null — nunca um fator', () => {
    expect(paraCm(4, null)).toBeNull();
    expect(paraCm(4, undefined)).toBeNull();
    expect(paraCm(4, 'UNKNOWN')).toBeNull();
    expect(paraCm(4, 'polegada')).toBeNull();
  });

  it('uma chave do prototype não vira fator', () => {
    expect(paraCm(4, 'toString')).toBeNull();
    expect(paraCm(4, 'constructor')).toBeNull();
  });

  it('a tabela tem exatamente as cinco grafias conhecidas', () => {
    expect(Object.keys(UNIDADES_PARA_CM).sort()).toEqual(['cm', 'in', 'inch', 'm', 'mm']);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (3) M-55 — unidade desconhecida PULA o canal              */
/* -------------------------------------------------------------------------- */

describe('M-55 — a unidade do canal', () => {
  it('unidade desconhecida PULA o canal — nunca assume cm', () => {
    // 10 cm caberia num limite de 20 se a unidade fosse cm; ela não é, e assumir
    // cm habilitaria um canal em que o pacote não cabe.
    const r = construirLogistica(
      args({
        canais: [
          canal({ item_max_dimension: { height: 20, width: 20, length: 20, unit: 'polegada' } }),
        ],
      }),
    );
    expect(r.logistic_info).toEqual([]);
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'unidade-desconhecida' }]);
  });

  it('⚠️ QUASE-PAR: "CM" em maiúsculas também é desconhecida', () => {
    const r = construirLogistica(
      args({
        canais: [canal({ item_max_dimension: { height: 20, width: 20, length: 20, unit: 'CM' } })],
      }),
    );
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'unidade-desconhecida' }]);
  });

  it('a unidade só é consultada quando existe limite — UNKNOWN sem limite não pula nada', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({
            item_max_dimension: {
              height: 0,
              width: null,
              length: 0,
              unit: 'UNKNOWN',
              dimension_sum: 0,
            },
          }),
        ],
      }),
    );
    expect(r.pulados).toEqual([]);
    expect(r.logistic_info).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (4) cabeNoCanal — as fronteiras                      */
/* -------------------------------------------------------------------------- */

describe('cabeNoCanal — as fronteiras', () => {
  it('weight_limit 0 e null significam SEM limite', () => {
    expect(cabeNoCanal(canal({ weight_limit: null }), 999, DIM_10)).toBeNull();
    expect(
      cabeNoCanal(canal({ weight_limit: { item_max_weight: 0, item_min_weight: 0 } }), 999, DIM_10),
    ).toBeNull();
  });

  it('o peso exatamente no limite CABE; um grama acima não', () => {
    const c = canal({ weight_limit: { item_max_weight: 2, item_min_weight: 0.1 } });
    expect(cabeNoCanal(c, 2, DIM_10)).toBeNull();
    expect(cabeNoCanal(c, 2.001, DIM_10)).toBe('peso-fora-do-limite');
    expect(cabeNoCanal(c, 0.05, DIM_10)).toBe('peso-fora-do-limite');
  });

  it('o eixo exatamente no limite CABE', () => {
    const c = canal({
      item_max_dimension: { height: 10, width: 10, length: 10, unit: 'cm', dimension_sum: 0 },
    });
    expect(cabeNoCanal(c, 0.5, DIM_10)).toBeNull();
    expect(cabeNoCanal(c, 0.5, { ...DIM_10, package_width: 11 })).toBe('dimensao-fora-do-limite');
  });

  it('dimension_sum só vale quando > 0, e a soma exata CABE', () => {
    const semSoma = canal({
      item_max_dimension: { height: 100, width: 100, length: 100, unit: 'cm', dimension_sum: 0 },
    });
    expect(cabeNoCanal(semSoma, 0.5, DIM_10)).toBeNull();
    const soma30 = canal({
      item_max_dimension: { height: 100, width: 100, length: 100, unit: 'cm', dimension_sum: 30 },
    });
    expect(cabeNoCanal(soma30, 0.5, DIM_10)).toBeNull();
    const soma29 = canal({
      item_max_dimension: { height: 100, width: 100, length: 100, unit: 'cm', dimension_sum: 29 },
    });
    expect(cabeNoCanal(soma29, 0.5, DIM_10)).toBe('soma-de-dimensoes-excedida');
  });

  it('sem peso e sem dimensão não há o que comparar — cabe', () => {
    const c = canal({
      weight_limit: { item_max_weight: 1 },
      item_max_dimension: { height: 1, unit: 'cm' },
    });
    expect(cabeNoCanal(c, null, null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                   (5) M-56 — is_free e o bloqueio da loja                   */
/* -------------------------------------------------------------------------- */

describe('M-56 — is_free', () => {
  it('is_free respeita block_seller_cover_shipping_fee', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({ logistics_channel_id: CANAL_PADRAO, block_seller_cover_shipping_fee: false }),
          canal({ logistics_channel_id: CANAL_IRMAO, block_seller_cover_shipping_fee: true }),
        ],
        ofereceFreteGratis: true,
      }),
    );
    expect(r.logistic_info.map((e) => [e.logistic_id, e.is_free])).toEqual([
      [CANAL_PADRAO, true],
      [CANAL_IRMAO, false],
    ]);
  });

  it('sem frete grátis no produto, nenhum canal sai com is_free', () => {
    const r = construirLogistica(args({ ofereceFreteGratis: false }));
    expect(r.logistic_info[0]?.is_free).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                    (6) M-57 — o size_id armazenado                          */
/* -------------------------------------------------------------------------- */

const SIZE_SELECTION = { fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection };

describe('M-57 — o size_id da lista armazenada', () => {
  it.each([
    { rotulo: 'texto', valor: 'abc' },
    { rotulo: 'decimal em texto', valor: '12.5' },
    { rotulo: 'decimal', valor: 12.5 },
    { rotulo: 'string vazia', valor: '' },
    { rotulo: 'zero', valor: 0 },
    { rotulo: 'com espaços', valor: ' 12 ' },
    { rotulo: 'nulo', valor: null },
  ])('um size_id $rotulo PULA o canal — nunca vira NaN', ({ valor }) => {
    const r = construirLogistica(
      args({
        canais: [canal(SIZE_SELECTION)],
        armazenado: [{ logistic_id: CANAL_PADRAO, size_id: valor, enabled: true }],
      }),
    );
    expect(r.logistic_info).toEqual([]);
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'size-selection-sem-size-id' }]);
  });

  it('um size_id inteiro (número ou texto de dígitos) é enviado como inteiro', () => {
    for (const valor of [7, '7']) {
      const r = construirLogistica(
        args({
          canais: [canal(SIZE_SELECTION)],
          armazenado: [{ logistic_id: CANAL_PADRAO, size_id: valor, enabled: true }],
        }),
      );
      expect(r.logistic_info).toEqual([
        { logistic_id: CANAL_PADRAO, enabled: true, is_free: false, size_id: 7 },
      ]);
      expect(Number.isSafeInteger(r.logistic_info[0]?.size_id)).toBe(true);
    }
  });

  it('CUSTOM_PRICE usa a tarifa armazenada e recusa uma tarifa ilegível', () => {
    const ok = construirLogistica(
      args({
        canais: [canal({ fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice })],
        armazenado: [{ logistic_id: CANAL_PADRAO, shipping_fee: '12.90' }],
      }),
    );
    expect(ok.logistic_info[0]?.shipping_fee).toBe(12.9);

    const ruim = construirLogistica(
      args({
        canais: [canal({ fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice })],
        armazenado: [{ logistic_id: CANAL_PADRAO, shipping_fee: 'grátis' }],
      }),
    );
    expect(ruim.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'custom-price-sem-tarifa' }]);
  });
});

/* -------------------------------------------------------------------------- */
/*                     (7) a lista armazenada VENCE                            */
/* -------------------------------------------------------------------------- */

describe('a lista armazenada vence a reconstrução', () => {
  it('um canal vivo fora da lista armazenada NÃO é habilitado', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({ logistics_channel_id: CANAL_PADRAO }),
          canal({ logistics_channel_id: CANAL_IRMAO }),
        ],
        armazenado: [{ logistic_id: CANAL_PADRAO }],
      }),
    );
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_PADRAO]);
  });

  it('um canal armazenado que DESAPARECEU da loja é pulado, e o resto da lista vale', () => {
    const r = construirLogistica(
      args({
        canais: [canal({ logistics_channel_id: CANAL_PADRAO })],
        armazenado: [{ logistic_id: CANAL_PADRAO }, { logistic_id: CANAL_IRMAO }],
      }),
    );
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_PADRAO]);
    expect(r.pulados).toEqual([{ logisticId: CANAL_IRMAO, motivo: 'nao-habilitado-na-loja' }]);
  });

  it('a escolha armazenada de is_free vence o flag do produto, mas o bloqueio da loja mascara as duas', () => {
    const semBloqueio = construirLogistica(
      args({
        canais: [canal()],
        armazenado: [{ logistic_id: CANAL_PADRAO, is_free: true }],
        ofereceFreteGratis: false,
      }),
    );
    expect(semBloqueio.logistic_info[0]?.is_free).toBe(true);

    const comBloqueio = construirLogistica(
      args({
        canais: [canal({ block_seller_cover_shipping_fee: true })],
        armazenado: [{ logistic_id: CANAL_PADRAO, is_free: true }],
        ofereceFreteGratis: true,
      }),
    );
    expect(comBloqueio.logistic_info[0]?.is_free).toBe(false);
  });

  it('uma lista armazenada que valida VAZIA cai para a construção completa', () => {
    const r = construirLogistica(
      args({
        canais: [canal({ logistics_channel_id: CANAL_IRMAO })],
        // Nenhuma entrada resolve um canal vivo.
        armazenado: [{ logistic_id: 90099 }, { logistic_id: 'nada' }],
      }),
    );
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_IRMAO]);
  });

  it('uma entrada armazenada sem logistic_id legível é ignorada', () => {
    const r = construirLogistica(
      args({
        canais: [canal()],
        armazenado: [null, 7, 'x', {}, { logistic_id: 0 }, { logistic_id: CANAL_PADRAO }],
      }),
    );
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_PADRAO]);
  });
});

/* -------------------------------------------------------------------------- */
/*              (8) channel_relation_rules — objeto OU lista                   */
/* -------------------------------------------------------------------------- */

describe('channel_relation_rules', () => {
  it('⚠️ PAR: a forma OBJETO e a forma LISTA dão a MESMA união de canais habilitados', () => {
    const regras = {
      related_enabled_channels: [CANAL_RELACIONADO],
      related_disabled_channels: null,
    };
    const comObjeto = construirLogistica(
      args({ canais: [canal({ channel_relation_rules: regras })] }),
    );
    const comLista = construirLogistica(
      args({ canais: [canal({ channel_relation_rules: [regras] })] }),
    );
    expect(comObjeto.canaisHabilitados).toEqual([CANAL_PADRAO, CANAL_RELACIONADO]);
    expect(comLista.canaisHabilitados).toEqual(comObjeto.canaisHabilitados);
  });

  it('⚠️ QUASE-PAR: related_DISABLED_channels não entra na união', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({
            channel_relation_rules: {
              related_enabled_channels: null,
              related_disabled_channels: [CANAL_RELACIONADO],
              related_dependent_block_channels: [CANAL_IRMAO],
            },
          }),
        ],
      }),
    );
    expect(r.canaisHabilitados).toEqual([CANAL_PADRAO]);
  });

  it('o relacionado de um canal que NÃO enviamos não entra na união', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({
            enabled: false,
            channel_relation_rules: { related_enabled_channels: [CANAL_RELACIONADO] },
          }),
        ],
      }),
    );
    expect(r.canaisHabilitados).toEqual([]);
  });

  it('a união não repete um id', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({
            logistics_channel_id: CANAL_PADRAO,
            channel_relation_rules: { related_enabled_channels: [CANAL_IRMAO, CANAL_IRMAO] },
          }),
          canal({ logistics_channel_id: CANAL_IRMAO }),
        ],
      }),
    );
    expect(r.canaisHabilitados).toEqual([CANAL_PADRAO, CANAL_IRMAO]);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (9) o que NUNCA vai para o fio                            */
/* -------------------------------------------------------------------------- */

describe('o que nunca vai para o fio', () => {
  it('nenhuma entrada sai com enabled false — só o que queremos LIGADO chega ao fio', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({ logistics_channel_id: CANAL_PADRAO }),
          canal({ logistics_channel_id: CANAL_IRMAO, enabled: false }),
        ],
      }),
    );
    expect(r.logistic_info.every((e) => e.enabled === true)).toBe(true);
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_PADRAO]);
  });

  it('um canal force_enable entra mesmo com enabled false ou nulo', () => {
    const r = construirLogistica(args({ canais: [canal({ enabled: false, force_enable: true })] }));
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_PADRAO]);
  });

  it('SIZE_INPUT e FIXED_DEFAULT_PRICE não pedem size_id nem shipping_fee', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({
            logistics_channel_id: CANAL_PADRAO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
          }),
          canal({
            logistics_channel_id: CANAL_IRMAO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.fixedDefaultPrice,
          }),
        ],
      }),
    );
    expect(r.logistic_info).toEqual([
      { logistic_id: CANAL_PADRAO, enabled: true, is_free: false },
      { logistic_id: CANAL_IRMAO, enabled: true, is_free: false },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (10) logistica-sem-canal — os três caminhos                 */
/* -------------------------------------------------------------------------- */

describe('logistica-sem-canal', () => {
  it('uma loja sem canal nenhum é um problema de bloqueio', () => {
    const r = construirLogistica(args({ canais: [] }));
    expect(r.logistic_info).toEqual([]);
    expect(r.problemas).toHaveLength(1);
    expect(r.problemas[0]).toMatchObject({
      campo: 'logistic_info',
      motivo: 'logistica-sem-canal',
    });
  });

  it('nenhum canal aceita o item ⇒ um problema de bloqueio', () => {
    const r = construirLogistica(
      args({
        canais: [canal({ weight_limit: { item_max_weight: 0.1 } })],
        pesoKg: 9,
      }),
    );
    expect(r.problemas.map((p) => p.motivo)).toEqual(['logistica-sem-canal']);
  });

  it('um canal OBRIGATÓRIO que não podemos satisfazer é um problema que NOMEIA o canal', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({
            logistics_channel_id: 90007,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
            compulsory_channel: true,
          }),
          canal({ logistics_channel_id: CANAL_IRMAO }),
        ],
      }),
    );
    // O canal comum entra, então NÃO é o caminho "nenhum canal aceita".
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_IRMAO]);
    expect(r.problemas).toHaveLength(2);
    expect(r.problemas[0]?.mensagem).toContain('90007');
    expect(r.problemas.map((p) => p.motivo)).toEqual([
      'logistica-sem-canal',
      'logistica-sem-canal',
    ]);
  });

  it('havendo canal obrigatório e nenhum sobrevivendo, o problema agregado aparece', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal({ logistics_channel_id: 90007, compulsory_channel: true, enabled: false }),
          canal({ logistics_channel_id: CANAL_IRMAO }),
        ],
      }),
    );
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_IRMAO]);
    expect(r.problemas.some((p) => p.mensagem.includes('Nenhum canal obrigatório'))).toBe(true);
  });

  it('uma loja sem canal obrigatório nenhum não gera o problema agregado', () => {
    const r = construirLogistica(args());
    expect(r.problemas).toEqual([]);
  });

  it('todo problema é um ProblemaDeBloqueio no campo logistic_info', () => {
    const r = construirLogistica(args({ canais: [] }));
    for (const p of r.problemas) {
      expect(p.campo).toBe('logistic_info');
      expect(p.mensagem.length).toBeLessThanOrEqual(500);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                        (11) disciplina do módulo                            */
/* -------------------------------------------------------------------------- */

describe('disciplina do módulo', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./logisticaPublicacao.ts', import.meta.url)),
    'utf8',
  );

  it('não declara nenhuma constante com o prefixo reservado do pacote', () => {
    expect(fonte).toContain('UNIDADES_PARA_CM');
    expect(fonte).not.toMatch(/export const SHOPEE_/);
  });

  it('não reimplementa um limite do fio: o fee_type vem do pacote', () => {
    expect(fonte).toContain('SHOPEE_LOGISTICS_FEE_TYPE');
    expect(fonte).not.toMatch(/'SIZE_SELECTION'|'CUSTOM_PRICE'|'SIZE_INPUT'/);
  });

  it('#2015: a confiança chega pronta — o módulo nunca lê o carimbo nem chama o predicado', () => {
    // A decisão "quem gravou a lista" mora em UM predicado de
    // `@delfrance/schemas`, chamado por quem lê o vínculo CRU; aqui ela é só um
    // booleano. Uma segunda leitura do carimbo é o cheiro do #1369.
    expect(fonte).toContain('armazenadoConfiavel');
    expect(fonte).not.toMatch(
      /\.logisticaGravadaEm\b|\[['"]logisticaGravadaEm['"]\]|logisticaGravadaPeloErpShopee\(/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*          (12) #2015 — a lista armazenada só vale se ESTE app a gravou        */
/* -------------------------------------------------------------------------- */

const CANAL_OBRIGATORIO = 90007;
const ITEM_IMPORTAVEL = 123;

/** Sentence (1) — today's, unchanged, under `logistica-sem-canal`. */
const FRASE_CANAL_OBRIGATORIO_PERDIDO =
  'O canal obrigatório 90007 não pôde ser habilitado: falta um valor que só o Seller ' +
  'Centre define (tamanho ou tarifa), ou o item não cabe nos limites do canal.';

/** N1 — the new refusal's sentence, for one value. */
function fraseNaoConfirmada(falta: string, itemId: number = ITEM_IMPORTAVEL): string {
  return (
    `O canal obrigatório 90007 precisa de ${falta}, e o ERP não tem registro de ter lido da ` +
    'Shopee nem de ter enviado a ela o valor gravado neste vínculo, então esse valor não é ' +
    `reenviado. Importe o anúncio ${String(itemId)} para gravar os valores atuais da Shopee e ` +
    'publique de novo.'
  );
}

/**
 * CPY-4 — #1911 P14b's sentence (Lucas's, verbatim), for the channel as the sentence
 * names it: the bare id when the shop's list carries no usable name (every
 * fixture built by `canal()` has `logistics_channel_name: null`), `«nome» (id)`
 * otherwise.
 */
function fraseSemValorGravado(
  itemId: number = ITEM_IMPORTAVEL,
  canalNaFrase: string = String(CANAL_OBRIGATORIO),
): string {
  return (
    `O canal obrigatório ${canalNaFrase} precisa de um tamanho ou de uma tarifa de frete ` +
    'que este vínculo não tem gravados, e o ERP não tem registro de ter gravado a lista de ' +
    'logística dele. Se o valor já está no Seller Centre, importe o anúncio ' +
    `${String(itemId)} e publique de novo; se não está, defina-o no Seller Centre antes.`
  );
}

/** The CPY-4 problema, whole. */
function semValorGravado(mensagem: string = fraseSemValorGravado()) {
  return { campo: 'logistic_info', motivo: 'logistica-sem-valor-gravado', mensagem };
}

/** A compulsory channel of one fee type, beside an ordinary channel that always fits. */
function canaisComObrigatorio(
  feeType: string,
  parcial: Record<string, unknown> = {},
): ShopeeLogisticsChannel[] {
  return [
    canal({
      logistics_channel_id: CANAL_OBRIGATORIO,
      fee_type: feeType,
      compulsory_channel: true,
      ...parcial,
    }),
    canal({ logistics_channel_id: CANAL_IRMAO }),
  ];
}

/** A distrusted list (the legacy corpus) on a listing an import could re-read. */
function desconfiada(parcial: Partial<ArgsLogistica> = {}): ArgsLogistica {
  return args({ armazenadoConfiavel: false, itemIdImportavel: ITEM_IMPORTAVEL, ...parcial });
}

function motivosDosProblemas(r: ReturnType<typeof construirLogistica>): readonly string[] {
  return r.problemas.map((p) => p.motivo);
}

describe('#2015 — a confiança na lista armazenada', () => {
  it('âncora: o fixture args() é CONFIÁVEL e sem anúncio a importar — os blocos (6) e (7) não passam por vácuo', () => {
    const padrao = args();
    expect(padrao.armazenadoConfiavel).toBe(true);
    expect(padrao.itemIdImportavel).toBeNull();
    // ⛔ QUASE-PAR: o MESMO armazenado que (7) fixa, desconfiado, dá OUTRA
    // resposta — então o padrão é o que decide aqueles testes.
    const armazenado = [{ logistic_id: CANAL_PADRAO }];
    const canais = [
      canal({ logistics_channel_id: CANAL_PADRAO }),
      canal({ logistics_channel_id: CANAL_IRMAO }),
    ];
    expect(
      construirLogistica(args({ canais, armazenado })).logistic_info.map((e) => e.logistic_id),
    ).toEqual([CANAL_PADRAO]);
    expect(
      construirLogistica(desconfiada({ canais, armazenado })).logistic_info.map(
        (e) => e.logistic_id,
      ),
    ).toEqual([CANAL_PADRAO, CANAL_IRMAO]);
  });

  it('⚠️ PAR: is_free:true armazenado e flag do produto false — confiável manda true num canal só; desconfiada manda false em TODOS', () => {
    const base = {
      canais: [
        canal({ logistics_channel_id: CANAL_PADRAO }),
        canal({ logistics_channel_id: CANAL_IRMAO }),
      ],
      armazenado: [{ logistic_id: CANAL_PADRAO, is_free: true }],
      ofereceFreteGratis: false,
    };
    const confiavel = construirLogistica(args(base));
    expect(confiavel.logistic_info).toEqual([
      { logistic_id: CANAL_PADRAO, enabled: true, is_free: true },
    ]);
    expect(confiavel.canaisHabilitados).toEqual([CANAL_PADRAO]);

    const naoConfiavel = construirLogistica(desconfiada(base));
    expect(naoConfiavel.logistic_info).toEqual([
      { logistic_id: CANAL_PADRAO, enabled: true, is_free: false },
      { logistic_id: CANAL_IRMAO, enabled: true, is_free: false },
    ]);
    expect(naoConfiavel.canaisHabilitados).toEqual([CANAL_PADRAO, CANAL_IRMAO]);
    expect(naoConfiavel.problemas).toEqual([]);
  });

  it('⚠️ PAR (a outra direção): is_free:false armazenado e flag true — desconfiada manda true (o flag), confiável manda false', () => {
    const base = {
      armazenado: [{ logistic_id: CANAL_PADRAO, is_free: false }],
      ofereceFreteGratis: true,
    };
    expect(construirLogistica(desconfiada(base)).logistic_info[0]?.is_free).toBe(true);
    expect(construirLogistica(args(base)).logistic_info[0]?.is_free).toBe(false);
  });

  it('CUSTOM_PRICE não obrigatório com tarifa "12.90": confiável envia 12.9; desconfiada NÃO envia a tarifa, pula o canal, e não há problema', () => {
    const base = {
      canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.customPrice, {
        compulsory_channel: false,
      }),
      armazenado: [{ logistic_id: CANAL_OBRIGATORIO, shipping_fee: '12.90' }],
    };
    const confiavel = construirLogistica(args(base));
    expect(confiavel.logistic_info).toEqual([
      { logistic_id: CANAL_OBRIGATORIO, enabled: true, is_free: false, shipping_fee: 12.9 },
    ]);

    const naoConfiavel = construirLogistica(desconfiada(base));
    expect(naoConfiavel.logistic_info).toEqual([
      { logistic_id: CANAL_IRMAO, enabled: true, is_free: false },
    ]);
    expect(naoConfiavel.logistic_info.some((e) => 'shipping_fee' in e)).toBe(false);
    expect(naoConfiavel.pulados).toEqual([
      { logisticId: CANAL_OBRIGATORIO, motivo: 'custom-price-sem-tarifa' },
    ]);
    expect(naoConfiavel.problemas).toEqual([]);
  });

  it('SIZE_SELECTION não obrigatório com size_id 7: desconfiada NUNCA envia o tamanho armazenado', () => {
    const base = {
      canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection, {
        compulsory_channel: false,
      }),
      armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: 7 }],
    };
    expect(construirLogistica(args(base)).logistic_info).toEqual([
      { logistic_id: CANAL_OBRIGATORIO, enabled: true, is_free: false, size_id: 7 },
    ]);
    const naoConfiavel = construirLogistica(desconfiada(base));
    expect(naoConfiavel.logistic_info.some((e) => 'size_id' in e)).toBe(false);
    expect(naoConfiavel.pulados).toEqual([
      { logisticId: CANAL_OBRIGATORIO, motivo: 'size-selection-sem-size-id' },
    ]);
    expect(naoConfiavel.problemas).toEqual([]);
  });

  it('uma lista desconfiada só relata os pulados da passagem COMPLETA — nunca os da armazenada', () => {
    const base = {
      canais: [canal({ logistics_channel_id: CANAL_PADRAO })],
      // 90099 sumiu da loja: a passagem armazenada o relataria.
      armazenado: [{ logistic_id: CANAL_PADRAO }, { logistic_id: 90099 }],
    };
    expect(construirLogistica(args(base)).pulados).toEqual([
      { logisticId: 90099, motivo: 'nao-habilitado-na-loja' },
    ]);
    const naoConfiavel = construirLogistica(desconfiada(base));
    expect(naoConfiavel.pulados).toEqual([]);
    expect(naoConfiavel.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_PADRAO]);
  });
});

describe('#2015 — logistica-nao-confirmada (Lucas D2): o canal obrigatório cujo valor só a lista desconfiada tem', () => {
  it.each([
    {
      rotulo: 'SIZE_SELECTION, size_id "7"',
      feeType: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
      entrada: { size_id: '7' },
      falta: 'um tamanho',
    },
    {
      rotulo: 'SIZE_SELECTION, size_id 7',
      feeType: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
      entrada: { size_id: 7 },
      falta: 'um tamanho',
    },
    {
      rotulo: 'CUSTOM_PRICE, shipping_fee "12.90"',
      feeType: SHOPEE_LOGISTICS_FEE_TYPE.customPrice,
      entrada: { shipping_fee: '12.90' },
      falta: 'uma tarifa de frete',
    },
  ])(
    '$rotulo, desconfiada, anúncio 123 ⇒ UMA logistica-nao-confirmada com N1',
    ({ feeType, entrada, falta }) => {
      const r = construirLogistica(
        desconfiada({
          canais: canaisComObrigatorio(feeType),
          armazenado: [{ logistic_id: CANAL_OBRIGATORIO, ...entrada }],
        }),
      );
      // The compulsory channel is NOT sent; the ordinary one is.
      expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_IRMAO]);
      const naoConfirmados = r.problemas.filter((p) => p.motivo === 'logistica-nao-confirmada');
      expect(naoConfirmados).toEqual([
        {
          campo: 'logistic_info',
          motivo: 'logistica-nao-confirmada',
          mensagem: fraseNaoConfirmada(falta),
        },
      ]);
      // Sentence (1) is REPLACED for that channel, never added beside N1; and
      // with EVERY lost compulsory channel on N1, the aggregate sentence (2) is
      // left out (V-REFUSAL-9) — N1 is the whole refusal.
      expect(r.problemas.map((p) => p.mensagem)).not.toContain(FRASE_CANAL_OBRIGATORIO_PERDIDO);
      expect(r.problemas).toEqual(naoConfirmados);
    },
  );

  it('N1 não é uma frase de terminal: nenhuma flag, nenhum script `:anuncio`, nenhum "comando" — e nenhuma acao', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7' }],
      }),
    );
    const n1 = r.problemas[0];
    expect(n1?.motivo).toBe('logistica-nao-confirmada');
    expect(n1).toBeDefined();
    if (n1 === undefined) return;
    expect(() => exigirAcaoSeHaComando(n1)).not.toThrow();
    expect(n1.mensagem).not.toMatch(/(^|[\s(])--[a-z]|:anuncio\b|\bcomandos?\b/i);
    expect('acao' in n1).toBe(false);
  });

  it('N1 afirma só a AUSÊNCIA DE REGISTRO — nunca que o valor "não foi lido" nem "não foi enviado" (a web mostra os dois lado a lado)', () => {
    // A missing stamp proves only that nothing in this app vouches for the
    // list: a legacy import DID read it from Shopee, and a link this app wrote
    // before #2015 WAS sent by it. The web's copy claims "o ERP não tem
    // registro" and shows N1 as «Detalhe:» beside it, so N1 must claim the
    // same and nothing stronger — for a size AND for a fee.
    for (const [feeType, armazenado] of [
      [SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection, { logistic_id: CANAL_OBRIGATORIO, size_id: '7' }],
      [
        SHOPEE_LOGISTICS_FEE_TYPE.customPrice,
        { logistic_id: CANAL_OBRIGATORIO, shipping_fee: '12.90' },
      ],
    ] as const) {
      const r = construirLogistica(
        desconfiada({ canais: canaisComObrigatorio(feeType), armazenado: [armazenado] }),
      );
      const n1 = r.problemas[0]?.mensagem ?? '';
      expect(r.problemas[0]?.motivo, feeType).toBe('logistica-nao-confirmada');
      expect(n1).toContain(
        'o ERP não tem registro de ter lido da Shopee nem de ter enviado a ela o valor gravado',
      );
      expect(n1).not.toMatch(/não foi (lido|enviado)|nunca (foi )?(lido|enviado)|por este ERP/);
    }
  });

  it('N1 nomeia o itemIdImportavel que o chamador passou — nunca outro', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7' }],
        itemIdImportavel: 2500139861,
      }),
    );
    expect(r.problemas[0]?.mensagem).toBe(fraseNaoConfirmada('um tamanho', 2500139861));
  });

  it('⚠️ QUASE-PAR: a MESMA lista CONFIÁVEL envia o canal com o size_id e não há problema nenhum', () => {
    const r = construirLogistica(
      args({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7' }],
        itemIdImportavel: ITEM_IMPORTAVEL,
      }),
    );
    expect(r.logistic_info).toEqual([
      { logistic_id: CANAL_OBRIGATORIO, enabled: true, is_free: false, size_id: 7 },
    ]);
    expect(r.problemas).toEqual([]);
  });

  // #2099 (CPY-4): these used to be near-misses kept on sentence (1), whose «só
  // o Seller Centre define» was a dead end — a distrusted list never sends a
  // stored value, so a value set there failed the same way. They are now the
  // NEAR-MISS of N1 on its other side: the same distrusted list and listing to
  // import, with NO readable value ⇒ CPY-4, and still never N1.
  it.each([
    { rotulo: 'size_id vazio', entrada: { size_id: '' } },
    { rotulo: 'size_id decimal "12.5"', entrada: { size_id: '12.5' } },
    { rotulo: 'size_id "0"', entrada: { size_id: '0' } },
    { rotulo: 'size_id ausente', entrada: {} },
    { rotulo: 'só uma TARIFA legível num canal de TAMANHO', entrada: { shipping_fee: '12.90' } },
  ])(
    '⛔ QUASE-PAR de N1 ($rotulo): desconfiada, mas sem valor legível ⇒ UMA logistica-sem-valor-gravado (CPY-4), nunca N1 nem a frase (1)',
    ({ entrada }) => {
      const r = construirLogistica(
        desconfiada({
          canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
          armazenado: [{ logistic_id: CANAL_OBRIGATORIO, ...entrada }],
        }),
      );
      // The compulsory channel is not sent; the ordinary one is — so (3) never
      // held, and (2) is left out because CPY-4 is the whole refusal.
      expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_IRMAO]);
      expect(r.problemas).toEqual([semValorGravado()]);
    },
  );

  it('⛔ QUASE-PAR de N1: só um TAMANHO legível num canal de TARIFA (e a tarifa "grátis") ⇒ CPY-4', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.customPrice),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7', shipping_fee: 'grátis' }],
      }),
    );
    expect(r.problemas).toEqual([semValorGravado()]);
  });

  it('⛔ QUASE-PAR de N1: o valor legível é de OUTRO canal — nenhuma entrada armazenada para o obrigatório ⇒ CPY-4', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_IRMAO, size_id: '7' }],
      }),
    );
    expect(r.problemas).toEqual([semValorGravado()]);
  });

  it('#2099 CPY-4: um vínculo legado SEM lista nenhuma (armazenado null), desconfiado e com anúncio a importar ⇒ CPY-4', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: null,
      }),
    );
    expect(r.problemas).toEqual([semValorGravado()]);
  });

  it('⛔ QUASE-PAR: lista CONFIÁVEL com um tamanho ilegível ⇒ a frase (1), mesmo com anúncio a importar', () => {
    const r = construirLogistica(
      args({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '' }],
        itemIdImportavel: ITEM_IMPORTAVEL,
      }),
    );
    expect(motivosDosProblemas(r)).not.toContain('logistica-nao-confirmada');
    expect(r.problemas[0]?.mensagem).toBe(FRASE_CANAL_OBRIGATORIO_PERDIDO);
  });

  it('⛔ QUASE-PAR: uma lista CONFIÁVEL nunca recebe N1 — nem quando o canal tem uma entrada ilegível E outra legível', () => {
    // The one shape in which a TRUSTED stored pass both skips the compulsory
    // channel (the '' entry) and holds a readable size for it (the '7' entry,
    // which it SENDS): only the trust guard keeps N1's "não é reenviado" from
    // being said about a channel that is on the wire.
    const r = construirLogistica(
      args({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [
          { logistic_id: CANAL_OBRIGATORIO, size_id: '' },
          { logistic_id: CANAL_OBRIGATORIO, size_id: '7' },
        ],
        itemIdImportavel: ITEM_IMPORTAVEL,
      }),
    );
    expect(r.logistic_info).toEqual([
      { logistic_id: CANAL_OBRIGATORIO, enabled: true, is_free: false, size_id: 7 },
    ]);
    expect(motivosDosProblemas(r)).not.toContain('logistica-nao-confirmada');
  });

  it('⛔ QUASE-PAR: lista desconfiada com um tamanho legível, mas SEM anúncio a importar (um rascunho) ⇒ a frase (1)', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7' }],
        itemIdImportavel: null,
      }),
    );
    expect(motivosDosProblemas(r)).not.toContain('logistica-nao-confirmada');
    expect(r.problemas[0]?.mensagem).toBe(FRASE_CANAL_OBRIGATORIO_PERDIDO);
  });

  it.each([
    {
      rotulo: 'o pacote não cabe (peso)',
      parcial: { weight_limit: { item_max_weight: 0.1 } },
      motivo: 'peso-fora-do-limite',
    },
    {
      rotulo: 'o canal não está habilitado na loja',
      parcial: { enabled: false },
      motivo: 'nao-habilitado-na-loja',
    },
  ])(
    '⛔ QUASE-PAR: tamanho legível e desconfiado, mas $rotulo ⇒ a frase (1) — o pulado não é por falta do valor',
    ({ parcial, motivo }) => {
      const r = construirLogistica(
        desconfiada({
          canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection, parcial),
          armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7' }],
        }),
      );
      expect(r.pulados).toEqual([{ logisticId: CANAL_OBRIGATORIO, motivo }]);
      expect(motivosDosProblemas(r)).not.toContain('logistica-nao-confirmada');
      expect(r.problemas[0]?.mensagem).toBe(FRASE_CANAL_OBRIGATORIO_PERDIDO);
    },
  );

  it('⛔ QUASE-PAR POR CANAL: dois obrigatórios desconfiados, ambos com tamanho legível — só o que foi pulado POR FALTA DO VALOR recebe N1; o que não cabe fica na frase (1)', () => {
    // Condition 3 is PER CHANNEL: the "sem-size-id" skip of one compulsory
    // channel must never lend N1 to ANOTHER one that was skipped for its weight
    // — there "não é reenviado" would blame the stamp for a channel a trusted
    // copy would not have sent either.
    const OBRIGATORIO_PESADO = 90008;
    const r = construirLogistica(
      desconfiada({
        canais: [
          canal({
            logistics_channel_id: CANAL_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
            compulsory_channel: true,
          }),
          canal({
            logistics_channel_id: OBRIGATORIO_PESADO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
            compulsory_channel: true,
            weight_limit: { item_max_weight: 0.1 },
          }),
          canal({ logistics_channel_id: CANAL_IRMAO }),
        ],
        armazenado: [
          { logistic_id: CANAL_OBRIGATORIO, size_id: '7' },
          { logistic_id: OBRIGATORIO_PESADO, size_id: '8' },
        ],
      }),
    );
    expect(r.pulados).toEqual([
      { logisticId: CANAL_OBRIGATORIO, motivo: 'size-selection-sem-size-id' },
      { logisticId: OBRIGATORIO_PESADO, motivo: 'peso-fora-do-limite' },
    ]);
    expect(r.problemas.map((p) => [p.motivo, p.mensagem])).toEqual([
      ['logistica-nao-confirmada', fraseNaoConfirmada('um tamanho')],
      [
        'logistica-sem-canal',
        FRASE_CANAL_OBRIGATORIO_PERDIDO.replace(
          String(CANAL_OBRIGATORIO),
          String(OBRIGATORIO_PESADO),
        ),
      ],
      [
        'logistica-sem-canal',
        'Nenhum canal obrigatório da loja pôde ser habilitado para este item.',
      ],
    ]);
  });

  it.each([
    {
      rotulo: 'tamanho',
      feeType: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
      entradas: [{ size_id: '' }, { size_id: '7' }],
      falta: 'um tamanho',
    },
    {
      rotulo: 'tarifa',
      feeType: SHOPEE_LOGISTICS_FEE_TYPE.customPrice,
      entradas: [{ shipping_fee: 'grátis' }, { shipping_fee: '12.90' }],
      falta: 'uma tarifa de frete',
    },
  ])(
    'PAR (duas entradas do MESMO canal, uma ilegível e outra legível, $rotulo): desconfiada ⇒ N1 — basta UMA entrada guardar o valor',
    ({ feeType, entradas, falta }) => {
      // The mirror of the trusted duplicate-entry test above: a trusted copy of
      // this list SENDS the readable value, so a distrusted one really
      // withholds it and N1's "não é reenviado" is true. An "every entry"
      // reading would fall back to sentence (1) here.
      const r = construirLogistica(
        desconfiada({
          canais: canaisComObrigatorio(feeType),
          armazenado: entradas.map((e) => ({ logistic_id: CANAL_OBRIGATORIO, ...e })),
        }),
      );
      expect(motivosDosProblemas(r)).toEqual(['logistica-nao-confirmada']);
      expect(r.problemas[0]?.mensagem).toBe(fraseNaoConfirmada(falta));
    },
  );
});

/* -------------------------------------------------------------------------- */
/*   (12b) #2099 CPY-4 — logistica-sem-valor-gravado: o obrigatório sem valor   */
/*         utilizável numa lista desconfiada, com anúncio a importar           */
/* -------------------------------------------------------------------------- */

/** An invented channel name — never a real Shopee channel's. */
const NOME_INVENTADO = 'Canal inventado';

describe('#2099 CPY-4 — logistica-sem-valor-gravado: o canal obrigatório sem valor utilizável numa lista desconfiada', () => {
  it('PAR (tamanho × tarifa): nada gravado num canal de TAMANHO e num de TARIFA ⇒ a MESMA frase CPY-4, que nomeia os dois valores', () => {
    for (const feeType of [
      SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
      SHOPEE_LOGISTICS_FEE_TYPE.customPrice,
    ]) {
      const r = construirLogistica(
        desconfiada({ canais: canaisComObrigatorio(feeType), armazenado: [] }),
      );
      expect(r.problemas, feeType).toEqual([semValorGravado()]);
    }
  });

  it('CPY-4 não é uma frase de terminal: nenhuma flag, nenhum script `:anuncio`, nenhum "comando" — e nenhuma acao', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [],
      }),
    );
    const cpy4 = r.problemas[0];
    expect(cpy4?.motivo).toBe('logistica-sem-valor-gravado');
    expect(cpy4).toBeDefined();
    if (cpy4 === undefined) return;
    expect(() => exigirAcaoSeHaComando(cpy4)).not.toThrow();
    expect(cpy4.mensagem).not.toMatch(/(^|[\s(])--[a-z]|:anuncio\b|\bcomandos?\b/i);
    expect('acao' in cpy4).toBe(false);
    expect(cpy4.campo).toBe('logistic_info');
  });

  it('CPY-4 nomeia o itemIdImportavel que o chamador passou — nunca o id do canal no lugar dele, nem o contrário', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [],
        itemIdImportavel: 2500139861,
      }),
    );
    expect(r.problemas).toEqual([semValorGravado(fraseSemValorGravado(2500139861))]);
    const mensagem = r.problemas[0]?.mensagem ?? '';
    expect(mensagem).toContain('O canal obrigatório 90007 precisa');
    expect(mensagem).toContain('importe o anúncio 2500139861 e publique de novo');
  });

  it('⛔ QUASE-PAR de texto: CPY-4 nunca diz «não é reenviado» (não há valor a reter), e N1 nunca diz «não tem gravados»', () => {
    const cpy4 = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '' }],
      }),
    ).problemas[0];
    const n1 = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7' }],
      }),
    ).problemas[0];
    expect(cpy4?.motivo).toBe('logistica-sem-valor-gravado');
    expect(n1?.motivo).toBe('logistica-nao-confirmada');
    expect(cpy4?.mensagem).not.toContain('não é reenviado');
    expect(cpy4?.mensagem).not.toContain('valor gravado neste vínculo');
    expect(n1?.mensagem).not.toContain('não tem gravados');
    expect(n1?.mensagem).not.toContain('defina-o no Seller Centre');
  });

  describe('o canal na frase CPY-4 (Lucas §5-3): «nome» (id), ou o id quando o nome falta', () => {
    function cpy4ComNome(nome: unknown): string {
      const r = construirLogistica(
        desconfiada({
          canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection, {
            logistics_channel_name: nome,
          }),
          armazenado: [],
        }),
      );
      expect(r.problemas.map((p) => p.motivo)).toEqual(['logistica-sem-valor-gravado']);
      return r.problemas[0]?.mensagem ?? '';
    }

    it('PAR: com nome ⇒ «Canal inventado» (90007)', () => {
      expect(cpy4ComNome(NOME_INVENTADO)).toBe(
        fraseSemValorGravado(ITEM_IMPORTAVEL, `«${NOME_INVENTADO}» (90007)`),
      );
    });

    it.each([
      { rotulo: 'nome null', nome: null },
      { rotulo: 'nome vazio', nome: '' },
      { rotulo: 'nome só de espaços', nome: '   ' },
    ])('⛔ QUASE-PAR ($rotulo) ⇒ só o id, 90007 — nunca «» nem «   »', ({ nome }) => {
      const mensagem = cpy4ComNome(nome);
      expect(mensagem).toBe(fraseSemValorGravado());
      expect(mensagem).not.toContain('«');
    });

    it('o escopo da dobra: só as PONTAS do nome caem ("  Canal inventado  " ⇒ «Canal inventado»); o espaço de DENTRO fica', () => {
      expect(cpy4ComNome(`  ${NOME_INVENTADO}  `)).toBe(
        fraseSemValorGravado(ITEM_IMPORTAVEL, `«${NOME_INVENTADO}» (90007)`),
      );
      expect(cpy4ComNome('Canal  inventado')).toBe(
        fraseSemValorGravado(ITEM_IMPORTAVEL, '«Canal  inventado» (90007)'),
      );
    });

    it('o nome é o do canal NOMEADO pela frase — nunca o de um irmão que tem nome', () => {
      const r = construirLogistica(
        desconfiada({
          canais: [
            canal({
              logistics_channel_id: CANAL_OBRIGATORIO,
              fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
              compulsory_channel: true,
            }),
            canal({ logistics_channel_id: CANAL_IRMAO, logistics_channel_name: NOME_INVENTADO }),
          ],
          armazenado: [],
        }),
      );
      expect(r.problemas).toEqual([semValorGravado()]);
    });

    it('⛔ QUASE-PAR (CPY-4 SÓ): o MESMO canal com nome, em N1 e na frase (1), continua só com o id', () => {
      const comNome = canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection, {
        logistics_channel_name: NOME_INVENTADO,
      });
      const n1 = construirLogistica(
        desconfiada({
          canais: comNome,
          armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7' }],
        }),
      );
      expect(n1.problemas.map((p) => p.mensagem)).toEqual([fraseNaoConfirmada('um tamanho')]);
      // A draft: nothing to import, so sentence (1) — the bare id too.
      const rascunho = construirLogistica(
        desconfiada({ canais: comNome, armazenado: [], itemIdImportavel: null }),
      );
      expect(rascunho.problemas[0]).toEqual({
        campo: 'logistic_info',
        motivo: 'logistica-sem-canal',
        mensagem: FRASE_CANAL_OBRIGATORIO_PERDIDO,
      });
      for (const p of [...n1.problemas, ...rascunho.problemas]) {
        expect(p.mensagem).not.toContain(NOME_INVENTADO);
      }
    });
  });

  it.each([
    {
      rotulo: 'lista CONFIÁVEL vazia, com anúncio a importar',
      entrada: args({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [],
        itemIdImportavel: ITEM_IMPORTAVEL,
      }),
    },
    {
      rotulo: 'lista CONFIÁVEL com size_id vazio, com anúncio a importar',
      entrada: args({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '' }],
        itemIdImportavel: ITEM_IMPORTAVEL,
      }),
    },
    {
      rotulo: 'desconfiada e vazia, mas SEM anúncio a importar (um rascunho)',
      entrada: desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [],
        itemIdImportavel: null,
      }),
    },
  ])('⛔ QUASE-PAR ($rotulo) ⇒ a frase (1) em logistica-sem-canal, nunca CPY-4', ({ entrada }) => {
    const r = construirLogistica(entrada);
    expect(motivosDosProblemas(r)).not.toContain('logistica-sem-valor-gravado');
    expect(r.problemas[0]).toEqual({
      campo: 'logistic_info',
      motivo: 'logistica-sem-canal',
      mensagem: FRASE_CANAL_OBRIGATORIO_PERDIDO,
    });
  });

  it.each([
    {
      rotulo: 'o pacote não cabe (peso)',
      parcial: { weight_limit: { item_max_weight: 0.1 } },
      motivo: 'peso-fora-do-limite',
    },
    {
      rotulo: 'o canal não está habilitado na loja',
      parcial: { enabled: false },
      motivo: 'nao-habilitado-na-loja',
    },
  ])(
    '⛔ QUASE-PAR: desconfiada, nada gravado, mas $rotulo ⇒ a frase (1) — o pulado não é por falta do valor',
    ({ parcial, motivo }) => {
      const r = construirLogistica(
        desconfiada({
          canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection, parcial),
          armazenado: [],
        }),
      );
      expect(r.pulados).toEqual([{ logisticId: CANAL_OBRIGATORIO, motivo }]);
      expect(motivosDosProblemas(r)).not.toContain('logistica-sem-valor-gravado');
      expect(r.problemas[0]?.mensagem).toBe(FRASE_CANAL_OBRIGATORIO_PERDIDO);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*   (13) #2015 — quando TODO obrigatório perdido tomou N1, as frases da loja   */
/*        ficam de fora (V-REFUSAL-9)                                          */
/* -------------------------------------------------------------------------- */

/** Sentence (2), verbatim — the aggregate "no compulsory channel" one. */
const FRASE_NENHUM_OBRIGATORIO =
  'Nenhum canal obrigatório da loja pôde ser habilitado para este item.';

/** Sentence (3), verbatim — the "no channel at all" one, with its weight advice. */
const FRASE_NENHUM_CANAL =
  'Nenhum canal de logística da loja aceita este item: confira peso, dimensões e os ' +
  'canais habilitados no Seller Centre.';

const OUTRO_OBRIGATORIO = 90008;

/** The compulsory SIZE_SELECTION channel fits; the sibling does not (0.5 kg > 0.1 kg). */
const SO_O_OBRIGATORIO_CABE: readonly ShopeeLogisticsChannel[] = [
  canal({
    logistics_channel_id: CANAL_OBRIGATORIO,
    fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
    compulsory_channel: true,
  }),
  canal({ logistics_channel_id: CANAL_IRMAO, weight_limit: { item_max_weight: 0.1 } }),
];

/** A readable size for the compulsory channel, in the stored list. */
const TAMANHO_LEGIVEL = [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7' }];

/** Sentence (1) for another channel id. */
function frase1Do(logisticId: number): string {
  return FRASE_CANAL_OBRIGATORIO_PERDIDO.replace(String(CANAL_OBRIGATORIO), String(logisticId));
}

function semCanal(mensagem: string) {
  return { campo: 'logistic_info', motivo: 'logistica-sem-canal', mensagem };
}

describe('(13) #2015 — quando TODO obrigatório perdido tomou N1, as frases da loja ficam de fora (V-REFUSAL-9)', () => {
  it('A. dois obrigatórios, ambos N1 (um tamanho, uma tarifa) ⇒ exatamente as duas N1, nenhuma linha logistica-sem-canal', () => {
    const r = construirLogistica(
      desconfiada({
        canais: [
          canal({
            logistics_channel_id: CANAL_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
            compulsory_channel: true,
          }),
          canal({
            logistics_channel_id: OUTRO_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice,
            compulsory_channel: true,
          }),
          canal({ logistics_channel_id: CANAL_IRMAO }),
        ],
        armazenado: [...TAMANHO_LEGIVEL, { logistic_id: OUTRO_OBRIGATORIO, shipping_fee: '12.90' }],
      }),
    );
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_IRMAO]);
    expect(r.problemas).toEqual([
      {
        campo: 'logistic_info',
        motivo: 'logistica-nao-confirmada',
        mensagem: fraseNaoConfirmada('um tamanho'),
      },
      {
        campo: 'logistic_info',
        motivo: 'logistica-nao-confirmada',
        mensagem: fraseNaoConfirmada('uma tarifa de frete').replace(
          String(CANAL_OBRIGATORIO),
          String(OUTRO_OBRIGATORIO),
        ),
      },
    ]);
  });

  it('B. só o obrigatório cabe, desconfiado e com tamanho legível ⇒ lista VAZIA, a N1 sozinha bloqueia, e nenhum conselho de peso', () => {
    const r = construirLogistica(
      desconfiada({ canais: SO_O_OBRIGATORIO_CABE, armazenado: TAMANHO_LEGIVEL }),
    );
    expect(r.logistic_info).toEqual([]);
    expect(r.pulados).toEqual([
      { logisticId: CANAL_OBRIGATORIO, motivo: 'size-selection-sem-size-id' },
      { logisticId: CANAL_IRMAO, motivo: 'peso-fora-do-limite' },
    ]);
    expect(r.problemas).toEqual([
      {
        campo: 'logistic_info',
        motivo: 'logistica-nao-confirmada',
        mensagem: fraseNaoConfirmada('um tamanho'),
      },
    ]);
    for (const p of r.problemas) expect(p.mensagem).not.toMatch(/peso|dimens/i);
    // An empty list is still REFUSED — the CLI's "bloqueada" line rests on this.
    expect(r.problemas.length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    {
      rotulo: 'um rascunho (sem anúncio a importar), desconfiado e com tamanho legível',
      entrada: desconfiada({
        canais: SO_O_OBRIGATORIO_CABE,
        armazenado: TAMANHO_LEGIVEL,
        itemIdImportavel: null,
      }),
    },
    {
      rotulo: 'uma lista CONFIÁVEL com size_id vazio, com anúncio a importar',
      entrada: args({
        canais: SO_O_OBRIGATORIO_CABE,
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '' }],
        itemIdImportavel: ITEM_IMPORTAVEL,
      }),
    },
  ])(
    '⛔ C. QUASE-PAR ($rotulo): os MESMOS pulados de B, mas sem N1 ⇒ exatamente (1), (2) e (3) em logistica-sem-canal',
    ({ entrada }) => {
      const r = construirLogistica(entrada);
      expect(r.logistic_info).toEqual([]);
      // The skips are B's, byte for byte: only the trust/import arguments differ,
      // so a rule that read `pulados` alone could not tell the two apart.
      expect(r.pulados).toEqual([
        { logisticId: CANAL_OBRIGATORIO, motivo: 'size-selection-sem-size-id' },
        { logisticId: CANAL_IRMAO, motivo: 'peso-fora-do-limite' },
      ]);
      expect(r.problemas).toEqual([
        semCanal(FRASE_CANAL_OBRIGATORIO_PERDIDO),
        semCanal(FRASE_NENHUM_OBRIGATORIO),
        semCanal(FRASE_NENHUM_CANAL),
      ]);
    },
  );

  it('⛔ D. QUASE-PAR (mistura): N1 num obrigatório e (1) noutro pesado demais, irmão pesado demais ⇒ N1, (1), (2) e (3)', () => {
    const r = construirLogistica(
      desconfiada({
        canais: [
          canal({
            logistics_channel_id: CANAL_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
            compulsory_channel: true,
          }),
          canal({
            logistics_channel_id: OUTRO_OBRIGATORIO,
            compulsory_channel: true,
            weight_limit: { item_max_weight: 0.1 },
          }),
          canal({ logistics_channel_id: CANAL_IRMAO, weight_limit: { item_max_weight: 0.1 } }),
        ],
        armazenado: TAMANHO_LEGIVEL,
      }),
    );
    expect(r.logistic_info).toEqual([]);
    expect(r.problemas.map((p) => [p.motivo, p.mensagem])).toEqual([
      ['logistica-nao-confirmada', fraseNaoConfirmada('um tamanho')],
      ['logistica-sem-canal', frase1Do(OUTRO_OBRIGATORIO)],
      ['logistica-sem-canal', FRASE_NENHUM_OBRIGATORIO],
      ['logistica-sem-canal', FRASE_NENHUM_CANAL],
    ]);
  });

  it('⛔ E. QUASE-PAR (vácuo): desconfiada, nenhum obrigatório na loja e nada cabe ⇒ exatamente (3)', () => {
    const r = construirLogistica(
      desconfiada({
        canais: [canal({ weight_limit: { item_max_weight: 0.1 } })],
        armazenado: [{ logistic_id: CANAL_PADRAO, enabled: true, is_free: true }],
      }),
    );
    expect(r.logistic_info).toEqual([]);
    expect(r.problemas).toEqual([semCanal(FRASE_NENHUM_CANAL)]);
  });
});

/* -------------------------------------------------------------------------- */
/*   (13b) #2099 — a mesma supressão quando todo obrigatório perdido tomou N1   */
/*         OU CPY-4; o botão de peso não tem onde aparecer                     */
/* -------------------------------------------------------------------------- */

describe('(13b) #2099 — quando TODO obrigatório perdido tomou N1 ou CPY-4, as frases da loja ficam de fora', () => {
  it('B′. só o obrigatório cabe, desconfiado e SEM nada gravado ⇒ lista VAZIA, CPY-4 sozinha bloqueia, e nenhum conselho de peso', () => {
    const r = construirLogistica(desconfiada({ canais: SO_O_OBRIGATORIO_CABE, armazenado: [] }));
    expect(r.logistic_info).toEqual([]);
    expect(r.pulados).toEqual([
      { logisticId: CANAL_OBRIGATORIO, motivo: 'size-selection-sem-size-id' },
      { logisticId: CANAL_IRMAO, motivo: 'peso-fora-do-limite' },
    ]);
    expect(r.problemas).toEqual([semValorGravado()]);
    for (const p of r.problemas) expect(p.mensagem).not.toMatch(/peso|dimens/i);
    // An empty list is still REFUSED — the CLI's "bloqueada" line rests on this.
    expect(r.problemas.length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    {
      rotulo: 'um rascunho (sem anúncio a importar), desconfiado e sem nada gravado',
      entrada: desconfiada({
        canais: SO_O_OBRIGATORIO_CABE,
        armazenado: [],
        itemIdImportavel: null,
      }),
    },
    {
      rotulo: 'uma lista CONFIÁVEL vazia, com anúncio a importar',
      entrada: args({
        canais: SO_O_OBRIGATORIO_CABE,
        armazenado: [],
        itemIdImportavel: ITEM_IMPORTAVEL,
      }),
    },
  ])(
    '⛔ C′. QUASE-PAR ($rotulo): os MESMOS pulados de B′, mas sem CPY-4 ⇒ exatamente (1), (2) e (3) em logistica-sem-canal',
    ({ entrada }) => {
      const r = construirLogistica(entrada);
      expect(r.logistic_info).toEqual([]);
      expect(r.pulados).toEqual([
        { logisticId: CANAL_OBRIGATORIO, motivo: 'size-selection-sem-size-id' },
        { logisticId: CANAL_IRMAO, motivo: 'peso-fora-do-limite' },
      ]);
      expect(r.problemas).toEqual([
        semCanal(FRASE_CANAL_OBRIGATORIO_PERDIDO),
        semCanal(FRASE_NENHUM_OBRIGATORIO),
        semCanal(FRASE_NENHUM_CANAL),
      ]);
    },
  );

  it('A′. dois obrigatórios, um N1 (tamanho legível) e um CPY-4 (tarifa ausente), irmão pesado demais ⇒ exatamente essas duas linhas', () => {
    const r = construirLogistica(
      desconfiada({
        canais: [
          canal({
            logistics_channel_id: CANAL_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
            compulsory_channel: true,
          }),
          canal({
            logistics_channel_id: OUTRO_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice,
            compulsory_channel: true,
          }),
          canal({ logistics_channel_id: CANAL_IRMAO, weight_limit: { item_max_weight: 0.1 } }),
        ],
        armazenado: TAMANHO_LEGIVEL,
      }),
    );
    expect(r.logistic_info).toEqual([]);
    expect(r.problemas).toEqual([
      {
        campo: 'logistic_info',
        motivo: 'logistica-nao-confirmada',
        mensagem: fraseNaoConfirmada('um tamanho'),
      },
      semValorGravado(fraseSemValorGravado(ITEM_IMPORTAVEL, String(OUTRO_OBRIGATORIO))),
    ]);
  });

  it('A″. dois obrigatórios, AMBOS CPY-4, irmão enviado ⇒ exatamente as duas CPY-4, nenhuma linha logistica-sem-canal', () => {
    const r = construirLogistica(
      desconfiada({
        canais: [
          canal({
            logistics_channel_id: CANAL_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
            compulsory_channel: true,
          }),
          canal({
            logistics_channel_id: OUTRO_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice,
            compulsory_channel: true,
          }),
          canal({ logistics_channel_id: CANAL_IRMAO }),
        ],
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '' }],
      }),
    );
    expect(r.logistic_info.map((e) => e.logistic_id)).toEqual([CANAL_IRMAO]);
    expect(r.problemas).toEqual([
      semValorGravado(),
      semValorGravado(fraseSemValorGravado(ITEM_IMPORTAVEL, String(OUTRO_OBRIGATORIO))),
    ]);
  });

  it('⛔ D′. QUASE-PAR (mistura): CPY-4 num obrigatório e (1) noutro pesado demais, irmão pesado demais ⇒ CPY-4, (1), (2) e (3)', () => {
    // The weight-fixable channel keeps sentence (1) — and with it both shop-wide
    // rows, which is where the web's weight button belongs.
    const r = construirLogistica(
      desconfiada({
        canais: [
          canal({
            logistics_channel_id: CANAL_OBRIGATORIO,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection,
            compulsory_channel: true,
          }),
          canal({
            logistics_channel_id: OUTRO_OBRIGATORIO,
            compulsory_channel: true,
            weight_limit: { item_max_weight: 0.1 },
          }),
          canal({ logistics_channel_id: CANAL_IRMAO, weight_limit: { item_max_weight: 0.1 } }),
        ],
        armazenado: [],
      }),
    );
    expect(r.logistic_info).toEqual([]);
    expect(r.problemas.map((p) => [p.motivo, p.mensagem])).toEqual([
      ['logistica-sem-valor-gravado', fraseSemValorGravado()],
      ['logistica-sem-canal', frase1Do(OUTRO_OBRIGATORIO)],
      ['logistica-sem-canal', FRASE_NENHUM_OBRIGATORIO],
      ['logistica-sem-canal', FRASE_NENHUM_CANAL],
    ]);
  });
});
