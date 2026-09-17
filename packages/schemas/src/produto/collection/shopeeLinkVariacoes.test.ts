import { describe, expect, it } from 'vitest';

// Importado pelo BARREL de propósito: a prova de que a linha `export *` em
// `produto/index.ts` (e, por ela, a raiz `src/index.ts`) alcança o schema novo.
import {
  grupoDeVariacoesSchema,
  linkVariacaoOpcaoShopeeSchema,
  linkVariacoesShopeeSchema,
  type LinkVariacoesShopee,
} from '../../index';

/**
 * O elemento legado, verbatim do formulário Flutter
 * (`.old/packages/produtos/lib/src/models.dart:5190-5263`): `variation_id` e
 * `variation_group_list` ZERO (tudo custom fora de Fashion, `faq 288`), o
 * `integracaoShopeeId` como id NU, e duas opções com `arakene_variation_id`
 * como LISTA.
 */
const ELEMENTO_LEGADO = {
  name: 'Roupas',
  category_id: 100015,
  variation_id: 0,
  variation_group_list: 0,
  integracaoShopeeId: 'int-1',
  variationOptions: [
    { shopee_option_id: 0, shopee_option_name: 'Azul', arakene_variation_id: ['v1', 'v2'] },
    { shopee_option_id: 0, shopee_option_name: 'Vermelho', arakene_variation_id: ['v3'] },
  ],
};

describe('linkVariacoesShopeeSchema', () => {
  it('faz round-trip byte a byte de um elemento no formato legado', () => {
    const parsed = linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO);
    expect(parsed).toEqual(ELEMENTO_LEGADO);
  });

  it('aceita ids não-zero em todos os níveis', () => {
    const naoZero = {
      ...ELEMENTO_LEGADO,
      variation_id: 100015,
      variation_group_list: 200030,
      variationOptions: [
        { shopee_option_id: 300045, shopee_option_name: 'Azul', arakene_variation_id: ['v1'] },
      ],
    };
    expect(linkVariacoesShopeeSchema.parse(naoZero)).toEqual(naoZero);
  });

  it('⛔ NEAR-MISS: variation_group_list como ARRAY é recusado (o plural mente — é escalar)', () => {
    expect(
      linkVariacoesShopeeSchema.safeParse({ ...ELEMENTO_LEGADO, variation_group_list: [0] })
        .success,
    ).toBe(false);
    expect(
      linkVariacoesShopeeSchema.safeParse({ ...ELEMENTO_LEGADO, variation_group_list: [1, 2] })
        .success,
    ).toBe(false);
    // e o escalar zero continua sendo um VALOR aceito
    expect(linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO).variation_group_list).toBe(0);
  });

  it('integracaoShopeeId em branco é recusado', () => {
    expect(
      linkVariacoesShopeeSchema.safeParse({ ...ELEMENTO_LEGADO, integracaoShopeeId: '' }).success,
    ).toBe(false);
  });

  it('integracaoShopeeId com prefixo documents/ é ACEITO e guardado como veio (nunca normalizado)', () => {
    // Trap 2 fixado nos dois sentidos: o campo é um id NU no corpus legado, mas
    // normalizar (ou recusar) um valor já gravado com caminho orfanaria a entrada
    // que o operador escreveu. O schema só guarda a string.
    const comCaminho = { ...ELEMENTO_LEGADO, integracaoShopeeId: 'documents/integracao/int-1' };
    const parsed = linkVariacoesShopeeSchema.parse(comCaminho);
    expect(parsed.integracaoShopeeId).toBe('documents/integracao/int-1');
    expect(linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO).integracaoShopeeId).toBe('int-1');
  });

  it('⛔ NEAR-MISS: arakene_variation_id como string solta é recusado (é uma LISTA)', () => {
    expect(
      linkVariacaoOpcaoShopeeSchema.safeParse({
        shopee_option_id: 0,
        shopee_option_name: 'Azul',
        arakene_variation_id: 'v1',
      }).success,
    ).toBe(false);
    expect(
      linkVariacaoOpcaoShopeeSchema.parse({
        shopee_option_id: 0,
        shopee_option_name: 'Azul',
        arakene_variation_id: ['v1'],
      }).arakene_variation_id,
    ).toEqual(['v1']);
  });

  it('uma chave desconhecida sobrevive ao passthrough, no elemento e na opção', () => {
    const parsed = linkVariacoesShopeeSchema.parse({
      ...ELEMENTO_LEGADO,
      _campoFuturo: 'x',
      variationOptions: [
        {
          shopee_option_id: 0,
          shopee_option_name: 'Azul',
          arakene_variation_id: ['v1'],
          _extraDaOpcao: 'y',
        },
      ],
    });
    expect((parsed as Record<string, unknown>)._campoFuturo).toBe('x');
    const opcao = parsed.variationOptions[0] as Record<string, unknown> | undefined;
    expect(opcao?._extraDaOpcao).toBe('y');
  });

  it('variationOptions ausente vira lista vazia', () => {
    const { variationOptions: _ignorado, ...semOpcoes } = ELEMENTO_LEGADO;
    expect(linkVariacoesShopeeSchema.parse(semOpcoes).variationOptions).toEqual([]);
  });

  it('o tipo inferido descreve o elemento legado', () => {
    const tipado: LinkVariacoesShopee = linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO);
    expect(tipado.variationOptions[0]?.arakene_variation_id).toEqual(['v1', 'v2']);
  });
});

describe('grupoDeVariacoesSchema.linksVariacoesShopee', () => {
  it('continua aceitando unknown[] — o schema novo NÃO foi ligado ao grupo', () => {
    // Se alguém ligar `linkVariacoesShopeeSchema` no campo, este teste cai — e é
    // esse o aviso: `grupoDeVariacoesMeta` é registrado, então tipar o campo no
    // lugar move um validador gerado e os dois snapshots de rules-gen.
    const parsed = grupoDeVariacoesSchema.parse({
      nome: 'Cor',
      linksVariacoesShopee: [{ lixo: true }, 42, 'nada a ver'],
    });
    expect(parsed.linksVariacoesShopee).toEqual([{ lixo: true }, 42, 'nada a ver']);
  });
});
