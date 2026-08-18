import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreValidationError,
} from '@delfrance/integrations-mercado-livre';

import type { PrecoFamilyRow } from './precoPlan';
import type { PrecoDraftOutcome, PriceSyncApi } from './precoDraftSend';
import {
  MANUAL_PRECO_MAX_PRODUTOS,
  ManualPrecoGuardError,
  enviarPrecoManual,
  manualPrecoConcurrency,
  mensagemDe,
} from './precoManual';

const CONTA = 'conta-1';
const TAB = 'tabNormal1';
const CONTA_DOC = { tabelaNormalOuterRef: `documents/tabelasDePrecos/${TAB}`, nome: 'Loja ML' };

/* --------------------------------- fixtures -------------------------------- */

/** Minimal fake Firestore: `resolverAnchors` only needs docRef + getAll. */
function fakeDb(docs: Record<string, Record<string, unknown> | null>): Firestore {
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({ id, path: `${name}/${id}`, __id: id }),
    }),
    getAll: (...args: unknown[]) => {
      const refs = args.filter(
        (a): a is { __id: string } => a != null && typeof a === 'object' && '__id' in a,
      );
      return Promise.resolve(
        refs.map((ref) => {
          const data = docs[ref.__id];
          return { exists: data != null, data: () => data ?? undefined };
        }),
      );
    },
  };
  return db as unknown as Firestore;
}

function familyRow(over: Partial<PrecoFamilyRow> = {}): PrecoFamilyRow {
  return {
    produtoId: 'PROD',
    precos: { [TAB]: { valor: 50 } },
    propagatePriceToChildren: true,
    publicado: true,
    paiId: null,
    links: [
      {
        linkDocId: 'link1',
        id: 'MLB111',
        estado: 'p',
        status: 'active',
        sub_status: null,
        isUserProductModel: false,
      },
    ],
    children: [],
    ...over,
  };
}

const api = {} as unknown as PriceSyncApi;

/** Every send resolves to the same outcome unless a per-item map says otherwise. */
function fakeSend(
  outcome: PrecoDraftOutcome | ((itemId: string) => PrecoDraftOutcome),
): NonNullable<Parameters<typeof enviarPrecoManual>[2]['sendDraft']> {
  return vi.fn(async (_db, draft) =>
    typeof outcome === 'function' ? outcome(draft.itemId) : outcome,
  ) as never;
}

const ENVIADO: PrecoDraftOutcome = {
  kind: 'enviado',
  preco: 50,
  precoAtual: 40,
  variacoes: null,
};

function run(
  over: {
    docs?: Record<string, Record<string, unknown> | null>;
    produtoIds?: string[];
    baixarPreco?: boolean;
    rows?: PrecoFamilyRow[];
    conta?: Record<string, unknown>;
    sendDraft?: NonNullable<Parameters<typeof enviarPrecoManual>[2]['sendDraft']>;
  } = {},
) {
  const docs = over.docs ?? { PROD: { paiId: null, nome: 'Camiseta' } };
  return enviarPrecoManual(
    fakeDb(docs),
    {
      integracaoId: CONTA,
      produtoIds: over.produtoIds ?? ['PROD'],
      baixarPreco: over.baixarPreco,
    },
    {
      nowMs: 1_700_000_000_000,
      conta: over.conta ?? CONTA_DOC,
      contaNome: 'Loja ML',
      api,
      fetchFamilias: vi.fn(async () => over.rows ?? [familyRow()]),
      sendDraft: over.sendDraft ?? fakeSend(ENVIADO),
    },
  );
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MERCADO_LIVRE_PRECO_MANUAL_CONCURRENCY;
});

/* -------------------------------------------------------------------------- */

describe('conta guards', () => {
  it('refuses a conta with no tabela normal — the run has no price source at all', async () => {
    await expect(run({ conta: { nome: 'Loja ML' } })).rejects.toBeInstanceOf(ManualPrecoGuardError);
    await expect(run({ conta: { tabelaNormalOuterRef: '' } })).rejects.toMatchObject({
      code: 'ML_CONTA_SEM_TABELA_NORMAL',
      status: 400,
    });
  });
});

describe('#804 S6/S7 — the classes the account-wide query drops silently', () => {
  it('an UNPUBLISHED produto with a live link produces a row, not silence', async () => {
    const res = await run({ rows: [familyRow({ publicado: false })] });

    expect(res.listings).toHaveLength(1);
    expect(res.listings[0]).toMatchObject({
      produtoId: 'PROD',
      outcome: 'pulado',
      motivo: 'NAO_PUBLICADO',
      mensagem: 'O produto está oculto (não publicado) no ERP.',
    });
    expect(res.resumo).toMatchObject({ enviados: 0, pulados: 1 });
  });

  it('a produto whose link is missing for this conta reports SEM_LINK rather than vanishing', async () => {
    const res = await run({ rows: [familyRow({ links: [] })] });

    expect(res.listings).toHaveLength(1);
    expect(res.listings[0]).toMatchObject({
      outcome: 'pulado',
      motivo: 'SEM_LINK',
      mensagem: 'Este produto não tem anúncio nesta conta.',
    });
  });

  it('a selected VARIATION CHILD is priced through its anchor', async () => {
    const send = fakeSend(ENVIADO);
    const res = await enviarPrecoManual(
      fakeDb({ CHILD: { paiId: 'PROD', nome: 'Camiseta P' } }),
      { integracaoId: CONTA, produtoIds: ['CHILD'] },
      {
        nowMs: 1,
        conta: CONTA_DOC,
        contaNome: 'Loja ML',
        api,
        // The family read is asked for the ANCHOR, never the selected child.
        fetchFamilias: vi.fn(async (_db, args) => {
          expect(args.anchorIds).toEqual(['PROD']);
          return [familyRow()];
        }),
        sendDraft: send,
      },
    );

    expect(res.listings.map((l) => l.outcome)).toEqual(['enviado']);
    expect(res.familias).toBe(1);
  });

  it('a 2-deep paiId chain is reported, never priced as a family', async () => {
    const res = await run({ rows: [familyRow({ paiId: 'TOP' })] });

    expect(res.listings).toEqual([]);
    expect(res.produtosSemEnvio).toEqual([
      {
        produtoId: 'PROD',
        produtoNome: 'Camiseta',
        motivo: 'FAMILIA_NAO_ENCONTRADA',
        mensagem: 'Produto não encontrado ou não é um produto pai.',
      },
    ]);
  });

  it('a produto document that does not exist is reported PRODUTO_NAO_ENCONTRADO', async () => {
    const res = await run({ docs: { PROD: null }, rows: [] });

    expect(res.produtosSemEnvio).toEqual([
      {
        produtoId: 'PROD',
        produtoNome: null,
        motivo: 'PRODUTO_NAO_ENCONTRADO',
        mensagem: 'Produto não encontrado.',
      },
    ]);
    expect(res.familias).toBe(0);
  });

  it('an anchor the family read did not return is reported FAMILIA_NAO_ENCONTRADA', async () => {
    const res = await run({ rows: [] });

    expect(res.produtosSemEnvio.map((p) => p.motivo)).toEqual(['FAMILIA_NAO_ENCONTRADA']);
  });
});

describe('sending', () => {
  it('reports the old and the new price on a successful send', async () => {
    const res = await run();

    expect(res.listings[0]).toMatchObject({
      outcome: 'enviado',
      motivo: null,
      preco: 50,
      precoAnterior: 40,
      anuncioId: 'MLB111',
      linkDocId: 'link1',
      mensagem: 'Preço atualizado de 40 para 50.',
    });
    expect(res.resumo).toMatchObject({ enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 });
  });

  it('forwards baixarPreco to the sender — the produtos table opts IN', async () => {
    const send = fakeSend(ENVIADO);
    await run({ baixarPreco: true, sendDraft: send });

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      api,
      expect.objectContaining({ baixarPreco: true }),
    );
  });

  it('defaults baixarPreco to false when the caller omits it', async () => {
    const send = fakeSend(ENVIADO);
    await run({ sendDraft: send });

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      api,
      expect.objectContaining({ baixarPreco: false }),
    );
  });

  it('a skipped listing carries the SENDER code and this module`s pt-BR wording', async () => {
    const res = await run({
      sendDraft: fakeSend({ kind: 'pulado', code: 'PRECO_ANTIGO_MAIOR', precoAtual: 60 }),
    });

    expect(res.listings[0]).toMatchObject({
      outcome: 'pulado',
      motivo: 'PRECO_ANTIGO_MAIOR',
      precoAnterior: 60,
    });
    expect(res.listings[0]!.mensagem).toContain('Permitir baixar preços');
  });

  it('a failure prefers the channel`s own message over the generic table entry', async () => {
    const res = await run({
      sendDraft: fakeSend({
        kind: 'falha',
        code: 'UPDATE_PRECO_ERROR',
        error: 'price must be greater than 0',
        precoAtual: 40,
      }),
    });

    expect(res.listings[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'UPDATE_PRECO_ERROR',
      mensagem: 'price must be greater than 0',
    });
    expect(res.resumo.falhas).toBe(1);
  });
});

describe('aborts', () => {
  const twoLinkRow = familyRow({
    links: [
      {
        linkDocId: 'link1',
        id: 'MLB111',
        estado: 'p',
        status: 'active',
        sub_status: null,
        isUserProductModel: false,
      },
      {
        linkDocId: 'link2',
        id: 'MLB222',
        estado: 'p',
        status: 'active',
        sub_status: null,
        isUserProductModel: false,
      },
    ],
  });

  beforeEach(() => {
    // Serialize the pool so "the first send aborts the rest" is deterministic
    // rather than a race between two concurrent workers.
    process.env.MERCADO_LIVRE_PRECO_MANUAL_CONCURRENCY = '1';
  });

  it('a 429 aborts the run, stamps pausadoAte and reports the rest nao-tentado', async () => {
    const res = await run({
      rows: [twoLinkRow],
      sendDraft: fakeSend((itemId) =>
        itemId === 'MLB111'
          ? { kind: 'pausa', err: new MercadoLivreHttpError('rate limited', 429, null) }
          : ENVIADO,
      ),
    });

    expect(res.listings.map((l) => [l.anuncioId, l.outcome, l.motivo])).toEqual([
      ['MLB111', 'nao-tentado', 'CONTA_PAUSADA'],
      ['MLB222', 'nao-tentado', 'CONTA_PAUSADA'],
    ]);
    expect(typeof res.pausadoAte).toBe('string');
    expect(res.resumo.naoTentados).toBe(2);
  });

  it('a dead credential aborts with REAUTH — reconnecting is a human action', async () => {
    const res = await run({
      rows: [twoLinkRow],
      sendDraft: fakeSend((itemId) =>
        itemId === 'MLB111' ? { kind: 'fatal', erro: 'credencial expirada' } : ENVIADO,
      ),
    });

    expect(res.listings.map((l) => l.motivo)).toEqual(['REAUTH', 'REAUTH']);
    expect(res.listings[0]!.mensagem).toBe('credencial expirada');
    expect(res.pausadoAte).toBeNull();
  });

  it('a 5xx the sender rethrows becomes ONE failed listing, not a dead request', async () => {
    const send = vi.fn(async (_db: unknown, draft: { itemId: string }) => {
      if (draft.itemId === 'MLB111') {
        throw new MercadoLivreHttpError('bad gateway', 502, null);
      }
      return ENVIADO;
    }) as never;
    const res = await run({ rows: [twoLinkRow], sendDraft: send });

    expect(res.listings.map((l) => [l.anuncioId, l.outcome, l.motivo])).toEqual([
      ['MLB111', 'falha', 'ERRO_CANAL'],
      ['MLB222', 'enviado', null],
    ]);
  });

  /**
   * `enviarPrecoDraft` rethrows every ML error it does not classify, not just
   * the 5xx one: a `fetch` that never connected and a response ML changed the
   * shape of both come out as siblings of `MercadoLivreHttpError`. Catching only
   * the HTTP subclass let those escape `runPool`'s `Promise.all` and answer the
   * REQUEST with an error, throwing away every listing's outcome — including the
   * ones already sent, whose link writebacks had already happened.
   */
  it.each([
    ['network', new MercadoLivreNetworkError('fetch failed')],
    ['validation', new MercadoLivreValidationError('resposta inesperada', [])],
  ])('a %s error is ONE failed listing, never a dead request', async (_nome, erro) => {
    const send = vi.fn(async (_db: unknown, draft: { itemId: string }) => {
      if (draft.itemId === 'MLB111') throw erro;
      return ENVIADO;
    }) as never;

    const res = await run({ rows: [twoLinkRow], sendDraft: send });

    expect(res.listings.map((l) => [l.anuncioId, l.outcome, l.motivo])).toEqual([
      ['MLB111', 'falha', 'ERRO_CANAL'],
      ['MLB222', 'enviado', null],
    ]);
    expect(res.resumo).toMatchObject({ enviados: 1, falhas: 1 });
  });

  it('a non-ML error is never swallowed (repo rule 6)', async () => {
    const send = vi.fn(async () => {
      throw new TypeError('coding bug');
    }) as never;

    await expect(run({ sendDraft: send })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('tunables + wording', () => {
  it('caps the selection at the legacy 50 and floors concurrency at 1', () => {
    expect(MANUAL_PRECO_MAX_PRODUTOS).toBe(50);

    process.env.MERCADO_LIVRE_PRECO_MANUAL_CONCURRENCY = '0';
    expect(manualPrecoConcurrency()).toBe(1);
    process.env.MERCADO_LIVRE_PRECO_MANUAL_CONCURRENCY = '8';
    expect(manualPrecoConcurrency()).toBe(8);
  });

  it('names the status back to the operator for the dynamic STATUS_<x> codes', () => {
    expect(mensagemDe('STATUS_payment_required')).toContain('payment_required');
    expect(mensagemDe('PRECO_NAO_MODIFICAVEL')).toContain('automação de preços');
    // An unknown code still renders something safe rather than `undefined`.
    expect(mensagemDe('QUALQUER_COISA')).toBe('Não enviado.');
  });
});
