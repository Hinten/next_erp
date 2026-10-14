import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { ShopeeClientHttpError, ShopeeClientNetworkError } from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE } from '@/lib/shopee/erros';
import {
  DETALHES_ERRO_SHOPEE_VAZIOS,
  type EnvioEstoqueManualShopee,
  type EnvioEstoqueManualShopeeListing,
} from '@/lib/shopee/wire';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

import type { StockPushInput } from '../types';
import { shopeeStockProvider } from './shopee';

type EnviarEstoque = ReturnType<typeof shopeeClientFalso>['enviarEstoque'];

function input(
  enviarEstoque: EnviarEstoque | null,
  over: Partial<StockPushInput> = {},
): StockPushInput {
  return {
    integracao: { id: 'int-1', nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    reenviarComErro: false,
    deps: {
      mercadoLivre: null,
      shopee: enviarEstoque === null ? null : shopeeClientFalso({ enviarEstoque }),
    },
    ...over,
  };
}

/**
 * The PARSED body (`envioEstoqueManualShopeeSchema`, `lib/shopee/wire.ts`) — the
 * route's `CHAVES_DO_ENVELOPE` / `CHAVES_DA_LISTAGEM` key-set test
 * (`apps/shopee/app/api/marketplace/shopee/enviar-estoque/route.test.ts`) minus the
 * keys the wire strips on purpose.
 */
const envelope = (over: Partial<EnvioEstoqueManualShopee> = {}): EnvioEstoqueManualShopee => ({
  canal: 'shopee',
  integracaoId: 'int-1',
  listings: [],
  produtosSemEnvio: [],
  pausadoAte: null,
  ...over,
});

const listing = (
  over: Partial<EnvioEstoqueManualShopeeListing> = {},
): EnvioEstoqueManualShopeeListing => ({
  produtoId: 'p1',
  produtoNome: 'Camiseta',
  anuncioId: '1000001',
  linkDocId: 'lnk-1',
  outcome: 'enviado',
  motivo: null,
  mensagem: 'Estoque 7 enviado.',
  quantidade: 7,
  modelosRecusados: 0,
  clampados: 0,
  ...over,
});

describe('shopeeStockProvider', () => {
  it('P1 — forwards exactly the conta, the selection, the opt-in and the signal', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(envelope());
    const controller = new AbortController();
    await shopeeStockProvider.enviarEstoque(
      input(enviarEstoque, {
        produtoIds: ['p1', 'p2'],
        reenviarComErro: true,
        signal: controller.signal,
      }),
    );
    expect(enviarEstoque).toHaveBeenCalledTimes(1);
    expect(enviarEstoque.mock.calls[0]![0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['p1', 'p2'],
      reenviarComErro: true,
      signal: controller.signal,
    });
  });

  it('P2 — a send clamped to a promotion floor stays a SUCCESS (outcome, never motivo)', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(
      envelope({
        listings: [
          listing({
            motivo: 'clampado-na-reserva',
            mensagem: 'Estoque 3 enviado (elevado à reserva da promoção).',
            quantidade: 3,
            clampados: 1,
          }),
        ],
      }),
    );
    const res = await shopeeStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res.rows).toEqual([
      expect.objectContaining({
        outcome: 'enviado',
        motivo: 'clampado-na-reserva',
        quantidade: 3,
        mensagem: 'Estoque 3 enviado (elevado à reserva da promoção).',
      }),
    ]);
  });

  it('P3 — a child resolved to its anchor AND a produto with no listing both reach the report', async () => {
    // RT1 (the backend's S1/S3): the operator picked a CHILD and a produto with no
    // Shopee link; the backend answers a row for the child's ANCHOR and a
    // `produtosSemEnvio` entry under the id asked for.
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(
      envelope({
        listings: [listing({ produtoId: 'anchor-1', produtoNome: null, linkDocId: 'lnk-a' })],
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
    const res = await shopeeStockProvider.enviarEstoque(
      input(enviarEstoque, {
        produtoIds: ['child-1', 'p2'],
        nomePorProdutoId: new Map([
          ['child-1', 'Camiseta Azul P'],
          ['p2', 'Boné'],
        ]),
      }),
    );
    expect(res.rows).toEqual([
      expect.objectContaining({
        key: 'anchor-1:int-1:1000001',
        produtoId: 'anchor-1',
        outcome: 'enviado',
        linkDocId: 'lnk-a',
      }),
      expect.objectContaining({
        key: 'p2:int-1:-',
        produtoId: 'p2',
        // The backend sent no name: the selection's own label fills in.
        produtoNome: 'Boné',
        outcome: 'pulado',
        motivo: 'sem-link',
        mensagem: 'O produto não tem anúncio nesta conta.',
      }),
    ]);
  });

  it('keys every row through makeRowKeyer — a repeated (produto, anúncio) never collides', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockResolvedValue(
      envelope({
        listings: [
          listing({
            anuncioId: null,
            linkDocId: 'lnk-1',
            outcome: 'pulado',
            motivo: 'sem-item-id',
          }),
          listing({
            anuncioId: null,
            linkDocId: 'lnk-2',
            outcome: 'pulado',
            motivo: 'sem-item-id',
          }),
        ],
      }),
    );
    const res = await shopeeStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res.rows.map((r) => r.key)).toEqual(['p1:int-1:-', 'p1:int-1:-#1']);
  });

  it('passes the quota pause of a run that stopped midway through', async () => {
    const enviarEstoque = vi
      .fn<EnviarEstoque>()
      .mockResolvedValue(envelope({ pausadoAte: '2026-10-14T18:30:00Z' }));
    const res = await shopeeStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res.pausadoAte).toBe('2026-10-14T18:30:00Z');
  });

  it('a conta paused BEFORE the run is one "not attempted" row per produto', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockRejectedValue(
      new ShopeeClientHttpError(
        'Conta pausada.',
        409,
        CODIGO_FALHA_SHOPEE.contaPausada,
        null,
        null,
        {
          ...DETALHES_ERRO_SHOPEE_VAZIOS,
          pausadoAte: '2026-10-14T18:30:00Z',
        },
      ),
    );
    const res = await shopeeStockProvider.enviarEstoque(
      input(enviarEstoque, { produtoIds: ['p1', 'p2'] }),
    );
    expect(res.pausadoAte).toBe('2026-10-14T18:30:00Z');
    expect(res.rows.map((r) => [r.produtoId, r.outcome, r.motivo])).toEqual([
      ['p1', 'nao-tentado', 'conta-pausada'],
      ['p2', 'nao-tentado', 'conta-pausada'],
    ]);
  });

  it('a cancel mid-flight is NO rows — the run reports it', async () => {
    const controller = new AbortController();
    const enviarEstoque = vi.fn<EnviarEstoque>().mockImplementation(() => {
      controller.abort();
      return Promise.reject(
        new ShopeeClientNetworkError('aborted', new DOMException('aborted', 'AbortError')),
      );
    });
    const res = await shopeeStockProvider.enviarEstoque(
      input(enviarEstoque, { signal: controller.signal }),
    );
    expect(res).toEqual({ rows: [], pausadoAte: null });
  });

  it('NEAR MISS: the same network error with nobody cancelling is a "rede" failure row', async () => {
    const enviarEstoque = vi
      .fn<EnviarEstoque>()
      .mockRejectedValue(new ShopeeClientNetworkError('Failed to fetch'));
    const res = await shopeeStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res.rows).toEqual([
      expect.objectContaining({
        outcome: 'falha',
        motivo: 'rede',
        mensagem: 'Não foi possível contatar o serviço da Shopee.',
      }),
    ]);
  });

  it('rethrows an unknown error instead of swallowing it (repo rule 6)', async () => {
    const enviarEstoque = vi.fn<EnviarEstoque>().mockRejectedValue(new TypeError('boom'));
    await expect(shopeeStockProvider.enviarEstoque(input(enviarEstoque))).rejects.toThrow(
      TypeError,
    );
  });

  it('degrades to an error row when logged out, with zero calls', async () => {
    const res = await shopeeStockProvider.enviarEstoque(input(null));
    expect(res.rows).toEqual([
      expect.objectContaining({
        produtoId: 'p1',
        outcome: 'falha',
        motivo: 'sem-cliente',
        mensagem: 'Você não está logado.',
      }),
    ]);
  });
});
