import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreClient,
} from '@/lib/mercado-livre/client';

import { mercadoLivrePriceProvider } from './mercadoLivre';
import type { PricePushInput } from '../types';

function input(
  enviarPrecos: MercadoLivreClient['enviarPrecos'] | null,
  over: Partial<PricePushInput> = {},
): PricePushInput {
  return {
    integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    baixarPreco: false,
    deps: {
      mercadoLivre:
        enviarPrecos == null ? null : ({ enviarPrecos } as unknown as MercadoLivreClient),
    },
    ...over,
  };
}

const envelope = (over: Record<string, unknown> = {}) => ({
  canal: 'mercado-livre' as const,
  integracaoId: 'c1',
  contaNome: 'Loja',
  solicitados: 1,
  familias: 1,
  resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [],
  produtosSemEnvio: [],
  pausadoAte: null,
  ...over,
});

const listing = (over: Record<string, unknown> = {}) => ({
  produtoId: 'p1',
  produtoNome: 'Camiseta',
  variacaoProdutoId: null,
  anuncioId: 'MLB1',
  linkDocId: 'lnk1',
  outcome: 'enviado' as const,
  motivo: null,
  mensagem: 'Preço atualizado de 40 para 50.',
  preco: 50,
  precoAnterior: 40,
  variacoes: null,
  ...over,
});

describe('mercadoLivrePriceProvider', () => {
  it('maps every listing through, one row each', async () => {
    // A produto can carry SEVERAL anúncios on one conta (#781) — the row unit is
    // the listing, so two listings must never collapse into one row.
    const enviarPrecos = vi.fn().mockResolvedValue(
      envelope({
        listings: [listing(), listing({ anuncioId: 'MLB2', linkDocId: 'lnk2' })],
      }),
    );

    const res = await mercadoLivrePriceProvider.enviarPreco(input(enviarPrecos as never));

    expect(res.rows).toHaveLength(2);
    expect(new Set(res.rows.map((r) => r.key)).size).toBe(2);
    expect(res.rows[0]).toMatchObject({ outcome: 'enviado', preco: 50, precoAnterior: 40 });
  });

  /**
   * The backend's SKIP arms do not dedupe the way its draft arms do, and several
   * are emitted inside a per-link or per-child loop — a família with two
   * unpublished links yields two rows that are identical down to
   * `anuncioId: null`. `key` is both the React list key and the e2e's
   * `data-testid`, so a collision reconciles two distinct outcomes into one row.
   */
  it('keeps row keys unique when the backend legitimately repeats (produtoId, anuncioId)', async () => {
    const enviarPrecos = vi.fn().mockResolvedValue(
      envelope({
        listings: [
          listing({ outcome: 'pulado', motivo: 'SEM_ITEM_ID', anuncioId: null, preco: null }),
          listing({ outcome: 'pulado', motivo: 'SEM_ITEM_ID', anuncioId: null, preco: null }),
        ],
        produtosSemEnvio: [
          { produtoId: 'p1', produtoNome: null, motivo: 'NAO_PUBLICADO', mensagem: 'Oculto.' },
        ],
      }),
    );

    const res = await mercadoLivrePriceProvider.enviarPreco(input(enviarPrecos as never));

    expect(res.rows).toHaveLength(3);
    expect(new Set(res.rows.map((r) => r.key)).size).toBe(3);
    // The FIRST occurrence keeps the plain, readable key — the e2e locates rows
    // by the `<produtoId>:` prefix, which every variant preserves.
    expect(res.rows[0]!.key).toBe('p1:c1:-');
    expect(res.rows.every((r) => r.key.startsWith('p1:c1:'))).toBe(true);
  });

  it('forwards baixarPreco and the abort signal to the backend', async () => {
    const enviarPrecos = vi.fn().mockResolvedValue(envelope());
    const signal = new AbortController().signal;

    await mercadoLivrePriceProvider.enviarPreco(
      input(enviarPrecos as never, { baixarPreco: true, signal }),
    );

    expect(enviarPrecos).toHaveBeenCalledWith(
      expect.objectContaining({
        integracaoId: 'c1',
        produtoIds: ['p1'],
        baixarPreco: true,
        signal,
      }),
    );
  });

  it('renders the backend`s wording verbatim — this layer owns no skip vocabulary', async () => {
    const enviarPrecos = vi.fn().mockResolvedValue(
      envelope({
        listings: [
          listing({
            outcome: 'pulado',
            motivo: 'PRECO_NAO_MODIFICAVEL',
            mensagem: 'O vendedor ativou a automação de preços do Mercado Livre.',
            preco: null,
          }),
        ],
      }),
    );

    const res = await mercadoLivrePriceProvider.enviarPreco(input(enviarPrecos as never));

    expect(res.rows[0]).toMatchObject({
      outcome: 'pulado',
      motivo: 'PRECO_NAO_MODIFICAVEL',
      mensagem: 'O vendedor ativou a automação de preços do Mercado Livre.',
    });
  });

  it('turns produtosSemEnvio into rows too — a produto never disappears', async () => {
    const enviarPrecos = vi.fn().mockResolvedValue(
      envelope({
        produtosSemEnvio: [
          {
            produtoId: 'p1',
            produtoNome: null,
            motivo: 'NAO_PUBLICADO',
            mensagem: 'O produto está oculto (não publicado) no ERP.',
          },
        ],
      }),
    );

    const res = await mercadoLivrePriceProvider.enviarPreco(input(enviarPrecos as never));

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ outcome: 'pulado', motivo: 'NAO_PUBLICADO' });
    // The backend named no produto, so the selection's own label fills in.
    expect(res.rows[0]!.produtoNome).toBe('Camiseta');
  });

  it('a logged-out client is an error ROW, never a throw', async () => {
    const res = await mercadoLivrePriceProvider.enviarPreco(input(null));
    expect(res.rows[0]).toMatchObject({ outcome: 'falha', motivo: 'sem-cliente' });
  });

  it('a conta-level 4xx becomes one failure row per produto, carrying the backend code', async () => {
    const enviarPrecos = vi
      .fn()
      .mockRejectedValue(
        new MercadoLivreClientHttpError('sem tabela normal', 400, 'ML_CONTA_SEM_TABELA_NORMAL'),
      );

    const res = await mercadoLivrePriceProvider.enviarPreco(
      input(enviarPrecos as never, {
        produtoIds: ['p1', 'p2'],
        nomePorProdutoId: new Map([
          ['p1', 'Camiseta'],
          ['p2', 'Caneca'],
        ]),
      }),
    );

    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'ML_CONTA_SEM_TABELA_NORMAL',
      mensagem: 'sem tabela normal',
    });
  });

  it('a network failure is a row, not an exception', async () => {
    const enviarPrecos = vi.fn().mockRejectedValue(new MercadoLivreClientNetworkError('offline'));
    const res = await mercadoLivrePriceProvider.enviarPreco(input(enviarPrecos as never));
    expect(res.rows[0]).toMatchObject({ outcome: 'falha', motivo: 'rede' });
  });

  it('a cancel produces NO rows — the run reports the cancellation itself', async () => {
    const enviarPrecos = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const res = await mercadoLivrePriceProvider.enviarPreco(input(enviarPrecos as never));
    expect(res.rows).toEqual([]);
  });

  it('anything else is rethrown — never a generic catch (repo rule 6)', async () => {
    const enviarPrecos = vi.fn().mockRejectedValue(new TypeError('coding bug'));
    await expect(
      mercadoLivrePriceProvider.enviarPreco(input(enviarPrecos as never)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
