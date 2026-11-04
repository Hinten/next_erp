import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { type EnviarEstoqueAlvo, enviarEstoqueParaMarketplaces } from './enviarEstoqueRun';
import { mercadoLivreStockProvider } from './providers/mercadoLivre';
import { shopeeStockProvider } from './providers/shopee';
import type { StockPushChannelResult, StockPushRow } from './types';

const db = {} as Firestore;

function alvo(over: Partial<EnviarEstoqueAlvo> = {}): EnviarEstoqueAlvo {
  return {
    produtoId: 'p1',
    produtoNome: 'Camiseta',
    integracoesComProduto: ['ml-1'],
    ...over,
  };
}

const contas = (over: Record<string, unknown> = {}) =>
  new Map<string, { nome: string; tipo: number; ativo: boolean }>([
    ['ml-1', { nome: 'Loja ML', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true }],
    ...(Object.entries(over) as [string, { nome: string; tipo: number; ativo: boolean }][]),
  ]);

function run(
  alvos: EnviarEstoqueAlvo[],
  lerIntegracoes: ReturnType<typeof vi.fn>,
  onProgress = vi.fn(),
  signal?: AbortSignal,
) {
  return enviarEstoqueParaMarketplaces(
    alvos,
    false,
    {
      db,
      deps: { mercadoLivre: null, shopee: null },
      lerIntegracoes: lerIntegracoes as never,
      signal,
    },
    onProgress,
  );
}

describe('enviarEstoqueParaMarketplaces', () => {
  it('reads the integração docs ONCE, deduped across the whole selection', async () => {
    // The N+1 pin: 50 produtos × 1 conta must be one read of one id, not 50.
    const alvos = Array.from({ length: 50 }, (_, i) => alvo({ produtoId: `p${String(i)}` }));
    const lerIntegracoes = vi.fn().mockResolvedValue(contas());
    const spy = vi.spyOn(mercadoLivreStockProvider, 'enviarEstoque').mockResolvedValue({
      rows: [],
      pausadoAte: null,
    });

    await run(alvos, lerIntegracoes);

    expect(lerIntegracoes).toHaveBeenCalledTimes(1);
    expect(lerIntegracoes.mock.calls[0]![1]).toEqual(['ml-1']);
    // And a supported channel is called ONCE with the whole selection — it is
    // authoritative about its own links, so the drifting denorm never decides
    // what gets sent (#804 S7).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].produtoIds).toHaveLength(50);
    spy.mockRestore();
  });

  it('reports a produto with no integrations without reading anything', async () => {
    const lerIntegracoes = vi.fn();
    const res = await run([alvo({ integracoesComProduto: [] })], lerIntegracoes);
    expect(lerIntegracoes).not.toHaveBeenCalled();
    expect(res.rows).toEqual([
      expect.objectContaining({
        motivo: 'sem-integracoes',
        mensagem: 'Produto não tem integrações',
      }),
    ]);
  });

  it('emits progress incrementally, like the legacy stream', async () => {
    const onProgress = vi.fn();
    const lerIntegracoes = vi.fn().mockResolvedValue(contas());
    const spy = vi
      .spyOn(mercadoLivreStockProvider, 'enviarEstoque')
      .mockResolvedValue({ rows: [], pausadoAte: null });

    await run(
      [alvo(), alvo({ produtoId: 'p2', integracoesComProduto: [] })],
      lerIntegracoes,
      onProgress,
    );

    // Once for the plan (the sem-integracoes row) and once per conta resolved —
    // the dialog fills in as results land, it does not wait for the batch.
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    spy.mockRestore();
  });

  it('a missing integração is reported and the run CONTINUES', async () => {
    // Legacy `enviarEstoqueDialog.dart:241` used `continue`, not `return`.
    const lerIntegracoes = vi.fn().mockResolvedValue(new Map());
    const res = await run([alvo({ integracoesComProduto: ['sumiu'] })], lerIntegracoes);
    expect(res.rows[0]).toMatchObject({ motivo: 'integracao-nao-encontrada' });
    expect(res.cancelado).toBe(false);
  });

  it('only warns about an unsupported channel for produtos that actually list it', async () => {
    const lerIntegracoes = vi.fn().mockResolvedValue(
      contas({
        li: { nome: 'Loja Integrada', tipo: INTEGRACAO_TIPO.lojaIntegrada, ativo: true },
      }),
    );
    const spy = vi
      .spyOn(mercadoLivreStockProvider, 'enviarEstoque')
      .mockResolvedValue({ rows: [], pausadoAte: null });

    const res = await run(
      [alvo({ produtoId: 'p1' }), alvo({ produtoId: 'p2', integracoesComProduto: ['ml-1', 'li'] })],
      lerIntegracoes,
    );

    // Scoped by the CONTA, not by the reason — which reason a channel earns is
    // the caps table's business and it moved once already (Loja Integrada's Phase
    // 0 survey turned "nobody checked" into "not built here"). Loja Integrada
    // flips `implementado` at ITS step 22
    // (`.master_plans/loja-integrada/loja-integrada-marketplace-integration.md:68`);
    // whichever channel flips second re-points this example. The arm itself is
    // pinned table-free in `../caps/suporteCanal.test.ts:16-25`.
    const liRows = res.rows.filter((r) => r.integracaoId === 'li');
    expect(liRows.map((r) => r.produtoId)).toEqual(['p2']);
    expect(liRows[0]!.motivo).toBe('canal-nao-implementado');
    spy.mockRestore();
  });

  it('keys a row per (produto × conta), so two missing contas do not collide', async () => {
    // `key` is the React list key AND the Playwright test id. Keying these rows
    // on the produto alone gave one produto two identical keys.
    const lerIntegracoes = vi.fn().mockResolvedValue(new Map());
    const res = await run(
      [alvo({ integracoesComProduto: ['sumiu-1', 'sumiu-2'] })],
      lerIntegracoes,
    );
    expect(res.rows).toHaveLength(2);
    expect(new Set(res.rows.map((r) => r.key)).size).toBe(2);
    // …and each names the conta that went missing, rather than rendering as
    // "Integração desconhecida".
    expect(res.rows.map((r) => r.integracaoId)).toEqual(['sumiu-1', 'sumiu-2']);
  });

  it('an already-cancelled run does not even read the integração docs', async () => {
    // `getDocsByIds` takes no AbortSignal, so the only way not to pay for it is
    // to check before the call.
    const controller = new AbortController();
    controller.abort();
    const lerIntegracoes = vi.fn();
    const res = await run([alvo()], lerIntegracoes, vi.fn(), controller.signal);
    expect(lerIntegracoes).not.toHaveBeenCalled();
    expect(res.cancelado).toBe(true);
  });

  it('stops dispatching once aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const lerIntegracoes = vi.fn().mockResolvedValue(contas());
    const spy = vi.spyOn(mercadoLivreStockProvider, 'enviarEstoque');

    const res = await run([alvo()], lerIntegracoes, vi.fn(), controller.signal);

    expect(spy).not.toHaveBeenCalled();
    expect(res.cancelado).toBe(true);
    spy.mockRestore();
  });

  it.each([
    { posicao: 'only', contaIds: ['ml-1'], cancelarEm: 'ml-1' },
    { posicao: 'final', contaIds: ['ml-1', 'ml-2'], cancelarEm: 'ml-2' },
    { posicao: 'middle', contaIds: ['ml-1', 'ml-2', 'ml-3'], cancelarEm: 'ml-2' },
  ])('cancels the $posicao account and keeps completed rows', async ({ contaIds, cancelarEm }) => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    const lerIntegracoes = vi
      .fn()
      .mockResolvedValue(
        new Map(
          contaIds.map((id) => [id, { nome: id, tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true }]),
        ),
      );
    let avisarInicio!: () => void;
    const iniciado = new Promise<void>((resolve) => {
      avisarInicio = resolve;
    });
    const concluidas: StockPushRow[] = [];
    const spy = vi
      .spyOn(mercadoLivreStockProvider, 'enviarEstoque')
      .mockImplementation(({ integracao, signal }) => {
        expect(signal).toBe(controller.signal);
        if (integracao.id === cancelarEm) {
          return new Promise<StockPushChannelResult>((resolve) => {
            signal!.addEventListener('abort', () => resolve({ rows: [], pausadoAte: null }), {
              once: true,
            });
            avisarInicio();
          });
        }
        const row: StockPushRow = {
          key: `p1:${integracao.id}:MLB1`,
          produtoId: 'p1',
          produtoNome: 'Camiseta',
          integracaoId: integracao.id,
          integracaoNome: integracao.nome,
          anuncioId: 'MLB1',
          linkDocId: 'l1',
          outcome: 'enviado',
          motivo: null,
          mensagem: 'Estoque enviado.',
          quantidade: 7,
        };
        concluidas.push(row);
        return Promise.resolve({ rows: [row], pausadoAte: null });
      });

    try {
      const pendente = run(
        [alvo({ integracoesComProduto: contaIds })],
        lerIntegracoes,
        onProgress,
        controller.signal,
      );
      await iniciado;
      controller.abort();

      expect(await pendente).toEqual({ rows: concluidas, cancelado: true });
      expect(spy.mock.calls.map(([input]) => input.integracao.id)).toEqual(
        contaIds.slice(0, contaIds.indexOf(cancelarEm) + 1),
      );
      expect(onProgress).toHaveBeenLastCalledWith(concluidas);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The run's OWN `suportado` closure (`enviarEstoqueRun.ts`): Shopee — built,
   * with a provider — is handed the whole selection, including a produto that
   * never named its conta. The unbuilt arm (only the produtos that name the
   * conta) is the Loja Integrada test above.
   */
  it('hands the Shopee conta the WHOLE selection, like Mercado Livre', async () => {
    const lerIntegracoes = vi
      .fn()
      .mockResolvedValue(
        contas({ 'shopee-1': { nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true } }),
      );
    const ml = vi
      .spyOn(mercadoLivreStockProvider, 'enviarEstoque')
      .mockResolvedValue({ rows: [], pausadoAte: null });
    // One row per produto it was handed.
    const shopee = vi
      .spyOn(shopeeStockProvider, 'enviarEstoque')
      .mockImplementation(({ integracao, produtoIds }) =>
        Promise.resolve({
          pausadoAte: null,
          rows: produtoIds.map((produtoId) => ({
            key: `${produtoId}:${integracao.id}:-`,
            produtoId,
            produtoNome: null,
            integracaoId: integracao.id,
            integracaoNome: integracao.nome,
            anuncioId: null,
            linkDocId: null,
            outcome: 'pulado' as const,
            motivo: 'sem-link',
            mensagem: 'Sem anúncio.',
            quantidade: null,
          })),
        }),
      );

    try {
      const res = await run(
        [
          alvo({ produtoId: 'p1' }),
          alvo({ produtoId: 'p2', integracoesComProduto: ['ml-1', 'shopee-1'] }),
        ],
        lerIntegracoes,
      );

      const shopeeRows = res.rows.filter((r) => r.integracaoId === 'shopee-1');
      expect(shopeeRows.map((r) => r.produtoId)).toEqual(['p1', 'p2']);
    } finally {
      ml.mockRestore();
      shopee.mockRestore();
    }
  });
});
