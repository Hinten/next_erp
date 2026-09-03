import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

const h = vi.hoisted(() => ({
  applyItemStatusToLink: vi.fn(),
  applyFamilyStatusAndFold: vi.fn(),
}));

// The fold itself is covered end-to-end against a real FakeDb in
// `itemsStatusSync.test.ts` and `upFamilyStatus.test.ts`. What THIS module owns
// is which ML calls it makes and what it hands the fold — the same seam
// `reverificarAnuncio.test.ts` uses, for the same reason.
vi.mock('./itemsStatusSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./itemsStatusSync')>();
  return {
    ...actual,
    applyItemStatusToLink: h.applyItemStatusToLink,
    applyFamilyStatusAndFold: h.applyFamilyStatusAndFold,
  };
});

const { AnuncioStatusFamiliaSemMembrosError, definirStatusAnuncio } =
  await import('./anuncioStatus');

/* --------------------------------- fixtures -------------------------------- */

const CONTA = 'conta-A';
const PRODUTO = 'prod1';
const LINK = 'link1';
const ITEM = 'MLB111';
/** ML's own numeric family key — the shape `PUT /items/{id}` answers 404 for. */
const FAMILY_ID = '6264141844942250';
const PML_REF = `documents/produtos/${PRODUTO}/produtoMercadoLivre/${LINK}`;
const NOW = 1_760_000_000_000;

const alvo = (itemId = ITEM) => ({ produtoId: PRODUTO, linkDocId: LINK, itemId });

interface MembroSeed {
  itemId: string | null;
  child: string;
}

/** Minimal fake Firestore: this module only reads the family-member group query. */
function fakeDb(membros: MembroSeed[]): Firestore {
  return {
    collectionGroup: () => ({
      where: () => ({
        get: () =>
          Promise.resolve({
            docs: membros.map((m) => ({
              id: `v-${m.child}`,
              data: () => ({ itemId: m.itemId, produtoMercadoLivreOuterRef: PML_REF }),
              ref: { parent: { parent: { id: m.child } } },
            })),
          }),
      }),
    }),
  } as unknown as Firestore;
}

/** An ML item as `PUT /items/{id}` answers it. */
function item(over: Partial<Record<string, unknown>> = {}) {
  return { id: ITEM, status: 'paused', sub_status: [], ...over } as never;
}

function apiFake(updateItem = vi.fn().mockResolvedValue(item())) {
  return { updateItem };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.applyItemStatusToLink.mockResolvedValue('synced');
  h.applyFamilyStatusAndFold.mockResolvedValue({
    outcome: 'synced-family',
    estado: 'pa',
    status: 'paused',
    subStatus: [],
  });
});

/* ------------------------------ a simple listing ---------------------------- */

describe('definirStatusAnuncio — simple listing', () => {
  it('sends ONLY a status and records what ML answered', async () => {
    const api = apiFake();
    const res = await definirStatusAnuncio(fakeDb([]), CONTA, alvo(), 'pausar', api, NOW);

    expect(api.updateItem).toHaveBeenCalledTimes(1);
    // ⚠️ The body is `{ status }` and nothing else: a status bundled with other
    // fields is silently ignored on some listings, which would report a pause
    // that never happened.
    expect(api.updateItem).toHaveBeenCalledWith(ITEM, { status: 'paused' });
    expect(res).toMatchObject({ estado: 'pa', status: 'paused', aplicados: 1, total: 1 });
    expect(res.membros).toBeUndefined();
  });

  it('reactivating sends `active`', async () => {
    const api = apiFake(vi.fn().mockResolvedValue(item({ status: 'active' })));
    const res = await definirStatusAnuncio(fakeDb([]), CONTA, alvo(), 'reativar', api, NOW);

    expect(api.updateItem).toHaveBeenCalledWith(ITEM, { status: 'active' });
    expect(res).toMatchObject({ estado: 'p', status: 'active', aplicados: 1 });
  });

  /**
   * ⚠️ THE sharp one. Everything else here would still pass if the writeback
   * stored the status we ASKED for, because in every other case ML agrees with
   * us. This is the case where it does not: ML refuses to reactivate a
   * zero-stock listing and answers `paused` + `out_of_stock` on a **200**. If
   * the module recorded its own request, the link would claim `active` for a
   * listing that is not selling, the tab would offer "Pausar" on it, and the
   * stock sweep would read a state ML never confirmed.
   */
  it('records ML’s ANSWER, not the requested status, when the two disagree', async () => {
    const api = apiFake(
      vi.fn().mockResolvedValue(item({ status: 'paused', sub_status: ['out_of_stock'] })),
    );
    const res = await definirStatusAnuncio(fakeDb([]), CONTA, alvo(), 'reativar', api, NOW);

    expect(api.updateItem).toHaveBeenCalledWith(ITEM, { status: 'active' });
    const [, , , itemGravado] = h.applyItemStatusToLink.mock.calls[0]!;
    expect(itemGravado).toMatchObject({ status: 'paused', sub_status: ['out_of_stock'] });
    expect(res).toMatchObject({ estado: 'pa', status: 'paused', subStatus: ['out_of_stock'] });
  });

  it('clears errors and writes `moderacoes: []` when ML reports no moderation', async () => {
    await definirStatusAnuncio(fakeDb([]), CONTA, alvo(), 'pausar', apiFake(), NOW);
    const [, , , , opts] = h.applyItemStatusToLink.mock.calls[0]!;
    expect(opts).toMatchObject({ nowMs: NOW });
    // `clearFalha()` — our write landed, so the diagnosis it left is stale.
    expect(opts.extra).toMatchObject({ moderacoes: [], errors: [], causas: [] });
  });

  it('OMITS `moderacoes` when ML’s own reading says one exists (#1252)', async () => {
    // The near-miss for the rung above: `moderation_penalty` means the reason
    // is live, so writing `[]` here would erase what the pause was FOR.
    const api = apiFake(
      vi.fn().mockResolvedValue(item({ status: 'paused', sub_status: ['moderation_penalty'] })),
    );
    await definirStatusAnuncio(fakeDb([]), CONTA, alvo(), 'pausar', api, NOW);
    const [, , , , opts] = h.applyItemStatusToLink.mock.calls[0]!;
    expect(opts.extra).not.toHaveProperty('moderacoes');
  });

  it('records `closed` on a 404 — the listing is gone, not a transient failure', async () => {
    const api = apiFake(vi.fn().mockRejectedValue(new MercadoLivreHttpError('sumiu', 404, null)));
    const res = await definirStatusAnuncio(fakeDb([]), CONTA, alvo(), 'pausar', api, NOW);

    const [, , , itemGravado, opts] = h.applyItemStatusToLink.mock.calls[0]!;
    expect(itemGravado).toMatchObject({ status: 'closed' });
    expect(opts.extra).toMatchObject({ moderacoes: [] });
    expect(res).toMatchObject({ estado: 'c', status: 'closed', aplicados: 0, total: 1 });
  });

  it('THROWS on any other ML refusal, and records nothing', async () => {
    const api = apiFake(
      vi.fn().mockRejectedValue(new MercadoLivreHttpError('não pode', 400, null)),
    );
    await expect(
      definirStatusAnuncio(fakeDb([]), CONTA, alvo(), 'pausar', api, NOW),
    ).rejects.toBeInstanceOf(MercadoLivreHttpError);
    // Nothing was confirmed, so nothing may be written.
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
  });
});

/* --------------------------- a User-Products family ------------------------- */

describe('definirStatusAnuncio — User-Products family', () => {
  const MEMBROS: MembroSeed[] = [
    { itemId: 'MLB-A', child: 'childA' },
    { itemId: 'MLB-B', child: 'childB' },
  ];

  it('writes every MEMBER by its own id, never the family id', async () => {
    const api = apiFake();
    // The target carries the FAMILY key — the shape `PUT /items/{id}` 404s for.
    const res = await definirStatusAnuncio(
      fakeDb(MEMBROS),
      CONTA,
      alvo(FAMILY_ID),
      'pausar',
      api,
      NOW,
    );

    expect(api.updateItem).toHaveBeenCalledTimes(2);
    const ids = api.updateItem.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(['MLB-A', 'MLB-B']);
    expect(api.updateItem).not.toHaveBeenCalledWith(FAMILY_ID, expect.anything());
    // The parent takes the FOLD's answer, never one member's.
    expect(h.applyFamilyStatusAndFold).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ estado: 'pa', status: 'paused', aplicados: 2, total: 2 });
    expect(res.membros).toHaveLength(2);
  });

  it('leaves a REFUSED member unobserved and still records the others', async () => {
    const api = apiFake(
      vi.fn().mockImplementation((id: string) => {
        if (id === 'MLB-B') return Promise.reject(new MercadoLivreHttpError('nope', 400, null));
        return Promise.resolve(item({ id, status: 'paused' }));
      }),
    );
    const res = await definirStatusAnuncio(
      fakeDb(MEMBROS),
      CONTA,
      alvo(FAMILY_ID),
      'pausar',
      api,
      NOW,
    );

    // ⚠️ ONE observed member, not two: the refused one keeps its stored reading
    // rather than being assumed anything, so the fold can decline to conclude.
    const [, , , observados] = h.applyFamilyStatusAndFold.mock.calls[0]!;
    expect(observados).toHaveLength(1);
    expect(observados[0]).toMatchObject({ memberDocId: 'v-childA', status: 'paused' });

    expect(res.aplicados).toBe(1);
    expect(res.total).toBe(2);
    const falho = res.membros!.find((m) => m.itemId === 'MLB-B')!;
    expect(falho).toMatchObject({ aplicado: false, status: null });
    expect(falho.erro).toContain('nope');
  });

  it('forces the errors clear on the parent — our write landed (#781 inverted)', async () => {
    await definirStatusAnuncio(fakeDb(MEMBROS), CONTA, alvo(FAMILY_ID), 'pausar', apiFake(), NOW);
    const [, , , , opts] = h.applyFamilyStatusAndFold.mock.calls[0]!;
    // Without this the clear is gated on stock being able to flow again — which
    // after a deliberate pause it never can, so the stale diagnosis would
    // outlive the failure it describes.
    expect(opts).toMatchObject({ limparFalhaSempre: true });
  });

  it('takes the family path for a LEGACY-looking id when member links exist', async () => {
    // The parent link's `id` is `familyId ?? itemIds[0]`, so a family can be
    // addressed by member 0's own MLB id. Writing that id alone would pause ONE
    // listing and report the whole family paused (#1142).
    const api = apiFake();
    await definirStatusAnuncio(fakeDb(MEMBROS), CONTA, alvo('MLB-A'), 'pausar', api, NOW);
    expect(api.updateItem).toHaveBeenCalledTimes(2);
    expect(h.applyFamilyStatusAndFold).toHaveBeenCalledTimes(1);
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
  });

  it('ignores a LEGACY variation row — it has no itemId of its own', async () => {
    // Legacy `variations[]` members are rows inside one ML item, not listings;
    // `importCore` leaves their `itemId` null. Addressing them would ask ML
    // about ids that do not exist, so this must stay on the single-item path.
    const api = apiFake();
    await definirStatusAnuncio(
      fakeDb([{ itemId: null, child: 'childA' }]),
      CONTA,
      alvo(),
      'pausar',
      api,
      NOW,
    );
    expect(api.updateItem).toHaveBeenCalledTimes(1);
    expect(api.updateItem).toHaveBeenCalledWith(ITEM, { status: 'paused' });
  });

  it('REFUSES a family id with no member links, without touching ML', async () => {
    const api = apiFake();
    await expect(
      definirStatusAnuncio(fakeDb([]), CONTA, alvo(FAMILY_ID), 'pausar', api, NOW),
    ).rejects.toBeInstanceOf(AnuncioStatusFamiliaSemMembrosError);
    // The whole point: falling back to `PUT /items/{familyId}` would 404, and
    // the 404 arm records `closed` — dropping every live variation of the
    // produto out of both ML sweeps.
    expect(api.updateItem).not.toHaveBeenCalled();
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
  });
});
