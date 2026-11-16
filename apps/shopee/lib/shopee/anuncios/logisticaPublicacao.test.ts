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
  avaliarCanaisDaLojaShopee,
  cabeNoCanal,
  canalInescapavel,
  canalSelecionavel,
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
 *
 * #1911 P15: `mask_channel_id: 0` is the BR shape (every channel of
 * `get_channel_list.br.json` says 0). The schema's own default is `null`, which
 * is what every OTHER suite's channels carry; both are selectable (D-LOG-1), and
 * the anchor in the P15 mask describe pins the two.
 */
function canal(parcial: Record<string, unknown> = {}): ShopeeLogisticsChannel {
  return shopeeLogisticsChannelSchema.parse({
    logistics_channel_id: CANAL_PADRAO,
    enabled: true,
    fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
    mask_channel_id: 0,
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
  /** #1911 P15: a TRUSTED stored list (the `args()` default), for the one motivo only a list produces. */
  readonly armazenado?: readonly unknown[];
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
  // #1911 P15.
  { motivo: 'canal-de-fulfillment', canal: canal({ mask_channel_id: 4000 }), pesoKg: 0.5 },
  {
    motivo: 'desligado-no-vinculo',
    canal: canal(),
    pesoKg: 0.5,
    armazenado: [{ logistic_id: CANAL_PADRAO, enabled: false }],
  },
];

/**
 * Every member of {@link MotivoCanalPulado}, keyed so the COMPILER checks the
 * set (#1911 P15): a member added to the union without a key here, or a key
 * the union lost, fails typecheck — a hand-written list could not.
 */
const TODOS_OS_MOTIVOS = {
  'nao-habilitado-na-loja': true,
  'peso-fora-do-limite': true,
  'dimensao-fora-do-limite': true,
  'soma-de-dimensoes-excedida': true,
  'unidade-desconhecida': true,
  'size-selection-sem-size-id': true,
  'custom-price-sem-tarifa': true,
  'canal-de-fulfillment': true,
  'desligado-no-vinculo': true,
} as const satisfies Record<MotivoCanalPulado, true>;

// #1911 P15: antes «construirLogistica — os sete motivos de pular um canal».
describe('construirLogistica — os nove motivos de pular um canal', () => {
  it.each(PULADOS)('$motivo é produzível com uma fixture real', (linha) => {
    const r = construirLogistica(
      args({ canais: [linha.canal], pesoKg: linha.pesoKg, armazenado: linha.armazenado ?? null }),
    );
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: linha.motivo }]);
    expect(r.logistic_info).toEqual([]);
  });

  it('a lista de motivos cobre TODOS os membros do tipo — nenhum fica sem produtor', () => {
    const cobertos = new Set(PULADOS.map((l) => l.motivo));
    // #1911 P15: the list is now the compiler-checked record above, never a
    // hand-written array a new member could quietly skip.
    expect([...cobertos].sort()).toEqual(Object.keys(TODOS_OS_MOTIVOS).sort());
    expect(Object.keys(TODOS_OS_MOTIVOS)).toHaveLength(9);
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

  it('#1911 P15: o leitor vem de @delfrance/schemas — o módulo não declara paraInteiroWire, paraNumeroWire nem campo', () => {
    // #1369: the stored entry is read by ONE function, shared with the draft
    // projection. A local copy here is the two-readers smell — the publisher
    // and the editor would read `'90003'` (or a `'0'` size) two ways.
    const DECLARACAO = /function\s+(paraInteiroWire|paraNumeroWire|campo)\s*\(/;
    expect(fonte).not.toMatch(DECLARACAO);
    expect(fonte).toMatch(
      /import\s*\{[^}]*\blerLogisticaArmazenadaShopee\b[^}]*\}\s*from\s*'@delfrance\/schemas'/,
    );
    expect(fonte).toContain('lerLogisticaArmazenadaShopee(');
    // ⛔ QUASE: the pin bites — a re-spelled copy of any of the three matches,
    // while prose naming them (as this file's own docblocks may) does not.
    expect('function paraInteiroWire(bruto: unknown)').toMatch(DECLARACAO);
    expect('function campo (bruto, nome)').toMatch(DECLARACAO);
    expect('moved out of `paraNumeroWire(…)` in #1911 P15').not.toMatch(DECLARACAO);
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

/* -------------------------------------------------------------------------- */
/*   (14) #1911 P15 — a máscara, os desligados do vínculo, o leitor ÚNICO e o   */
/*        veredito por canal da rota canais                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sentence (3b), verbatim (#1911 P15) — the no-channel sentence when a channel
 * the TRUSTED list switched off was among those left out.
 */
const FRASE_3B =
  'Nenhum canal ligado neste vínculo aceita este item (os desligados nele não são usados): ' +
  'confira peso, dimensões e os canais habilitados no Seller Centre — num rascunho, também ' +
  'os canais escolhidos na aba Shopee do produto.';

/** A fulfillment channel's `mask_channel_id` — any non-zero id. */
const MASCARA = 4000;

/** A weight band the default parcel (0.5 kg) does not fit. */
const PESADO_DEMAIS = { weight_limit: { item_max_weight: 0.1 } };

/** A dimension limit stated in a unit `UNIDADES_PARA_CM` does not know. */
const UNIDADE_ESTRANHA = {
  item_max_dimension: { height: 20, width: 20, length: 20, unit: 'polegada' },
};

/** Channel A (`CANAL_PADRAO`) and channel B (`CANAL_IRMAO`), both fit. */
const A_E_B: readonly ShopeeLogisticsChannel[] = [
  canal(),
  canal({ logistics_channel_id: CANAL_IRMAO }),
];

/** Shape A of the switched-off read-back: A on, B listed with `enabled: false`. */
const B_DESLIGADO: readonly unknown[] = [
  { logistic_id: CANAL_PADRAO, enabled: true },
  { logistic_id: CANAL_IRMAO, enabled: false },
];

function idsNoFio(r: ReturnType<typeof construirLogistica>): readonly number[] {
  return r.logistic_info.map((e) => e.logistic_id);
}

/**
 * One truth-table channel, through the schema. An `undefined` cell leaves the
 * key OUT, so the schema's own default (`null`) lands — the "–" of the table.
 */
function canalDaTabela(enabled: unknown, force: unknown, mascara: unknown): ShopeeLogisticsChannel {
  const cru: Record<string, unknown> = {
    logistics_channel_id: CANAL_PADRAO,
    fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
  };
  if (enabled !== undefined) cru.enabled = enabled;
  if (force !== undefined) cru.force_enable = force;
  if (mascara !== undefined) cru.mask_channel_id = mascara;
  return shopeeLogisticsChannelSchema.parse(cru);
}

/** `[enabled, force, mask, ⇒ selecionável, the three raw cells]` — the labels are the title's. */
const TABELA_VERDADE: [string, string, string, boolean, unknown, unknown, unknown][] = [
  ['true', '–', '0', true, true, undefined, 0],
  ['true', '–', 'null', true, true, undefined, null],
  ['true', '–', '4000', false, true, undefined, MASCARA],
  // The fold's SCOPE: the nearest non-zero masks on BOTH sides of 0 are masked
  // too — the rule is «≠ 0», never «= 4000» nor «> 0» (`wireInt()` checks no sign).
  ['true', '–', '1', false, true, undefined, 1],
  ['true', '–', '-1', false, true, undefined, -1],
  ['true', '–', "'0'", true, true, undefined, '0'],
  ['true', '–', "'4000'", false, true, undefined, '4000'],
  ['false', '–', '0', false, false, undefined, 0],
  ['false', '–', 'null', false, false, undefined, null],
  ['null', '–', '0', false, null, undefined, 0],
  ['false', 'true', '0', true, false, true, 0],
  ['–', 'true', '4000', false, undefined, true, MASCARA],
];

describe('#1911 P15 — canalSelecionavel: habilitado na loja E máscara 0 ou ausente (D-LOG-1)', () => {
  it('ÂNCORA: canal() traz mask_channel_id 0 (o formato do BR) ⟷ o canal do schema sem a chave traz null (o das outras suítes)', () => {
    expect(canal().mask_channel_id).toBe(0);
    const semChave = shopeeLogisticsChannelSchema.parse({
      logistics_channel_id: CANAL_PADRAO,
      enabled: true,
    });
    expect(semChave.mask_channel_id).toBeNull();
    expect(canalSelecionavel(canal())).toBe(true);
    expect(canalSelecionavel(semChave)).toBe(true);
  });

  it.each(TABELA_VERDADE)(
    'tabela-verdade: enabled %s, force %s, mask %s ⇒ %s',
    (_e, _f, _m, esperado, enabled, force, mascara) => {
      expect(canalSelecionavel(canalDaTabela(enabled, force, mascara))).toBe(esperado);
    },
  );

  it('ÂNCORA: um canal com mask_channel_id undefined (não parseado) é selecionável', () => {
    const naoParseado = {
      ...canal(),
      mask_channel_id: undefined,
    } as unknown as ShopeeLogisticsChannel;
    expect(naoParseado.mask_channel_id).toBeUndefined();
    expect(canalSelecionavel(naoParseado)).toBe(true);
    // …and the publisher SENDS it: absent is never read as masked.
    expect(idsNoFio(construirLogistica(args({ canais: [naoParseado] })))).toEqual([CANAL_PADRAO]);
  });

  it('UMA regra: o veredito de canalSelecionavel é o da passagem completa (não pulou por nao-habilitado-na-loja nem canal-de-fulfillment)', () => {
    for (const [, , , esperado, enabled, force, mascara] of TABELA_VERDADE) {
      const c = canalDaTabela(enabled, force, mascara);
      const r = construirLogistica(args({ canais: [c] }));
      const pulouNaSelecao = r.pulados.some(
        (p) => p.motivo === 'nao-habilitado-na-loja' || p.motivo === 'canal-de-fulfillment',
      );
      const rotulo = JSON.stringify({ enabled, force, mascara });
      expect(!pulouNaSelecao, rotulo).toBe(canalSelecionavel(c));
      expect(canalSelecionavel(c), rotulo).toBe(esperado);
      // The default parcel fits every row, so a selectable channel is SENT.
      expect(idsNoFio(r), rotulo).toEqual(esperado ? [CANAL_PADRAO] : []);
    }
  });

  it('ORDEM: desligado na loja E mask 4000 ⇒ nao-habilitado-na-loja, nunca canal-de-fulfillment', () => {
    const r = construirLogistica(
      args({ canais: [canal({ enabled: false, mask_channel_id: MASCARA })] }),
    );
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'nao-habilitado-na-loja' }]);
  });

  it("⛔ ORDEM: mask 4000 acima do peso, ou com unidade 'polegada', ⇒ canal-de-fulfillment ⟷ PAR: os mesmos com mask 0 ⇒ peso-fora-do-limite e unidade-desconhecida", () => {
    for (const [parcial, motivoSemMascara] of [
      [PESADO_DEMAIS, 'peso-fora-do-limite'],
      [UNIDADE_ESTRANHA, 'unidade-desconhecida'],
    ] as const) {
      const mascarado = construirLogistica(
        args({ canais: [canal({ ...parcial, mask_channel_id: MASCARA })] }),
      );
      expect(mascarado.pulados, motivoSemMascara).toEqual([
        { logisticId: CANAL_PADRAO, motivo: 'canal-de-fulfillment' },
      ]);
      const semMascara = construirLogistica(args({ canais: [canal(parcial)] }));
      expect(semMascara.pulados, motivoSemMascara).toEqual([
        { logisticId: CANAL_PADRAO, motivo: motivoSemMascara },
      ]);
    }
  });

  it('PAR da passagem completa: mask 4000 ⇒ pulado canal-de-fulfillment e fio vazio ⟷ mask 0 e mask ausente ⇒ enviado', () => {
    const mascarado = construirLogistica(args({ canais: [canal({ mask_channel_id: MASCARA })] }));
    expect(mascarado.pulados).toEqual([
      { logisticId: CANAL_PADRAO, motivo: 'canal-de-fulfillment' },
    ]);
    expect(mascarado.logistic_info).toEqual([]);
    // A masked skip is not a vínculo's off: the no-channel sentence is (3), never (3b).
    expect(mascarado.problemas).toEqual([semCanal(FRASE_NENHUM_CANAL)]);

    const semChave = shopeeLogisticsChannelSchema.parse({
      logistics_channel_id: CANAL_PADRAO,
      enabled: true,
      fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
    });
    for (const c of [canal(), semChave]) {
      expect(
        construirLogistica(args({ canais: [c] })).logistic_info,
        String(c.mask_channel_id),
      ).toEqual([{ logistic_id: CANAL_PADRAO, enabled: true, is_free: false }]);
    }
  });

  it.each([1, 4001, -1])(
    '⛔ QUASE: mask_channel_id %s (não zero, o sinal incluso) ⇒ não selecionável e pulado canal-de-fulfillment — a regra é «≠ 0», nunca «= 4000»',
    (mascara) => {
      expect(canalSelecionavel(canalDaTabela(true, undefined, mascara))).toBe(false);
      const r = construirLogistica(args({ canais: [canal({ mask_channel_id: mascara })] }));
      expect(idsNoFio(r)).toEqual([]);
      expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'canal-de-fulfillment' }]);
    },
  );

  it('as DUAS passagens: a lista confiável [A] com A em mask 4000 ⇒ pulado nas duas; o irmão B em mask 0 vai', () => {
    const r = construirLogistica(
      args({
        canais: [canal({ mask_channel_id: MASCARA }), canal({ logistics_channel_id: CANAL_IRMAO })],
        armazenado: [{ logistic_id: CANAL_PADRAO }],
      }),
    );
    // The stored pass skipped A (it would otherwise have sent A ALONE), and the
    // full pass skipped it again — its `pulados` are the ones reported.
    expect(idsNoFio(r)).toEqual([CANAL_IRMAO]);
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'canal-de-fulfillment' }]);
    // ⚠️ PAR: the same list with A at mask 0 — the stored list wins, B stays off.
    const semMascara = construirLogistica(
      args({ canais: A_E_B, armazenado: [{ logistic_id: CANAL_PADRAO }] }),
    );
    expect(idsNoFio(semMascara)).toEqual([CANAL_PADRAO]);
  });
});

describe('#1911 P15 — o canal de fulfillment obrigatório fica na frase (1), nunca N1/CPY-4', () => {
  it('desconfiada, SIZE_SELECTION obrigatório em mask 4000 com tamanho legível ⇒ pulado canal-de-fulfillment e a frase (1), nunca logistica-nao-confirmada', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection, {
          mask_channel_id: MASCARA,
        }),
        armazenado: TAMANHO_LEGIVEL,
      }),
    );
    expect(r.pulados).toEqual([{ logisticId: CANAL_OBRIGATORIO, motivo: 'canal-de-fulfillment' }]);
    expect(idsNoFio(r)).toEqual([CANAL_IRMAO]);
    expect(r.problemas).toEqual([
      semCanal(FRASE_CANAL_OBRIGATORIO_PERDIDO),
      semCanal(FRASE_NENHUM_OBRIGATORIO),
    ]);
    expect(motivosDosProblemas(r)).not.toContain('logistica-nao-confirmada');
    // ⚠️ PAR: the SAME channel at mask 0 is N1's (the #2015 table's row) — the mask moved it.
    const semMascara = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: TAMANHO_LEGIVEL,
      }),
    );
    expect(motivosDosProblemas(semMascara)).toEqual(['logistica-nao-confirmada']);
  });

  it('o mesmo sem valor gravado ⇒ a frase (1), nunca logistica-sem-valor-gravado', () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection, {
          mask_channel_id: MASCARA,
        }),
        armazenado: [],
      }),
    );
    expect(r.pulados).toEqual([{ logisticId: CANAL_OBRIGATORIO, motivo: 'canal-de-fulfillment' }]);
    expect(r.problemas).toEqual([
      semCanal(FRASE_CANAL_OBRIGATORIO_PERDIDO),
      semCanal(FRASE_NENHUM_OBRIGATORIO),
    ]);
    expect(motivosDosProblemas(r)).not.toContain('logistica-sem-valor-gravado');
    // ⚠️ PAR: at mask 0 the same empty list is CPY-4's.
    const semMascara = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [],
      }),
    );
    expect(semMascara.problemas).toEqual([semValorGravado()]);
  });
});

describe('#1911 P15 — a lista CONFIÁVEL desliga um canal só com enabled: false (D-LOG-3, D-12)', () => {
  it('⭐ PAR forma A ≡ forma B: [{A, on}, {B, enabled:false}] e [{A, on}] mandam o MESMO fio [A], ambas com problemas [] — a forma A registra B desligado-no-vinculo', () => {
    const formaA = construirLogistica(args({ canais: A_E_B, armazenado: B_DESLIGADO }));
    const formaB = construirLogistica(
      args({ canais: A_E_B, armazenado: [{ logistic_id: CANAL_PADRAO, enabled: true }] }),
    );
    expect(formaA.logistic_info).toEqual([
      { logistic_id: CANAL_PADRAO, enabled: true, is_free: false },
    ]);
    expect(formaB.logistic_info).toEqual(formaA.logistic_info);
    expect(formaA.canaisHabilitados).toEqual(formaB.canaisHabilitados);
    expect(formaA.problemas).toEqual([]);
    expect(formaB.problemas).toEqual([]);
    expect(formaA.pulados).toEqual([{ logisticId: CANAL_IRMAO, motivo: 'desligado-no-vinculo' }]);
    expect(formaB.pulados).toEqual([]);
  });

  it.each([
    ['true', { enabled: true }],
    ['null', { enabled: null }],
    ['ausente', {}],
    ["'false'", { enabled: 'false' }],
    ['0', { enabled: 0 }],
  ] as [string, Record<string, unknown>][])(
    '⛔ QUASE: B com enabled %s é ENVIADO',
    (_rotulo, deB) => {
      const r = construirLogistica(
        args({
          canais: A_E_B,
          armazenado: [
            { logistic_id: CANAL_PADRAO, enabled: true },
            { logistic_id: CANAL_IRMAO, ...deB },
          ],
        }),
      );
      expect(idsNoFio(r)).toEqual([CANAL_PADRAO, CANAL_IRMAO]);
      expect(r.pulados).toEqual([]);
    },
  );

  it('⛔ QUASE: a MESMA lista DESCONFIADA manda A e B — o desligado de uma lista legada não vale', () => {
    const r = construirLogistica(desconfiada({ canais: A_E_B, armazenado: B_DESLIGADO }));
    expect(idsNoFio(r)).toEqual([CANAL_PADRAO, CANAL_IRMAO]);
    expect(r.pulados).toEqual([]);
    expect(r.problemas).toEqual([]);
  });

  it('no fio toda entrada é enabled: true e B não aparece', () => {
    const r = construirLogistica(args({ canais: A_E_B, armazenado: B_DESLIGADO }));
    expect(r.logistic_info.length).toBeGreaterThan(0);
    expect(r.logistic_info.every((e) => e.enabled === true)).toBe(true);
    expect(idsNoFio(r)).not.toContain(CANAL_IRMAO);
    expect(r.canaisHabilitados).not.toContain(CANAL_IRMAO);
  });

  it('force_enable vence o desligado: B force, desligado e com is_free true guardados, A acima do peso ⇒ B enviado PELA PASSAGEM GUARDADA (is_free true com a flag do produto false), pulados só A peso, problemas []', () => {
    const r = construirLogistica(
      args({
        canais: [
          canal(PESADO_DEMAIS),
          canal({ logistics_channel_id: CANAL_IRMAO, force_enable: true }),
        ],
        armazenado: [
          { logistic_id: CANAL_PADRAO, enabled: true },
          { logistic_id: CANAL_IRMAO, enabled: false, is_free: true },
        ],
        ofereceFreteGratis: false,
      }),
    );
    // `is_free: true` exists only in the STORED entry: a full pass would send the produto's false.
    expect(r.logistic_info).toEqual([{ logistic_id: CANAL_IRMAO, enabled: true, is_free: true }]);
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'peso-fora-do-limite' }]);
    expect(r.problemas).toEqual([]);
  });

  it('um obrigatório (não force) desligado no vínculo NÃO vira a frase (1) e a frase (2) aparece ⟷ PAR: com outro obrigatório C guardado ligado e enviado, a (2) não aparece', () => {
    const obrigatorioB = canal({ logistics_channel_id: CANAL_IRMAO, compulsory_channel: true });
    const r = construirLogistica(
      args({ canais: [canal(), obrigatorioB], armazenado: B_DESLIGADO }),
    );
    expect(idsNoFio(r)).toEqual([CANAL_PADRAO]);
    expect(r.pulados).toEqual([{ logisticId: CANAL_IRMAO, motivo: 'desligado-no-vinculo' }]);
    expect(r.problemas).toEqual([semCanal(FRASE_NENHUM_OBRIGATORIO)]);
    expect(r.problemas.map((p) => p.mensagem)).not.toContain(frase1Do(CANAL_IRMAO));

    const comC = construirLogistica(
      args({
        canais: [
          canal(),
          obrigatorioB,
          canal({ logistics_channel_id: OUTRO_OBRIGATORIO, compulsory_channel: true }),
        ],
        armazenado: [...B_DESLIGADO, { logistic_id: OUTRO_OBRIGATORIO, enabled: true }],
      }),
    );
    expect(idsNoFio(comC)).toEqual([CANAL_PADRAO, OUTRO_OBRIGATORIO]);
    expect(comC.problemas).toEqual([]);
  });

  it('ORDEM do diagnóstico: um desligado guardado num canal desligado na loja ⇒ desligado-no-vinculo; num canal que sumiu da lista ⇒ nao-habilitado-na-loja', () => {
    const desligadoNaLoja = construirLogistica(
      args({
        canais: [canal(), canal({ logistics_channel_id: CANAL_IRMAO, enabled: false })],
        armazenado: B_DESLIGADO,
      }),
    );
    expect(desligadoNaLoja.pulados).toEqual([
      { logisticId: CANAL_IRMAO, motivo: 'desligado-no-vinculo' },
    ]);
    // The list's off is read before the channel's own checks — a masked B too.
    const mascarado = construirLogistica(
      args({
        canais: [canal(), canal({ logistics_channel_id: CANAL_IRMAO, mask_channel_id: MASCARA })],
        armazenado: B_DESLIGADO,
      }),
    );
    expect(mascarado.pulados).toEqual([
      { logisticId: CANAL_IRMAO, motivo: 'desligado-no-vinculo' },
    ]);
    const sumiu = construirLogistica(args({ canais: [canal()], armazenado: B_DESLIGADO }));
    expect(sumiu.pulados).toEqual([{ logisticId: CANAL_IRMAO, motivo: 'nao-habilitado-na-loja' }]);
  });
});

describe('#1911 P15 — o recurso à passagem completa não religa um canal desligado (D-LOG-4, D-11) e a frase (3b)', () => {
  /** B first in the LIVE list, A first in the stored one — so the order says which pass reported. */
  const B_E_A_PESADO: readonly ShopeeLogisticsChannel[] = [
    canal({ logistics_channel_id: CANAL_IRMAO }),
    canal(PESADO_DEMAIS),
  ];

  it('confiável [{A, on}, {B, off}], A acima do peso, B cabe ⇒ fio [], pulados A peso e B desligado (na ordem da lista viva), problemas = EXATAMENTE a (3b)', () => {
    const r = construirLogistica(args({ canais: B_E_A_PESADO, armazenado: B_DESLIGADO }));
    expect(r.logistic_info).toEqual([]);
    expect(r.pulados).toEqual([
      { logisticId: CANAL_IRMAO, motivo: 'desligado-no-vinculo' },
      { logisticId: CANAL_PADRAO, motivo: 'peso-fora-do-limite' },
    ]);
    expect(r.problemas).toEqual([semCanal(FRASE_3B)]);
  });

  // D15-6: the full pass skips a `desligados` id BEFORE the channel's own
  // checks. Every other full-pass test above has the off channel FITTING, so a
  // pass that asked the off only of a channel that validates stayed green.
  it.each([
    ['acima do peso', PESADO_DEMAIS],
    ['mascarado (mask 4000)', { mask_channel_id: MASCARA }],
  ] as [string, Record<string, unknown>][])(
    '⛔ ORDEM (D15-6): confiável [{A, on}, {B, off}], A acima do peso e B %s ⇒ B sai desligado-no-vinculo (nunca o motivo das próprias checagens) e a frase é a (3b); B obrigatório nunca vira a frase (1)',
    (_rotulo, deB) => {
      const r = construirLogistica(
        args({
          canais: [canal({ logistics_channel_id: CANAL_IRMAO, ...deB }), canal(PESADO_DEMAIS)],
          armazenado: B_DESLIGADO,
        }),
      );
      expect(r.logistic_info).toEqual([]);
      expect(r.pulados).toEqual([
        { logisticId: CANAL_IRMAO, motivo: 'desligado-no-vinculo' },
        { logisticId: CANAL_PADRAO, motivo: 'peso-fora-do-limite' },
      ]);
      expect(r.problemas).toEqual([semCanal(FRASE_3B)]);

      // A switched-off channel is never a lost compulsory one, on the fallback too.
      const obrigatorio = construirLogistica(
        args({
          canais: [
            canal({ logistics_channel_id: CANAL_IRMAO, compulsory_channel: true, ...deB }),
            canal(PESADO_DEMAIS),
          ],
          armazenado: B_DESLIGADO,
        }),
      );
      expect(obrigatorio.pulados.filter((p) => p.logisticId === CANAL_IRMAO)).toEqual([
        { logisticId: CANAL_IRMAO, motivo: 'desligado-no-vinculo' },
      ]);
      expect(obrigatorio.problemas.map((p) => p.mensagem)).not.toContain(frase1Do(CANAL_IRMAO));
      expect(obrigatorio.problemas).toEqual([
        semCanal(FRASE_NENHUM_OBRIGATORIO),
        semCanal(FRASE_3B),
      ]);
    },
  );

  it('RESÍDUO forma B (o do main): [{A, on}], A acima do peso ⇒ o recurso manda B', () => {
    const r = construirLogistica(
      args({ canais: B_E_A_PESADO, armazenado: [{ logistic_id: CANAL_PADRAO, enabled: true }] }),
    );
    expect(idsNoFio(r)).toEqual([CANAL_IRMAO]);
    expect(r.problemas).toEqual([]);
  });

  it('⛔ QUASE: [{A, on}] com só A, acima do peso ⇒ a frase (3) VERBATIM, nunca a (3b)', () => {
    const r = construirLogistica(
      args({
        canais: [canal(PESADO_DEMAIS)],
        armazenado: [{ logistic_id: CANAL_PADRAO, enabled: true }],
      }),
    );
    expect(r.problemas).toEqual([semCanal(FRASE_NENHUM_CANAL)]);
  });

  it('a lista confiável toda desligada [{A, off}] com A e B vivos ⇒ fio [B] (D-11 literal; inalcançável pelo P16 e pela Shopee)', () => {
    const r = construirLogistica(
      args({ canais: A_E_B, armazenado: [{ logistic_id: CANAL_PADRAO, enabled: false }] }),
    );
    expect(idsNoFio(r)).toEqual([CANAL_IRMAO]);
    expect(r.pulados).toEqual([{ logisticId: CANAL_PADRAO, motivo: 'desligado-no-vinculo' }]);
    expect(r.problemas).toEqual([]);
  });

  it('DISJUNTA do P14b: a MESMA lista desconfiada, tudo acima do peso ⇒ a (3), nunca a (3b)', () => {
    const r = construirLogistica(
      desconfiada({
        canais: [
          canal(PESADO_DEMAIS),
          canal({ logistics_channel_id: CANAL_IRMAO, ...PESADO_DEMAIS }),
        ],
        armazenado: B_DESLIGADO,
      }),
    );
    expect(r.pulados).toEqual([
      { logisticId: CANAL_PADRAO, motivo: 'peso-fora-do-limite' },
      { logisticId: CANAL_IRMAO, motivo: 'peso-fora-do-limite' },
    ]);
    expect(r.problemas).toEqual([semCanal(FRASE_NENHUM_CANAL)]);
  });

  it('a (3b) não é frase de terminal: sem --x, :anuncio nem comando; ≤ 500 caracteres', () => {
    const r = construirLogistica(args({ canais: B_E_A_PESADO, armazenado: B_DESLIGADO }));
    const frase3b = r.problemas[0];
    expect(frase3b?.mensagem).toBe(FRASE_3B);
    expect(frase3b).toBeDefined();
    if (frase3b === undefined) return;
    expect(() => exigirAcaoSeHaComando(frase3b)).not.toThrow();
    expect(frase3b.mensagem).not.toMatch(/(^|[\s(])--[a-z]|:anuncio\b|\bcomandos?\b/i);
    expect('acao' in frase3b).toBe(false);
    expect(frase3b.mensagem.length).toBeLessThanOrEqual(500);
  });
});

describe('#1911 P15 — o leitor ÚNICO (lerLogisticaArmazenadaShopee) no publicador', () => {
  it("⚠️ PAR: confiável [{logistic_id: '90003'}] ≡ [{logistic_id: 90003}] ⇒ fio [A]", () => {
    for (const id of [CANAL_PADRAO, String(CANAL_PADRAO), `0${String(CANAL_PADRAO)}`]) {
      const r = construirLogistica(args({ canais: A_E_B, armazenado: [{ logistic_id: id }] }));
      expect(idsNoFio(r), JSON.stringify(id)).toEqual([CANAL_PADRAO]);
    }
  });

  it.each(['', ` ${String(CANAL_PADRAO)}`, `${String(CANAL_PADRAO)}.0`, 0, 1.5, -1, '1e5'])(
    '⛔ QUASE: logistic_id %j sai ⇒ o recurso manda [A, B]',
    (id) => {
      const r = construirLogistica(args({ canais: A_E_B, armazenado: [{ logistic_id: id }] }));
      expect(idsNoFio(r)).toEqual([CANAL_PADRAO, CANAL_IRMAO]);
    },
  );

  it("a dobra do id chega ao remédio: desconfiada, SIZE_SELECTION obrigatório, [{logistic_id '90007', size_id '7'}] ⇒ N1 ⟷ QUASE: ' 90007' ⇒ CPY-4", () => {
    const canais = canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection);
    const n1 = construirLogistica(
      desconfiada({
        canais,
        armazenado: [{ logistic_id: String(CANAL_OBRIGATORIO), size_id: '7' }],
      }),
    );
    expect(n1.problemas).toEqual([
      {
        campo: 'logistic_info',
        motivo: 'logistica-nao-confirmada',
        mensagem: fraseNaoConfirmada('um tamanho'),
      },
    ]);
    const cpy4 = construirLogistica(
      desconfiada({
        canais,
        armazenado: [{ logistic_id: ` ${String(CANAL_OBRIGATORIO)}`, size_id: '7' }],
      }),
    );
    expect(cpy4.problemas).toEqual([semValorGravado()]);
  });

  it('⛔ tarifa: CUSTOM_PRICE confiável só com estimated_shipping_fee ⇒ pulado custom-price-sem-tarifa e nenhum shipping_fee no fio ⟷ PAR: shipping_fee 7.18 ⇒ enviado com 7.18', () => {
    const canais = [canal({ fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice })];
    // The parsed read-back shape: `shipping_fee: null` beside an estimate.
    const estimativa = construirLogistica(
      args({
        canais,
        armazenado: [
          { logistic_id: CANAL_PADRAO, shipping_fee: null, estimated_shipping_fee: 7.18 },
        ],
      }),
    );
    expect(estimativa.pulados).toEqual([
      { logisticId: CANAL_PADRAO, motivo: 'custom-price-sem-tarifa' },
    ]);
    expect(estimativa.logistic_info.some((e) => 'shipping_fee' in e)).toBe(false);
    const tarifa = construirLogistica(
      args({ canais, armazenado: [{ logistic_id: CANAL_PADRAO, shipping_fee: 7.18 }] }),
    );
    expect(tarifa.logistic_info).toEqual([
      { logistic_id: CANAL_PADRAO, enabled: true, is_free: false, shipping_fee: 7.18 },
    ]);
  });

  it('⛔ desconfiada, CUSTOM_PRICE obrigatório só com estimated_shipping_fee ⇒ CPY-4, nunca N1 ⟷ PAR: shipping_fee 7.18 ⇒ N1', () => {
    const canais = canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.customPrice);
    const cpy4 = construirLogistica(
      desconfiada({
        canais,
        armazenado: [
          { logistic_id: CANAL_OBRIGATORIO, shipping_fee: null, estimated_shipping_fee: 7.18 },
        ],
      }),
    );
    expect(cpy4.problemas).toEqual([semValorGravado()]);
    const n1 = construirLogistica(
      desconfiada({
        canais,
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, shipping_fee: 7.18 }],
      }),
    );
    expect(n1.problemas).toEqual([
      {
        campo: 'logistic_info',
        motivo: 'logistica-nao-confirmada',
        mensagem: fraseNaoConfirmada('uma tarifa de frete'),
      },
    ]);
  });

  it("⛔ SIZE_SELECTION confiável com size_id 0 ⇒ pulado size-selection-sem-size-id ⟷ PAR: size_id '7' ⇒ enviado com 7", () => {
    const canais = [canal(SIZE_SELECTION)];
    const zero = construirLogistica(
      args({ canais, armazenado: [{ logistic_id: CANAL_PADRAO, size_id: 0 }] }),
    );
    expect(zero.pulados).toEqual([
      { logisticId: CANAL_PADRAO, motivo: 'size-selection-sem-size-id' },
    ]);
    expect(zero.logistic_info).toEqual([]);
    const sete = construirLogistica(
      args({ canais, armazenado: [{ logistic_id: CANAL_PADRAO, size_id: '7' }] }),
    );
    expect(sete.logistic_info).toEqual([
      { logistic_id: CANAL_PADRAO, enabled: true, is_free: false, size_id: 7 },
    ]);
  });

  it("⛔ o remédio NÃO filtra por enabled: desconfiada, [{90007, size_id '7', enabled: false}] ⇒ N1, nunca CPY-4", () => {
    const r = construirLogistica(
      desconfiada({
        canais: canaisComObrigatorio(SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection),
        armazenado: [{ logistic_id: CANAL_OBRIGATORIO, size_id: '7', enabled: false }],
      }),
    );
    // A distrusted off is not honoured: the channel is skipped for its SIZE only.
    expect(r.pulados).toEqual([
      { logisticId: CANAL_OBRIGATORIO, motivo: 'size-selection-sem-size-id' },
    ]);
    expect(r.problemas).toEqual([
      {
        campo: 'logistic_info',
        motivo: 'logistica-nao-confirmada',
        mensagem: fraseNaoConfirmada('um tamanho'),
      },
    ]);
  });
});

/** The ids of the mixed list — invented, never a real channel's. */
const MISTA_BASE = 90_100;

interface LinhaAvaliada {
  readonly rotulo: string;
  readonly canal: ShopeeLogisticsChannel;
  readonly selecionavel: boolean;
  readonly obrigatorio: boolean;
  readonly motivo: MotivoCanalPulado | null;
}

/** `[rótulo, the channel's fields, selecionável, obrigatório, motivo]`. */
type LinhaMistaCrua = [string, Record<string, unknown>, boolean, boolean, MotivoCanalPulado | null];

/** One row of each class the `canais` route shows — fits, does not fit, not selectable. */
const LINHAS_MISTAS: LinhaMistaCrua[] = [
  ['habilitado', {}, true, false, null],
  ['desligado na loja', { enabled: false }, false, false, 'nao-habilitado-na-loja'],
  ['mascarado', { mask_channel_id: MASCARA }, false, false, 'canal-de-fulfillment'],
  ['force + desligado', { enabled: false, force_enable: true }, true, true, null],
  ['obrigatório', { compulsory_channel: true }, true, true, null],
  ['acima do peso', PESADO_DEMAIS, true, false, 'peso-fora-do-limite'],
  ["unidade 'polegada'", UNIDADE_ESTRANHA, true, false, 'unidade-desconhecida'],
  [
    'SIZE_SELECTION',
    { fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeSelection },
    true,
    false,
    'size-selection-sem-size-id',
  ],
  [
    'CUSTOM_PRICE',
    { fee_type: SHOPEE_LOGISTICS_FEE_TYPE.customPrice },
    true,
    false,
    'custom-price-sem-tarifa',
  ],
  ['bloqueio + frete grátis', { block_seller_cover_shipping_fee: true }, true, false, null],
];

const MISTA: readonly LinhaAvaliada[] = LINHAS_MISTAS.map(
  ([rotulo, parcial, selecionavel, obrigatorio, motivo], i) => ({
    rotulo,
    canal: canal({ ...parcial, logistics_channel_id: MISTA_BASE + i }),
    selecionavel,
    obrigatorio,
    motivo,
  }),
);

/** The parcel of the mixed list: the default one, WITH the produto's free-shipping offer. */
const PARCELA_GRATIS = { pesoKg: 0.5, dimensaoCm: DIM_10, ofereceFreteGratis: true } as const;

describe('#1911 P15 — avaliarCanaisDaLojaShopee: o veredito por canal é o da passagem completa', () => {
  const avaliados = avaliarCanaisDaLojaShopee({
    ...PARCELA_GRATIS,
    canais: MISTA.map((l) => l.canal),
  });

  it('para cada linha de uma lista mista: entrada ⇔ motivo null; motivo null ⇒ selecionavel; selecionavel = canalSelecionavel; obrigatorio = canalInescapavel', () => {
    expect(avaliados).toHaveLength(MISTA.length);
    MISTA.forEach((linha, i) => {
      const a = avaliados[i];
      expect(a?.canal, linha.rotulo).toBe(linha.canal);
      expect(a?.selecionavel, linha.rotulo).toBe(linha.selecionavel);
      expect(a?.obrigatorio, linha.rotulo).toBe(linha.obrigatorio);
      expect(a?.motivo ?? null, linha.rotulo).toBe(linha.motivo);
      expect(a?.entrada !== null, linha.rotulo).toBe(a?.motivo === null);
      if (a?.motivo === null) expect(a.selecionavel, linha.rotulo).toBe(true);
      expect(a?.selecionavel, linha.rotulo).toBe(canalSelecionavel(linha.canal));
      expect(a?.obrigatorio, linha.rotulo).toBe(canalInescapavel(linha.canal));
    });
    // ÂNCORA: at least one row of each class the route shows.
    expect(avaliados.some((a) => a.motivo === null)).toBe(true);
    expect(avaliados.some((a) => a.selecionavel && a.motivo !== null)).toBe(true);
    expect(avaliados.some((a) => !a.selecionavel)).toBe(true);
    expect(avaliados.some((a) => a.obrigatorio && a.canal.compulsory_channel !== true)).toBe(true);
  });

  it('⭐ UMA cópia: as entradas de avaliar são EXATAMENTE o logistic_info de construirLogistica sem lista guardada, na mesma ordem', () => {
    const canais = MISTA.map((l) => l.canal);
    for (const construida of [
      construirLogistica(args({ ...PARCELA_GRATIS, canais, armazenado: null })),
      construirLogistica(desconfiada({ ...PARCELA_GRATIS, canais, armazenado: null })),
    ]) {
      const entradas = avaliados.flatMap((a) => (a.entrada === null ? [] : [a.entrada]));
      expect(entradas.length).toBeGreaterThan(0);
      expect(entradas).toEqual(construida.logistic_info);
      // …and the skips are the full pass's, channel for channel.
      expect(
        avaliados.flatMap((a) =>
          a.motivo === null ? [] : [{ logisticId: a.canal.logistics_channel_id, motivo: a.motivo }],
        ),
      ).toEqual(construida.pulados);
    }
  });

  it('o bloqueio mascara is_free: block + ofereceFreteGratis ⇒ is_free false ⟷ QUASE: sem o bloqueio ⇒ true', () => {
    const [bloqueado] = avaliarCanaisDaLojaShopee({
      ...PARCELA_GRATIS,
      canais: [canal({ block_seller_cover_shipping_fee: true })],
    });
    expect(bloqueado?.entrada?.is_free).toBe(false);
    const [livre] = avaliarCanaisDaLojaShopee({ ...PARCELA_GRATIS, canais: [canal()] });
    expect(livre?.entrada?.is_free).toBe(true);
    // ⛔ QUASE: without the produto's offer, false on both.
    const [semOferta] = avaliarCanaisDaLojaShopee({
      ...PARCELA_GRATIS,
      ofereceFreteGratis: false,
      canais: [canal()],
    });
    expect(semOferta?.entrada?.is_free).toBe(false);
  });

  it('o canal mascarado acima do peso é canal-de-fulfillment, não selecionável e sem entrada', () => {
    const [mascarado] = avaliarCanaisDaLojaShopee({
      ...PARCELA_GRATIS,
      canais: [canal({ ...PESADO_DEMAIS, mask_channel_id: MASCARA })],
    });
    expect(mascarado).toMatchObject({
      motivo: 'canal-de-fulfillment',
      selecionavel: false,
      entrada: null,
    });
    // ⚠️ PAR: at mask 0 it is selectable and does not fit.
    const [pesado] = avaliarCanaisDaLojaShopee({
      ...PARCELA_GRATIS,
      canais: [canal(PESADO_DEMAIS)],
    });
    expect(pesado).toMatchObject({
      motivo: 'peso-fora-do-limite',
      selecionavel: true,
      entrada: null,
    });
  });

  it('nunca responde desligado-no-vinculo (não há lista guardada aqui)', () => {
    const todos = avaliarCanaisDaLojaShopee({
      ...PARCELA_GRATIS,
      canais: [...MISTA.map((l) => l.canal), ...PULADOS.map((l) => l.canal)],
    });
    expect(todos.some((a) => a.motivo !== null)).toBe(true);
    expect(todos.map((a) => a.motivo)).not.toContain('desligado-no-vinculo');
    // The PULADOS row for it is a fitting channel: here it is simply sent.
    const [linhaDoDesligado] = PULADOS.filter((l) => l.motivo === 'desligado-no-vinculo');
    expect(linhaDoDesligado).toBeDefined();
    if (linhaDoDesligado === undefined) return;
    const [avaliado] = avaliarCanaisDaLojaShopee({
      ...PARCELA_GRATIS,
      canais: [linhaDoDesligado.canal],
    });
    expect(avaliado?.motivo).toBeNull();
  });

  it('uma linha ilegível (null) da lista de canais sai, como em construirLogistica', () => {
    const comNulo = [null, canal()] as unknown as readonly ShopeeLogisticsChannel[];
    const avaliadosComNulo = avaliarCanaisDaLojaShopee({ ...PARCELA_GRATIS, canais: comNulo });
    expect(avaliadosComNulo.map((a) => a.canal.logistics_channel_id)).toEqual([CANAL_PADRAO]);
  });
});
