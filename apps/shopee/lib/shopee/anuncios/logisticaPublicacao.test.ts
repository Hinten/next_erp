import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_LOGISTICS_FEE_TYPE,
  type ShopeeDimensionRequest,
  type ShopeeLogisticsChannel,
  shopeeLogisticsChannelSchema,
} from '@delfrance/integrations-shopee';

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

function args(parcial: Partial<ArgsLogistica> = {}): ArgsLogistica {
  return {
    canais: [canal()],
    armazenado: null,
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
});
