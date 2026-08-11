import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { type EnviarEstoqueAlvo, enviarEstoqueParaMarketplaces } from './enviarEstoqueRun';
import { mercadoLivreStockProvider } from './providers/mercadoLivre';

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
    { db, deps: { mercadoLivre: null }, lerIntegracoes: lerIntegracoes as never, signal },
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
    const lerIntegracoes = vi
      .fn()
      .mockResolvedValue(
        contas({ shopee: { nome: 'Shopee', tipo: INTEGRACAO_TIPO.shopee, ativo: true } }),
      );
    const spy = vi
      .spyOn(mercadoLivreStockProvider, 'enviarEstoque')
      .mockResolvedValue({ rows: [], pausadoAte: null });

    const res = await run(
      [
        alvo({ produtoId: 'p1' }),
        alvo({ produtoId: 'p2', integracoesComProduto: ['ml-1', 'shopee'] }),
      ],
      lerIntegracoes,
    );

    const shopeeRows = res.rows.filter((r) => r.motivo === 'canal-nao-suportado');
    expect(shopeeRows.map((r) => r.produtoId)).toEqual(['p2']);
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
});
