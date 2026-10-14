import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { ShopeeClientHttpError } from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE } from '@/lib/shopee/erros';
import {
  DETALHES_ERRO_SHOPEE_VAZIOS,
  type EnvioPrecoManualShopee,
  type EnvioPrecoManualShopeeListing,
} from '@/lib/shopee/wire';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

import type { PricePushInput } from '../types';
import { shopeePriceProvider } from './shopee';

type EnviarPrecos = ReturnType<typeof shopeeClientFalso>['enviarPrecos'];

function input(
  enviarPrecos: EnviarPrecos | null,
  over: Partial<PricePushInput> = {},
): PricePushInput {
  return {
    integracao: { id: 'int-1', nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true },
    produtoIds: ['anchor-1'],
    nomePorProdutoId: new Map([['anchor-1', 'Camiseta']]),
    baixarPreco: true,
    incluirNaoPublicados: true,
    deps: {
      mercadoLivre: null,
      shopee: enviarPrecos === null ? null : shopeeClientFalso({ enviarPrecos }),
    },
    ...over,
  };
}

/**
 * The PARSED body (`envioPrecoManualShopeeSchema`, `lib/shopee/wire.ts`) — the
 * route's `CHAVES_DO_ENVELOPE_PRECO` / `CHAVES_DA_LISTAGEM_PRECO` key-set test
 * (`apps/shopee/app/api/marketplace/shopee/enviar-precos/route.test.ts`, incl. the
 * K8 per-model label) minus the keys the wire strips on purpose.
 */
const envelope = (over: Partial<EnvioPrecoManualShopee> = {}): EnvioPrecoManualShopee => ({
  canal: 'shopee',
  integracaoId: 'int-1',
  listings: [],
  produtosSemEnvio: [],
  pausadoAte: null,
  ...over,
});

/** One MODEL row of listing 1000001 — every model names the same anchor and anúncio. */
const modelo = (
  over: Partial<EnvioPrecoManualShopeeListing> = {},
): EnvioPrecoManualShopeeListing => ({
  produtoId: 'anchor-1',
  produtoNome: 'Camiseta',
  variacaoProdutoId: 'child-p',
  anuncioId: '1000001',
  linkDocId: 'lnk-1',
  outcome: 'enviado',
  motivo: null,
  mensagem: 'Preço atualizado de 40 para 50.',
  preco: 50,
  precoAnterior: 40,
  codigo: null,
  variacaoNome: 'Camiseta Azul P',
  variacaoSku: 'CAM-AZ-P',
  ...over,
});

describe('shopeePriceProvider', () => {
  it("P4 — the models of ONE listing get distinct keys, built on each model's child", async () => {
    const enviarPrecos = vi.fn<EnviarPrecos>().mockResolvedValue(
      envelope({
        listings: [
          modelo({ variacaoProdutoId: 'child-p' }),
          modelo({ variacaoProdutoId: 'child-m' }),
          modelo({ variacaoProdutoId: 'child-g' }),
        ],
      }),
    );
    const res = await shopeePriceProvider.enviarPreco(input(enviarPrecos));
    expect(res.rows.map((r) => r.key)).toEqual([
      'child-p:int-1:1000001',
      'child-m:int-1:1000001',
      'child-g:int-1:1000001',
    ]);
    // …while every row still names the anchor the operator's listing lives under.
    expect(res.rows.every((r) => r.produtoId === 'anchor-1')).toBe(true);
  });

  it('a listing without models keys on the anchor', async () => {
    const enviarPrecos = vi.fn<EnviarPrecos>().mockResolvedValue(
      envelope({
        listings: [modelo({ variacaoProdutoId: null, variacaoNome: null, variacaoSku: null })],
      }),
    );
    const res = await shopeePriceProvider.enviarPreco(input(enviarPrecos));
    expect(res.rows[0]!.key).toBe('anchor-1:int-1:1000001');
  });

  it('P5 — the label is the SKU, else the name, else null', async () => {
    const enviarPrecos = vi.fn<EnviarPrecos>().mockResolvedValue(
      envelope({
        listings: [
          modelo({ variacaoProdutoId: 'c1', variacaoSku: 'CAM-AZ-P', variacaoNome: 'Azul P' }),
          modelo({ variacaoProdutoId: 'c2', variacaoSku: null, variacaoNome: 'Azul M' }),
          modelo({ variacaoProdutoId: 'c3', variacaoSku: null, variacaoNome: null }),
        ],
      }),
    );
    const res = await shopeePriceProvider.enviarPreco(input(enviarPrecos));
    expect(res.rows.map((r) => r.variacao)).toEqual(['CAM-AZ-P', 'Azul M', null]);
  });

  it("carries the row's price, the shelf price it replaced and the backend sentence", async () => {
    const enviarPrecos = vi.fn<EnviarPrecos>().mockResolvedValue(
      envelope({
        listings: [
          modelo({
            outcome: 'pulado',
            motivo: 'preco-igual',
            mensagem: 'O anúncio já tem este preço.',
            preco: null,
            precoAnterior: 50,
          }),
        ],
      }),
    );
    const res = await shopeePriceProvider.enviarPreco(input(enviarPrecos));
    expect(res.rows[0]).toMatchObject({
      outcome: 'pulado',
      motivo: 'preco-igual',
      mensagem: 'O anúncio já tem este preço.',
      preco: null,
      precoAnterior: 50,
      linkDocId: 'lnk-1',
    });
  });

  it('P6 — forwards baixarPreco and the signal, and never sends incluirNaoPublicados', async () => {
    const enviarPrecos = vi.fn<EnviarPrecos>().mockResolvedValue(envelope());
    const controller = new AbortController();
    await shopeePriceProvider.enviarPreco(
      input(enviarPrecos, { baixarPreco: false, signal: controller.signal }),
    );
    expect(enviarPrecos.mock.calls[0]![0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['anchor-1'],
      baixarPreco: false,
      signal: controller.signal,
    });
    expect(enviarPrecos.mock.calls[0]![0]).not.toHaveProperty('incluirNaoPublicados');
  });

  it('P7 — incluirNaoPublicados is IGNORED both ways: identical calls, identical rows', async () => {
    const resposta = envelope({ listings: [modelo()] });
    const comOcultos = vi.fn<EnviarPrecos>().mockResolvedValue(resposta);
    const semOcultos = vi.fn<EnviarPrecos>().mockResolvedValue(resposta);
    const a = await shopeePriceProvider.enviarPreco(
      input(comOcultos, { incluirNaoPublicados: true }),
    );
    const b = await shopeePriceProvider.enviarPreco(
      input(semOcultos, { incluirNaoPublicados: false }),
    );
    expect(semOcultos.mock.calls).toStrictEqual(comOcultos.mock.calls);
    expect(b).toStrictEqual(a);
    expect(b.rows).toHaveLength(1);
  });

  it('a produto with no listing becomes a pulado row under the id asked for', async () => {
    const enviarPrecos = vi.fn<EnviarPrecos>().mockResolvedValue(
      envelope({
        produtosSemEnvio: [
          {
            produtoId: 'p2',
            produtoNome: null,
            motivo: 'sem-link',
            mensagem: 'O produto não tem anúncio nesta conta.',
          },
        ],
      }),
    );
    const res = await shopeePriceProvider.enviarPreco(
      input(enviarPrecos, { produtoIds: ['p2'], nomePorProdutoId: new Map([['p2', 'Boné']]) }),
    );
    expect(res.rows).toEqual([
      expect.objectContaining({
        key: 'p2:int-1:-',
        produtoId: 'p2',
        produtoNome: 'Boné',
        outcome: 'pulado',
        motivo: 'sem-link',
      }),
    ]);
  });

  it('a conta-level 422 verdict is one falha row per produto, keeping its slug', async () => {
    const enviarPrecos = vi
      .fn<EnviarPrecos>()
      .mockRejectedValue(
        new ShopeeClientHttpError(
          'A loja não é do Brasil.',
          422,
          CODIGO_FALHA_SHOPEE.precoContaRecusada,
          null,
          null,
          { ...DETALHES_ERRO_SHOPEE_VAZIOS, motivo: 'regiao-nao-br' },
        ),
      );
    const res = await shopeePriceProvider.enviarPreco(
      input(enviarPrecos, { produtoIds: ['anchor-1', 'p2'] }),
    );
    expect(res.rows.map((r) => [r.key, r.outcome, r.motivo, r.mensagem])).toEqual([
      ['anchor-1:int-1:-', 'falha', 'regiao-nao-br', 'A loja não é do Brasil.'],
      ['p2:int-1:-', 'falha', 'regiao-nao-br', 'A loja não é do Brasil.'],
    ]);
  });

  it('rethrows an unknown error instead of swallowing it (repo rule 6)', async () => {
    const enviarPrecos = vi.fn<EnviarPrecos>().mockRejectedValue(new TypeError('boom'));
    await expect(shopeePriceProvider.enviarPreco(input(enviarPrecos))).rejects.toThrow(TypeError);
  });

  it('degrades to an error row when logged out, with zero calls', async () => {
    const res = await shopeePriceProvider.enviarPreco(input(null));
    expect(res.rows).toEqual([
      expect.objectContaining({ outcome: 'falha', motivo: 'sem-cliente' }),
    ]);
  });
});
