import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreClient,
} from '@/lib/mercado-livre/client';

import { mercadoLivreAnuncioStatusProvider } from './mercadoLivre';
import type { AnuncioStatusInput } from '../types';

function input(
  definirStatusAnuncios: MercadoLivreClient['definirStatusAnuncios'] | null,
  over: Partial<AnuncioStatusInput> = {},
): AnuncioStatusInput {
  return {
    integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    acao: 'pausar',
    deps: {
      mercadoLivre:
        definirStatusAnuncios == null
          ? null
          : ({ definirStatusAnuncios } as unknown as MercadoLivreClient),
    },
    ...over,
  };
}

const envelope = (over: Record<string, unknown> = {}) => ({
  canal: 'mercado-livre' as const,
  integracaoId: 'c1',
  acao: 'pausar' as const,
  solicitados: 1,
  familias: 1,
  resumo: { aplicados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [],
  produtosSemAnuncio: [],
  pausadoAte: null,
  ...over,
});

const listing = (over: Record<string, unknown> = {}) => ({
  produtoId: 'p1',
  produtoNome: 'Camiseta',
  anuncioId: 'MLB1',
  linkDocId: 'l1',
  outcome: 'enviado' as const,
  motivo: null,
  mensagem: 'Anúncio pausado.',
  statusFinal: 'paused',
  membros: null,
  ...over,
});

describe('mercadoLivreAnuncioStatusProvider', () => {
  it('maps every listing through, one row each', async () => {
    // A produto can carry SEVERAL anúncios on one conta (#781) — the row unit is
    // the listing, so two listings must never collapse into one row.
    const definir = vi.fn().mockResolvedValue(
      envelope({
        listings: [listing(), listing({ anuncioId: 'MLB2', linkDocId: 'l2' })],
      }),
    );
    const res = await mercadoLivreAnuncioStatusProvider.definirStatus(input(definir));
    expect(res.rows).toHaveLength(2);
    expect(new Set(res.rows.map((r) => r.key)).size).toBe(2);
    expect(res.rows[0]).toMatchObject({ outcome: 'enviado', statusFinal: 'paused' });
  });

  it('passes the ACTION through to the backend', async () => {
    const definir = vi.fn().mockResolvedValue(envelope());
    await mercadoLivreAnuncioStatusProvider.definirStatus(input(definir, { acao: 'reativar' }));
    expect(definir).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'reativar', integracaoId: 'c1', produtoIds: ['p1'] }),
    );
    // ⚠️ No `linkDocId`: this is the BULK form, which covers every listing the
    // selection holds. Sending one here would silently narrow the run.
    expect(definir.mock.calls[0]![0]).not.toHaveProperty('linkDocId');
  });

  it('passes the backend’s wording through verbatim, never re-deriving it', async () => {
    // The skip vocabulary is the BACKEND's; a second copy here would drift from
    // the rungs that emit it.
    const definir = vi.fn().mockResolvedValue(
      envelope({
        listings: [
          listing({
            outcome: 'pulado',
            motivo: 'anuncio-cancelado',
            mensagem: 'Anúncio encerrado no Mercado Livre — um anúncio encerrado não pode ser…',
          }),
        ],
      }),
    );
    const res = await mercadoLivreAnuncioStatusProvider.definirStatus(input(definir));
    expect(res.rows[0]!.mensagem).toBe(
      'Anúncio encerrado no Mercado Livre — um anúncio encerrado não pode ser…',
    );
    expect(res.rows[0]!.motivo).toBe('anuncio-cancelado');
  });

  it('gives a produto with no listing at all its own row', async () => {
    const definir = vi.fn().mockResolvedValue(
      envelope({
        produtosSemAnuncio: [
          {
            produtoId: 'p1',
            produtoNome: 'Camiseta',
            motivo: 'sem-anuncio',
            mensagem: 'Este produto não tem anúncio nesta conta.',
          },
        ],
      }),
    );
    const res = await mercadoLivreAnuncioStatusProvider.definirStatus(input(definir));
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'sem-anuncio' });
  });

  it('answers a row per produto when there is no client, instead of throwing', async () => {
    const res = await mercadoLivreAnuncioStatusProvider.definirStatus(input(null));
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ outcome: 'falha', motivo: 'sem-cliente' });
  });

  it('turns an HTTP error into failure rows carrying the backend’s message', async () => {
    const definir = vi
      .fn()
      .mockRejectedValue(new MercadoLivreClientHttpError('conta desconectada', 409, 'ML_REAUTH'));
    const res = await mercadoLivreAnuncioStatusProvider.definirStatus(input(definir));
    expect(res.rows[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'ML_REAUTH',
      mensagem: 'conta desconectada',
    });
  });

  it('turns a network error into failure rows', async () => {
    const definir = vi.fn().mockRejectedValue(new MercadoLivreClientNetworkError('offline'));
    const res = await mercadoLivreAnuncioStatusProvider.definirStatus(input(definir));
    expect(res.rows[0]).toMatchObject({ outcome: 'falha', motivo: 'rede' });
  });

  it('treats an abort as a clean cancel — no rows, not a failure', async () => {
    const definir = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const res = await mercadoLivreAnuncioStatusProvider.definirStatus(input(definir));
    // The RUN reports the cancellation; inventing failure rows here would tell
    // the operator their own Cancelar broke something.
    expect(res.rows).toEqual([]);
  });

  it('RETHROWS anything else (repo rule 6 — never a generic catch)', async () => {
    const definir = vi.fn().mockRejectedValue(new TypeError('bug'));
    await expect(
      mercadoLivreAnuncioStatusProvider.definirStatus(input(definir)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
