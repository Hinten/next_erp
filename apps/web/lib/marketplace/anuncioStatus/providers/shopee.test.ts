import { describe, expect, it, vi } from 'vitest';
import { ACAO_STATUS_ANUNCIO, ESTADO_ANUNCIO_SHOPEE, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { ShopeeClientHttpError, ShopeeClientNetworkError } from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE } from '@/lib/shopee/erros';
import {
  DETALHES_ERRO_SHOPEE_VAZIOS,
  type AnuncioStatusShopee,
  type AnuncioStatusShopeeListing,
} from '@/lib/shopee/wire';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

import type { AnuncioStatusInput } from '../types';
import { shopeeAnuncioStatusProvider } from './shopee';

type DefinirStatusAnuncios = ReturnType<typeof shopeeClientFalso>['definirStatusAnuncios'];

function input(
  definirStatusAnuncios: DefinirStatusAnuncios | null,
  over: Partial<AnuncioStatusInput> = {},
): AnuncioStatusInput {
  return {
    integracao: { id: 'int-1', nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    acao: ACAO_STATUS_ANUNCIO.pausar,
    deps: {
      mercadoLivre: null,
      shopee: definirStatusAnuncios === null ? null : shopeeClientFalso({ definirStatusAnuncios }),
    },
    ...over,
  };
}

/**
 * The PARSED body (`anuncioStatusShopeeSchema`, `lib/shopee/wire.ts`) — the shape
 * the route's key-set test pins
 * (`apps/shopee/app/api/marketplace/shopee/anuncio-status/route.test.ts`) minus the
 * keys the wire strips on purpose.
 */
const envelope = (over: Partial<AnuncioStatusShopee> = {}): AnuncioStatusShopee => ({
  canal: 'shopee',
  integracaoId: 'int-1',
  acao: ACAO_STATUS_ANUNCIO.pausar,
  listings: [],
  produtosSemAnuncio: [],
  pausadoAte: null,
  ...over,
});

const listing = (over: Partial<AnuncioStatusShopeeListing> = {}): AnuncioStatusShopeeListing => ({
  produtoId: 'p1',
  produtoNome: 'Camiseta',
  anuncioId: '1000001',
  linkDocId: 'lnk-1',
  outcome: 'enviado',
  motivo: null,
  mensagem: 'Anúncio pausado.',
  statusFinal: 'UNLIST',
  estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
  ...over,
});

describe('shopeeAnuncioStatusProvider', () => {
  it('forwards the conta, the selection, the direction and the signal — and NO linkDocId', async () => {
    const definirStatusAnuncios = vi.fn<DefinirStatusAnuncios>().mockResolvedValue(envelope());
    const controller = new AbortController();
    await shopeeAnuncioStatusProvider.definirStatus(
      input(definirStatusAnuncios, {
        produtoIds: ['p1', 'p2'],
        acao: ACAO_STATUS_ANUNCIO.reativar,
        signal: controller.signal,
      }),
    );
    // The bulk run covers every listing of the selection on the conta; naming
    // ONE listing is the produto tab's call, never this one.
    expect(definirStatusAnuncios.mock.calls[0]![0]).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['p1', 'p2'],
      acao: ACAO_STATUS_ANUNCIO.reativar,
      signal: controller.signal,
    });
  });

  it('P8 — statusFinal is what the listing READS, never the direction asked; membros is null', async () => {
    // A reactivate the listing did not honour: the row must say so, not "Reativado".
    const definirStatusAnuncios = vi.fn<DefinirStatusAnuncios>().mockResolvedValue(
      envelope({
        acao: ACAO_STATUS_ANUNCIO.reativar,
        listings: [
          listing({ statusFinal: 'UNLIST', mensagem: 'A Shopee manteve o anúncio pausado.' }),
        ],
      }),
    );
    const res = await shopeeAnuncioStatusProvider.definirStatus(
      input(definirStatusAnuncios, { acao: ACAO_STATUS_ANUNCIO.reativar }),
    );
    expect(res.rows).toEqual([
      expect.objectContaining({
        key: 'p1:int-1:1000001',
        statusFinal: 'UNLIST',
        membros: null,
        mensagem: 'A Shopee manteve o anúncio pausado.',
      }),
    ]);
  });

  it('P3 — a child resolved to its anchor AND a produto with no listing both reach the report', async () => {
    // RT1 (the backend's T1): selecting ONE child moves its family's listing,
    // whose row names the ANCHOR; a produto with no listing is reported under the
    // id the operator asked for.
    const definirStatusAnuncios = vi.fn<DefinirStatusAnuncios>().mockResolvedValue(
      envelope({
        listings: [listing({ produtoId: 'anchor-1', produtoNome: 'Camiseta' })],
        produtosSemAnuncio: [
          {
            produtoId: 'p2',
            produtoNome: 'Boné',
            motivo: 'sem-anuncio',
            mensagem: 'Este produto não tem anúncio nesta conta Shopee.',
          },
        ],
      }),
    );
    const res = await shopeeAnuncioStatusProvider.definirStatus(
      input(definirStatusAnuncios, { produtoIds: ['child-1', 'p2'] }),
    );
    expect(res.rows.map((r) => [r.produtoId, r.outcome, r.motivo])).toEqual([
      ['anchor-1', 'enviado', null],
      ['p2', 'pulado', 'sem-anuncio'],
    ]);
  });

  it('a conta paused on the daily quota is one "not attempted" row per produto', async () => {
    const definirStatusAnuncios = vi.fn<DefinirStatusAnuncios>().mockRejectedValue(
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
    const res = await shopeeAnuncioStatusProvider.definirStatus(input(definirStatusAnuncios));
    expect(res.pausadoAte).toBe('2026-10-14T18:30:00Z');
    expect(res.rows).toEqual([
      expect.objectContaining({ outcome: 'nao-tentado', motivo: 'conta-pausada', membros: null }),
    ]);
  });

  it('a cancel is NO rows; the same network error with nobody cancelling is a row', async () => {
    const controller = new AbortController();
    controller.abort();
    const definirStatusAnuncios = vi
      .fn<DefinirStatusAnuncios>()
      .mockRejectedValue(new ShopeeClientNetworkError('aborted'));
    expect(
      await shopeeAnuncioStatusProvider.definirStatus(
        input(definirStatusAnuncios, { signal: controller.signal }),
      ),
    ).toEqual({ rows: [], pausadoAte: null });
    const res = await shopeeAnuncioStatusProvider.definirStatus(input(definirStatusAnuncios));
    expect(res.rows).toEqual([expect.objectContaining({ outcome: 'falha', motivo: 'rede' })]);
  });

  it('rethrows an unknown error instead of swallowing it (repo rule 6)', async () => {
    const definirStatusAnuncios = vi
      .fn<DefinirStatusAnuncios>()
      .mockRejectedValue(new TypeError('boom'));
    await expect(
      shopeeAnuncioStatusProvider.definirStatus(input(definirStatusAnuncios)),
    ).rejects.toThrow(TypeError);
  });

  it('degrades to an error row when logged out, with zero calls', async () => {
    const res = await shopeeAnuncioStatusProvider.definirStatus(input(null));
    expect(res.rows).toEqual([
      expect.objectContaining({ outcome: 'falha', motivo: 'sem-cliente', statusFinal: null }),
    ]);
  });
});
