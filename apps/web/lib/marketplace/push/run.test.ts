import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { type PushDispatchArgs, enviarParaMarketplaces } from './run';
import type { PushAlvo, PushRowBase } from './types';

/**
 * The cancel the loop head cannot see (#1529, Q5(b)).
 *
 * The rest of `run.ts` is pinned through the estoque binding
 * (`../estoque/enviarEstoqueRun.test.ts`); this file drives the orchestrator
 * directly, because the case needs a dispatch that aborts the run WHILE it is in
 * flight and answers the way a provider answers an abort — `{ rows: [] }`.
 */

const db = {} as Firestore;

const alvo = (produtoId: string, contas: string[]): PushAlvo => ({
  produtoId,
  produtoNome: produtoId,
  integracoesComProduto: contas,
});

const contas = new Map([
  ['ml-1', { nome: 'Loja ML', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true }],
  ['shopee-1', { nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true }],
]);

function linhaDe(args: PushDispatchArgs): PushRowBase[] {
  return args.produtoIds.map((produtoId) => ({
    key: `${produtoId}:${args.integracao.id}:-`,
    produtoId,
    produtoNome: null,
    integracaoId: args.integracao.id,
    integracaoNome: args.integracao.nome,
    anuncioId: null,
    linkDocId: null,
    outcome: 'enviado' as const,
    motivo: null,
    mensagem: 'ok',
  }));
}

/**
 * A run over `alvos` whose dispatch, for the conta named `abortarEm`, cancels the
 * run mid-call and answers `{ rows: [] }` — exactly what a provider returns when
 * its request was aborted. Every other conta answers one row per produto.
 */
function rodar(alvos: PushAlvo[], abortarEm: string | null) {
  const controller = new AbortController();
  const dispatch = vi.fn((args: PushDispatchArgs) => {
    if (args.integracao.id === abortarEm) {
      controller.abort();
      return Promise.resolve({ rows: [] as PushRowBase[] });
    }
    return Promise.resolve({ rows: linhaDe(args) });
  });
  const run = enviarParaMarketplaces<PushRowBase>(
    alvos,
    {
      db,
      suportado: () => true,
      dispatch,
      completarLinha: (base) => base,
      lerIntegracoes: () => Promise.resolve(contas),
      signal: controller.signal,
    },
    vi.fn(),
  );
  return { run, dispatch };
}

describe('enviarParaMarketplaces — a cancel during the LAST conta (R1)', () => {
  it('a one-conta run cancelled mid-dispatch reports the cancel', async () => {
    // Before the post-loop check the produtos simply vanished from the counts:
    // no rows, `cancelado: false`, no banner — a run that "finished" with nothing.
    const { run, dispatch } = rodar([alvo('p1', ['shopee-1'])], 'shopee-1');
    const res = await run;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ rows: [], cancelado: true });
  });

  it("the LAST of two contas cancelled mid-dispatch keeps the first conta's rows and reports it", async () => {
    const { run, dispatch } = rodar([alvo('p1', ['ml-1', 'shopee-1'])], 'shopee-1');
    const res = await run;
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(res.cancelado).toBe(true);
    expect(res.rows.map((r) => r.key)).toEqual(['p1:ml-1:-']);
  });

  it('NEAR MISS: the same run with nobody cancelling is NOT cancelled', async () => {
    const { run } = rodar([alvo('p1', ['ml-1', 'shopee-1'])], null);
    const res = await run;
    expect(res.cancelado).toBe(false);
    expect(res.rows.map((r) => r.key)).toEqual(['p1:ml-1:-', 'p1:shopee-1:-']);
  });

  it('a cancel during an EARLIER conta still stops the loop before the next dispatch', async () => {
    const { run, dispatch } = rodar([alvo('p1', ['ml-1', 'shopee-1'])], 'ml-1');
    const res = await run;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ rows: [], cancelado: true });
  });
});
