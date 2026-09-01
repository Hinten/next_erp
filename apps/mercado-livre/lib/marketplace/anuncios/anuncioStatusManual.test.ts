import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

import { ANUNCIO_STATUS_MAX_PRODUTOS, definirStatusAnunciosManual } from './anuncioStatusManual';
import { AnuncioStatusFamiliaSemMembrosError } from './anuncioStatus';

/* --------------------------------- fixtures -------------------------------- */

const CONTA = 'int-1';
const CONTA_REF = `documents/integracao/${CONTA}`;
const NOW = 1_760_000_000_000;

/** A stored parent link, in the shape `acaoStatusAnuncio` reads. */
function link(over: Record<string, unknown> = {}) {
  return { id: 'MLB1', estado: 'p', status: 'active', contaOuterRef: CONTA_REF, ...over };
}

interface Seed {
  /** produtoId → its stored produto fields (`paiId`, `nome`). */
  produtos: Record<string, Record<string, unknown> | null>;
  /** produtoId → its `produtoMercadoLivre` docs, keyed by doc id. */
  links: Record<string, Record<string, Record<string, unknown>>>;
}

/**
 * Fake Firestore covering exactly what this orchestrator reads: `getAll` for
 * `resolverAnchors`, and one `produtoMercadoLivre` subcollection query per
 * anchor. `definirStatusAnuncio` is injected, so nothing below it runs.
 */
function fakeDb(seed: Seed): Firestore {
  return {
    collection: (path: string) => {
      // `produtos/<id>/produtoMercadoLivre` — the link subcollection.
      const m = /^produtos\/([^/]+)\/produtoMercadoLivre$/.exec(path);
      if (m) {
        const produtoId = m[1]!;
        const docs = Object.entries(seed.links[produtoId] ?? {}).map(([id, data]) => ({
          id,
          data: () => data,
        }));
        return { get: () => Promise.resolve({ docs }) };
      }
      // `produtos` — only `doc()` is used, by `resolverAnchors`.
      return { doc: (id: string) => ({ id, path: `${path}/${id}`, __id: id }) };
    },
    getAll: (...args: unknown[]) => {
      const refs = args.filter((a) => a != null && typeof a === 'object' && '__id' in a) as Array<{
        __id: string;
      }>;
      return Promise.resolve(
        refs.map((r) => {
          const data = seed.produtos[r.__id];
          return { exists: data != null, data: () => data ?? undefined };
        }),
      );
    },
  } as unknown as Firestore;
}

const api = { updateItem: vi.fn() };

/** `definirStatusAnuncio` stand-in: one applied listing by default. */
function definirFake(
  impl?: (target: { produtoId: string; linkDocId: string; itemId: string }) => unknown,
) {
  return vi
    .fn()
    .mockImplementation((_db, _conta, target) =>
      Promise.resolve(
        impl?.(target) ?? { estado: 'pa', status: 'paused', subStatus: [], aplicados: 1, total: 1 },
      ),
    );
}

beforeEach(() => vi.clearAllMocks());

/* ------------------------------- the happy path ----------------------------- */

describe('definirStatusAnunciosManual', () => {
  it('moves every eligible listing and reports one row per LISTING', async () => {
    // Two listings on one produto — the normal case here, and why the row unit
    // is the listing rather than the produto (#781).
    const db = fakeDb({
      produtos: { P1: { paiId: null, nome: 'Camiseta' } },
      links: { P1: { l1: link({ id: 'MLB1' }), l2: link({ id: 'MLB2' }) } },
    });
    const definir = definirFake();
    const res = await definirStatusAnunciosManual(
      db,
      { integracaoId: CONTA, produtoIds: ['P1'], acao: 'pausar' },
      { api, definir, nowMs: NOW },
    );

    expect(definir).toHaveBeenCalledTimes(2);
    expect(res.listings).toHaveLength(2);
    expect(res.resumo).toMatchObject({ aplicados: 2, pulados: 0, falhas: 0 });
    expect(res.listings.every((l) => l.outcome === 'enviado')).toBe(true);
    expect(res.produtosSemAnuncio).toEqual([]);
  });

  it('resolves a variation CHILD to its anchor before looking for links', async () => {
    const db = fakeDb({
      produtos: { CH1: { paiId: 'P1', nome: 'Camiseta P' }, P1: { paiId: null, nome: 'Camiseta' } },
      links: { P1: { l1: link() } },
    });
    const definir = definirFake();
    const res = await definirStatusAnunciosManual(
      db,
      { integracaoId: CONTA, produtoIds: ['CH1'], acao: 'pausar' },
      { api, definir, nowMs: NOW },
    );
    // The link lives on the ANCHOR, so a child selection must still find it.
    expect(res.listings).toHaveLength(1);
    expect(res.listings[0]).toMatchObject({ produtoId: 'P1', outcome: 'enviado' });
  });

  it('narrows to ONE listing when a linkDocId is given', async () => {
    const db = fakeDb({
      produtos: { P1: { paiId: null, nome: 'C' } },
      links: { P1: { l1: link({ id: 'MLB1' }), l2: link({ id: 'MLB2' }) } },
    });
    const definir = definirFake();
    const res = await definirStatusAnunciosManual(
      db,
      { integracaoId: CONTA, produtoIds: ['P1'], acao: 'pausar', linkDocId: 'l2' },
      { api, definir, nowMs: NOW },
    );
    expect(definir).toHaveBeenCalledTimes(1);
    expect(res.listings[0]).toMatchObject({ linkDocId: 'l2', anuncioId: 'MLB2' });
  });

  it('ignores links belonging to ANOTHER conta', async () => {
    const db = fakeDb({
      produtos: { P1: { paiId: null, nome: 'C' } },
      links: { P1: { l1: link({ contaOuterRef: 'documents/integracao/outra' }) } },
    });
    const definir = definirFake();
    const res = await definirStatusAnunciosManual(
      db,
      { integracaoId: CONTA, produtoIds: ['P1'], acao: 'pausar' },
      { api, definir, nowMs: NOW },
    );
    expect(definir).not.toHaveBeenCalled();
    expect(res.produtosSemAnuncio[0]).toMatchObject({ produtoId: 'P1', motivo: 'sem-anuncio' });
  });

  it('reports a produto that does not exist rather than dropping it', async () => {
    const db = fakeDb({ produtos: { SUMIU: null }, links: {} });
    const res = await definirStatusAnunciosManual(
      db,
      { integracaoId: CONTA, produtoIds: ['SUMIU'], acao: 'pausar' },
      { api, definir: definirFake(), nowMs: NOW },
    );
    expect(res.produtosSemAnuncio[0]).toMatchObject({ motivo: 'produto-nao-encontrado' });
  });
});

/* ------------------------------- the local gate ----------------------------- */

describe('definirStatusAnunciosManual — local eligibility gate', () => {
  async function corre(linkData: Record<string, unknown>, acao: 'pausar' | 'reativar' = 'pausar') {
    const db = fakeDb({
      produtos: { P1: { paiId: null, nome: 'C' } },
      links: { P1: { l1: linkData } },
    });
    const definir = definirFake();
    const res = await definirStatusAnunciosManual(
      db,
      { integracaoId: CONTA, produtoIds: ['P1'], acao },
      { api, definir, nowMs: NOW },
    );
    return { res, definir };
  }

  it('skips a listing that was never published, without calling ML', async () => {
    const { res, definir } = await corre(link({ id: '', estado: 'r', status: null }));
    expect(definir).not.toHaveBeenCalled();
    expect(res.listings[0]).toMatchObject({ outcome: 'pulado', motivo: 'sem-id-externo' });
  });

  it('skips a CANCELLED listing — closed is terminal on ML', async () => {
    const { res, definir } = await corre(link({ estado: 'c', status: 'closed' }));
    expect(definir).not.toHaveBeenCalled();
    expect(res.listings[0]).toMatchObject({ outcome: 'pulado', motivo: 'anuncio-cancelado' });
  });

  it('skips a listing ML is still deciding on', async () => {
    const { res, definir } = await corre(link({ estado: 'v', status: 'under_review' }));
    expect(definir).not.toHaveBeenCalled();
    expect(res.listings[0]).toMatchObject({ outcome: 'pulado', motivo: 'status-indefinido' });
  });

  it('skips — never fails — a listing already in the requested state', async () => {
    const jaPausado = await corre(link({ estado: 'pa', status: 'paused' }), 'pausar');
    expect(jaPausado.definir).not.toHaveBeenCalled();
    expect(jaPausado.res.listings[0]).toMatchObject({ outcome: 'pulado', motivo: 'ja-pausado' });

    const jaAtivo = await corre(link({ estado: 'p', status: 'active' }), 'reativar');
    expect(jaAtivo.res.listings[0]).toMatchObject({ outcome: 'pulado', motivo: 'ja-ativo' });
  });

  it('reactivates a paused listing', async () => {
    const { res, definir } = await corre(link({ estado: 'pa', status: 'paused' }), 'reativar');
    expect(definir).toHaveBeenCalledTimes(1);
    expect(res.listings[0]).toMatchObject({ outcome: 'enviado' });
  });
});

/* --------------------------------- failures --------------------------------- */

describe('definirStatusAnunciosManual — failures are DATA', () => {
  const db = () =>
    fakeDb({ produtos: { P1: { paiId: null, nome: 'C' } }, links: { P1: { l1: link() } } });

  it('turns an ML refusal into a row carrying ML’s own message', async () => {
    const definir = vi
      .fn()
      .mockRejectedValue(new MercadoLivreHttpError('item nao pode ser pausado', 400, null));
    const res = await definirStatusAnunciosManual(
      db(),
      { integracaoId: CONTA, produtoIds: ['P1'], acao: 'pausar' },
      { api, definir, nowMs: NOW },
    );
    expect(res.listings[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'erro-mercado-livre',
      mensagem: 'item nao pode ser pausado',
    });
    expect(res.resumo.falhas).toBe(1);
  });

  it('turns the family-without-members refusal into an actionable skip', async () => {
    const definir = vi.fn().mockRejectedValue(new AnuncioStatusFamiliaSemMembrosError());
    const res = await definirStatusAnunciosManual(
      db(),
      { integracaoId: CONTA, produtoIds: ['P1'], acao: 'pausar' },
      { api, definir, nowMs: NOW },
    );
    expect(res.listings[0]).toMatchObject({ outcome: 'pulado', motivo: 'familia-sem-membros' });
    expect(res.listings[0]!.mensagem).toContain('importe ou publique');
  });

  it('RETHROWS anything that is not an ML HTTP refusal (repo rule 6)', async () => {
    const definir = vi.fn().mockRejectedValue(new TypeError('bug'));
    await expect(
      definirStatusAnunciosManual(
        db(),
        { integracaoId: CONTA, produtoIds: ['P1'], acao: 'pausar' },
        { api, definir, nowMs: NOW },
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('stops after a 429 and stamps pausadoAte', async () => {
    const muitos = fakeDb({
      produtos: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`P${String(i)}`, { paiId: null, nome: 'C' }]),
      ),
      links: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`P${String(i)}`, { l1: link() }]),
      ),
    });
    const definir = vi
      .fn()
      .mockRejectedValue(new MercadoLivreHttpError('too many requests', 429, null));
    const res = await definirStatusAnunciosManual(
      muitos,
      {
        integracaoId: CONTA,
        produtoIds: Array.from({ length: 12 }, (_, i) => `P${String(i)}`),
        acao: 'pausar',
      },
      { api, definir, nowMs: NOW },
    );
    expect(res.pausadoAte).not.toBeNull();
    // Every listing is accounted for — some attempted, the rest reported as
    // not attempted rather than silently missing from the report.
    expect(res.listings).toHaveLength(12);
    expect(res.resumo.naoTentados).toBeGreaterThan(0);
    expect(definir.mock.calls.length).toBeLessThan(12);
  });
});

/* --------------------------- partial family outcomes ------------------------ */

describe('definirStatusAnunciosManual — a family that only partly moved', () => {
  it('reports the tally and does NOT claim the family was paused', async () => {
    const db = fakeDb({
      produtos: { P1: { paiId: null, nome: 'C' } },
      links: { P1: { l1: link({ id: '6264141844942250' }) } },
    });
    const definir = definirFake(() => ({
      estado: 'p',
      // The fold DECLINED to call the family paused, because one member never
      // moved — and the message must say what ML reports, not what was asked.
      status: 'active',
      subStatus: [],
      aplicados: 2,
      total: 3,
      membros: [],
    }));
    const res = await definirStatusAnunciosManual(
      db,
      { integracaoId: CONTA, produtoIds: ['P1'], acao: 'pausar' },
      { api, definir, nowMs: NOW },
    );
    const row = res.listings[0]!;
    expect(row).toMatchObject({ outcome: 'enviado', motivo: 'parcial', statusFinal: 'active' });
    expect(row.membros).toEqual({ total: 3, aplicados: 2 });
    expect(row.mensagem).toContain('2 de 3');
    // ⚠️ The honest half: our write landed on two members, but ML still reports
    // the family active, and the row says so instead of reading as a success.
    expect(row.mensagem).toContain('"active"');
  });

  it('marks a family where NOTHING moved as a failure', async () => {
    const db = fakeDb({
      produtos: { P1: { paiId: null, nome: 'C' } },
      links: { P1: { l1: link() } },
    });
    const definir = definirFake(() => ({
      estado: 'p',
      status: 'active',
      subStatus: [],
      aplicados: 0,
      total: 2,
      membros: [],
    }));
    const res = await definirStatusAnunciosManual(
      db,
      { integracaoId: CONTA, produtoIds: ['P1'], acao: 'pausar' },
      { api, definir, nowMs: NOW },
    );
    expect(res.listings[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'nenhum-anuncio-alterado',
    });
  });
});

describe('the selection cap', () => {
  it('is the same 50 the other produto-scoped pushes use', () => {
    expect(ANUNCIO_STATUS_MAX_PRODUTOS).toBe(50);
  });
});
