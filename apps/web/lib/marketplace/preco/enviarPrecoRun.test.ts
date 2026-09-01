import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import {
  type EnviarPrecoAlvo,
  type EnviarPrecoOpcoes,
  enviarPrecoParaMarketplaces,
} from './enviarPrecoRun';
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
  opcoes: Partial<EnviarPrecoOpcoes>,
  lerIntegracoes: ReturnType<typeof vi.fn>,
) {
  return enviarPrecoParaMarketplaces(
    alvos,
    { baixarPreco: false, incluirNaoPublicados: true, ...opcoes },
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

    await run([alvo()], { baixarPreco: true }, lerIntegracoes);

    expect(spy.mock.calls[0]![0].baixarPreco).toBe(true);
    spy.mockRestore();
  });

  /**
   * The twin of the assertion above, and it needs to exist separately: the two
   * options are threaded through the SAME object literal in `dispatch`, so a
   * copy-paste that reads `opcoes.baixarPreco` into both fields typechecks,
   * keeps the test above green, and silently pins `incluirNaoPublicados` to
   * whatever the price option happens to be.
   *
   * Both directions, because a test that only proves the flag reaches the
   * provider as `false` cannot show it ever reaches it as `true`.
   */
  it.each([true, false])(
    'threads incluirNaoPublicados=%s down to the provider, independently of baixarPreco',
    async (incluirNaoPublicados) => {
      const lerIntegracoes = vi.fn().mockResolvedValue(contas());
      const spy = vi
        .spyOn(mercadoLivrePriceProvider, 'enviarPreco')
        .mockResolvedValue({ rows: [], pausadoAte: null });

      try {
        // Deliberately the OPPOSITE of `incluirNaoPublicados`, so a transposed
        // or aliased field cannot produce the expected value by coincidence.
        await run(
          [alvo()],
          { baixarPreco: !incluirNaoPublicados, incluirNaoPublicados },
          lerIntegracoes,
        );

        expect(spy.mock.calls[0]![0].incluirNaoPublicados).toBe(incluirNaoPublicados);
        expect(spy.mock.calls[0]![0].baixarPreco).toBe(!incluirNaoPublicados);
      } finally {
        // ⚠️ `finally`, unlike its neighbours: this case runs TWICE, so a failing
        // assertion that skipped the restore would leak the spy into the next
        // iteration and report a second, bogus "called 3 times" failure on top
        // of the real one.
        spy.mockRestore();
      }
    },
  );

  it('a supported channel gets the WHOLE selection, deduped to one integração read', async () => {
    // The N+1 pin, and #804 S7: the channel is authoritative about its own
    // links, so the drifting `integracoesComProduto` denorm never decides what
    // gets sent.
    const alvos = Array.from({ length: 50 }, (_, i) => alvo({ produtoId: `p${String(i)}` }));
    const lerIntegracoes = vi.fn().mockResolvedValue(contas());
    const spy = vi
      .spyOn(mercadoLivrePriceProvider, 'enviarPreco')
      .mockResolvedValue({ rows: [], pausadoAte: null });

    await run(alvos, { baixarPreco: false }, lerIntegracoes);

    expect(lerIntegracoes).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].produtoIds).toHaveLength(50);
    spy.mockRestore();
  });

  it('rows the orchestrator invents are PRICE-shaped, with null prices', async () => {
    const lerIntegracoes = vi.fn();
    const res = await run(
      [alvo({ integracoesComProduto: [] })],
      { baixarPreco: false },
      lerIntegracoes,
    );

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
