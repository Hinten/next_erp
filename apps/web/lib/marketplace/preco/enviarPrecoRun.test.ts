import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { type EnviarPrecoAlvo, enviarPrecoParaMarketplaces } from './enviarPrecoRun';
import { mercadoLivrePriceProvider } from './providers/mercadoLivre';

/**
 * The orchestration itself (dedup, the single chunked read, the whole-selection
 * dispatch, the cancel checks, the per-conta row keys) lives in `../push/run.ts`
 * and is pinned by `../estoque/enviarEstoqueRun.test.ts` against the same code
 * path. What is worth pinning HERE is only what this binding decides: the
 * price-shaped row and the option it threads through.
 */

const db = {} as Firestore;

function alvo(over: Partial<EnviarPrecoAlvo> = {}): EnviarPrecoAlvo {
  return { produtoId: 'p1', produtoNome: 'Camiseta', integracoesComProduto: ['ml-1'], ...over };
}

const contas = () =>
  new Map<string, { nome: string; tipo: number; ativo: boolean }>([
    ['ml-1', { nome: 'Loja ML', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true }],
  ]);

function run(
  alvos: EnviarPrecoAlvo[],
  baixarPreco: boolean,
  lerIntegracoes: ReturnType<typeof vi.fn>,
) {
  return enviarPrecoParaMarketplaces(
    alvos,
    baixarPreco,
    { db, deps: { mercadoLivre: null }, lerIntegracoes: lerIntegracoes as never },
    vi.fn(),
  );
}

describe('enviarPrecoParaMarketplaces', () => {
  it('threads baixarPreco down to the provider', async () => {
    const lerIntegracoes = vi.fn().mockResolvedValue(contas());
    const spy = vi
      .spyOn(mercadoLivrePriceProvider, 'enviarPreco')
      .mockResolvedValue({ rows: [], pausadoAte: null });

    await run([alvo()], true, lerIntegracoes);

    expect(spy.mock.calls[0]![0].baixarPreco).toBe(true);
    spy.mockRestore();
  });

  it('a supported channel gets the WHOLE selection, deduped to one integração read', async () => {
    // The N+1 pin, and #804 S7: the channel is authoritative about its own
    // links, so the drifting `integracoesComProduto` denorm never decides what
    // gets sent.
    const alvos = Array.from({ length: 50 }, (_, i) => alvo({ produtoId: `p${String(i)}` }));
    const lerIntegracoes = vi.fn().mockResolvedValue(contas());
    const spy = vi
      .spyOn(mercadoLivrePriceProvider, 'enviarPreco')
      .mockResolvedValue({ rows: [], pausadoAte: null });

    await run(alvos, false, lerIntegracoes);

    expect(lerIntegracoes).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].produtoIds).toHaveLength(50);
    spy.mockRestore();
  });

  it('rows the orchestrator invents are PRICE-shaped, with null prices', async () => {
    const lerIntegracoes = vi.fn();
    const res = await run([alvo({ integracoesComProduto: [] })], false, lerIntegracoes);

    expect(lerIntegracoes).not.toHaveBeenCalled();
    expect(res.rows).toEqual([
      expect.objectContaining({
        motivo: 'sem-integracoes',
        mensagem: 'Produto não tem integrações',
        preco: null,
        precoAnterior: null,
      }),
    ]);
  });
});
