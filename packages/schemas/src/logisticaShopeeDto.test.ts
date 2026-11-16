import { describe, expect, it } from 'vitest';

import * as barrel from './index';
import {
  type CanalDaLojaShopeeDto,
  type RespostaCanaisShopee,
  MOTIVO_INDISPONIVEL_CANAL_SHOPEE,
  canalDaLojaShopeeDtoSchema,
  motivoIndisponivelCanalShopeeSchema,
  respostaCanaisShopeeSchema,
} from './logisticaShopeeDto';

/**
 * The Shopee CHANNELS route envelope (#1911 P15), declared once for
 * `apps/shopee` (which builds it) and `apps/web` (P16, which parses it). What is
 * pinned here is the CONTRACT both sides share: the exact key sets (no size,
 * no fee — Lucas 11-04), strict numbers (our own answer), every key required,
 * and unknown keys stripped (the two apps deploy separately).
 *
 * ⚠️ Every "passa" below is worthless alone — `z.any()` passes it. The
 * near-miss rows (one key missing, one number quoted, one token unknown) are
 * the controls.
 */

/** Synthetic channel ids of the plan's range — never a real shop's. */
const DESLIGADO = 90006;

/** A selectable channel that fits, as the BR shop answers it: no block, the full pass sends `is_free: false`. */
function canal(
  sobre: Partial<Record<keyof CanalDaLojaShopeeDto, unknown>> = {},
): Record<string, unknown> {
  return {
    logisticsChannelId: 90003,
    nome: 'Entrega Padrão',
    selecionavel: true,
    obrigatorio: false,
    bloqueiaFreteGratisDoVendedor: false,
    indisponivel: null,
    automatica: { isFree: false },
    ...sobre,
  };
}

/**
 * A BR-shaped answer: four channels, the one disabled at shop level not
 * selectable and with no automatic entry, the other three selectable and sent
 * by the full pass with `is_free: false`.
 */
function resposta(
  sobre: Partial<Record<keyof RespostaCanaisShopee, unknown>> = {},
): Record<string, unknown> {
  return {
    medidasCompletas: true,
    canais: [
      canal(),
      canal({ logisticsChannelId: 90004, nome: 'Entrega Rápida' }),
      canal({ logisticsChannelId: 90005, nome: 'Retirada no Ponto' }),
      canal({
        logisticsChannelId: DESLIGADO,
        nome: 'Canal Desligado',
        selecionavel: false,
        automatica: null,
      }),
    ],
    ...sobre,
  };
}

const CHAVES_DA_LINHA = [
  'logisticsChannelId',
  'nome',
  'selecionavel',
  'obrigatorio',
  'bloqueiaFreteGratisDoVendedor',
  'indisponivel',
  'automatica',
] as const;

describe('respostaCanaisShopeeSchema — o envelope da rota canais (#1911 P15)', () => {
  it('PAR: uma resposta no formato do BR passa (4 canais: o desligado sem automatica, os outros três com {isFree: false})', () => {
    const lida = respostaCanaisShopeeSchema.parse(resposta());
    expect(lida).toEqual(resposta());
    expect(lida.canais).toHaveLength(4);
    expect(
      lida.canais.filter((c) => c.automatica === null).map((c) => c.logisticsChannelId),
    ).toEqual([DESLIGADO]);
    expect(lida.canais.filter((c) => c.selecionavel).map((c) => c.automatica)).toEqual([
      { isFree: false },
      { isFree: false },
      { isFree: false },
    ]);
  });

  it('PAR: indisponivel null e cada uma das três opções passam; nome null e automatica {isFree: true} também', () => {
    for (const indisponivel of [null, ...motivoIndisponivelCanalShopeeSchema.options]) {
      const corpo = resposta({ canais: [canal({ indisponivel, automatica: null })] });
      expect(respostaCanaisShopeeSchema.safeParse(corpo).success, String(indisponivel)).toBe(true);
    }
    const semNome = resposta({ canais: [canal({ nome: null, automatica: { isFree: true } })] });
    expect(respostaCanaisShopeeSchema.parse(semNome)).toEqual(semNome);
    expect(respostaCanaisShopeeSchema.safeParse(resposta({ canais: [] })).success).toBe(true);
  });

  it.each<unknown>(['cabe', 'CM', 'nao-habilitado-na-loja', 'peso-fora-do-limite', ''])(
    '⛔ QUASE: indisponivel %j recusa',
    (indisponivel) => {
      const corpo = resposta({ canais: [canal({ indisponivel })] });
      expect(respostaCanaisShopeeSchema.safeParse(corpo).success).toBe(false);
    },
  );

  it.each<[string, 'linha' | 'envelope']>([
    ...CHAVES_DA_LINHA.map((chave): [string, 'linha'] => [chave, 'linha']),
    ['medidasCompletas', 'envelope'],
    ['canais', 'envelope'],
  ])('⛔ QUASE: sem a chave %s recusa', (chave, onde) => {
    const semChave = (corpo: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(corpo).filter(([k]) => k !== chave));
    const corpo =
      onde === 'linha' ? resposta({ canais: [semChave(canal())] }) : semChave(resposta());
    // The control: the same body WITH the key passes.
    expect(respostaCanaisShopeeSchema.safeParse(resposta()).success).toBe(true);
    expect(respostaCanaisShopeeSchema.safeParse(corpo).success).toBe(false);
  });

  it.each<unknown>(['90003', 0, -1, 1.5, null])(
    '⛔ QUASE: logisticsChannelId %j recusa — a nossa própria resposta é ESTRITA nos números',
    (logisticsChannelId) => {
      const corpo = resposta({ canais: [canal({ logisticsChannelId })] });
      expect(respostaCanaisShopeeSchema.safeParse(corpo).success).toBe(false);
    },
  );

  it("⛔ QUASE: automatica {isFree: 'false'} recusa", () => {
    for (const automatica of [{ isFree: 'false' }, { isFree: 0 }, {}, true]) {
      const corpo = resposta({ canais: [canal({ automatica })] });
      expect(respostaCanaisShopeeSchema.safeParse(corpo).success, JSON.stringify(automatica)).toBe(
        false,
      );
    }
  });

  it('⛔ QUASE: os booleanos são booleanos — "true", 1 e null recusam em selecionavel, obrigatorio, bloqueio e medidasCompletas', () => {
    for (const ruim of ['true', 1, null]) {
      for (const chave of [
        'selecionavel',
        'obrigatorio',
        'bloqueiaFreteGratisDoVendedor',
      ] as const) {
        const corpo = resposta({ canais: [canal({ [chave]: ruim })] });
        expect(
          respostaCanaisShopeeSchema.safeParse(corpo).success,
          `${chave}=${String(ruim)}`,
        ).toBe(false);
      }
      expect(
        respostaCanaisShopeeSchema.safeParse(resposta({ medidasCompletas: ruim })).success,
        `medidasCompletas=${String(ruim)}`,
      ).toBe(false);
    }
  });
});

describe('tolerante a deploy: chave desconhecida é REMOVIDA, nunca falha', () => {
  it('uma linha com exige e tamanhos passa e as duas chaves somem', () => {
    const corpo = {
      ...resposta({
        canais: [{ ...canal(), exige: 'SIZE_SELECTION', tamanhos: [{ size_id: 7 }] }],
      }),
      chaveDeUmaRotaMaisNova: 'x',
    };
    const lida = respostaCanaisShopeeSchema.parse(corpo);
    expect(lida).toEqual(resposta({ canais: [canal()] }));
    expect(lida.canais[0]).not.toHaveProperty('exige');
    expect(lida.canais[0]).not.toHaveProperty('tamanhos');
    expect(lida).not.toHaveProperty('chaveDeUmaRotaMaisNova');
  });

  it('o conjunto de chaves da linha é EXATAMENTE o das sete — sem tamanho e sem tarifa (Lucas 11-04)', () => {
    expect(Object.keys(canalDaLojaShopeeDtoSchema.shape).sort()).toEqual(
      [...CHAVES_DA_LINHA].sort(),
    );
    expect(Object.keys(respostaCanaisShopeeSchema.shape).sort()).toEqual([
      'canais',
      'medidasCompletas',
    ]);
    // The row schema the envelope nests IS the exported one — never a mirror.
    expect(respostaCanaisShopeeSchema.shape.canais.element).toBe(canalDaLojaShopeeDtoSchema);
    expect(canalDaLojaShopeeDtoSchema.shape.indisponivel.unwrap()).toBe(
      motivoIndisponivelCanalShopeeSchema,
    );
  });
});

describe('MOTIVO_INDISPONIVEL_CANAL_SHOPEE', () => {
  it('MOTIVO_INDISPONIVEL_CANAL_SHOPEE cobre cada opção do enum (3)', () => {
    const valores = Object.values(MOTIVO_INDISPONIVEL_CANAL_SHOPEE);
    expect(valores).toHaveLength(3);
    expect([...valores].sort()).toEqual([...motivoIndisponivelCanalShopeeSchema.options].sort());
    expect(new Set(valores).size).toBe(3);
  });
});

describe('the barrel exposes THESE instances — one declaration, no copy', () => {
  it('o barrel exporta OS MESMOS objetos', () => {
    expect(barrel.respostaCanaisShopeeSchema).toBe(respostaCanaisShopeeSchema);
    expect(barrel.canalDaLojaShopeeDtoSchema).toBe(canalDaLojaShopeeDtoSchema);
    expect(barrel.motivoIndisponivelCanalShopeeSchema).toBe(motivoIndisponivelCanalShopeeSchema);
    expect(barrel.MOTIVO_INDISPONIVEL_CANAL_SHOPEE).toBe(MOTIVO_INDISPONIVEL_CANAL_SHOPEE);
  });
});
