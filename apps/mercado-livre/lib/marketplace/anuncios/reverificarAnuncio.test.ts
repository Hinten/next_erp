import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

const h = vi.hoisted(() => ({
  applyItemStatusToLink: vi.fn(),
  applyFamilyStatusAndFold: vi.fn(),
}));

// The fold itself is covered end-to-end against a real FakeDb in
// `itemsStatusSync.test.ts` and `upFamilyStatus.test.ts`. What THIS module owns
// is which ML calls it makes and what it hands the fold, so that is the seam.
vi.mock('./itemsStatusSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./itemsStatusSync')>();
  return {
    ...actual,
    applyItemStatusToLink: h.applyItemStatusToLink,
    applyFamilyStatusAndFold: h.applyFamilyStatusAndFold,
  };
});

type ReverificarApi = import('./reverificarAnuncio').ReverificarApi;

const { ReverificacaoFamiliaSemMembrosError, reverificarAnuncio } =
  await import('./reverificarAnuncio');

/* --------------------------------- fixtures -------------------------------- */

const CONTA = 'conta-A';
const PRODUTO = 'prod1';
const LINK = 'link1';
/** ML's own numeric family key — the shape `GET /items/{id}` answers 404 for. */
const FAMILY_ID = '6264141844942250';
const PML_REF = `documents/produtos/${PRODUTO}/produtoMercadoLivre/${LINK}`;

interface MembroSeed {
  itemId: string | null;
  child: string;
}

/**
 * Minimal fake Firestore: this module only reads the family-member group query.
 * `runTransaction` never runs here — the fold is mocked.
 */
function fakeDb(membros: MembroSeed[]): Firestore {
  return {
    collectionGroup: () => ({
      where: (_f: string, _op: string, _v: unknown) => ({
        get: async () => ({
          docs: membros.map((m) => ({
            id: `v-${m.child}`,
            data: () => ({
              itemId: m.itemId,
              produtoMercadoLivreOuterRef: PML_REF,
              produtoVariacaoOuterRef: `documents/produtos/${m.child}`,
            }),
            ref: { parent: { parent: { id: m.child } } },
          })),
        }),
      }),
    }),
  } as unknown as Firestore;
}

/** One multiget envelope entry, in ML's verbose shape. */
function entrada(code: number, body: Record<string, unknown> | null) {
  return { code, body };
}

/** The injected ML surface, typed as the real one but with the mocks reachable. */
type ApiFake = ReverificarApi & {
  getItem: ReturnType<typeof vi.fn>;
  getLastModeration: ReturnType<typeof vi.fn>;
  getItemsByIds: ReturnType<typeof vi.fn>;
};

function apiFake(
  over: {
    getItemsByIds?: ReturnType<typeof vi.fn>;
    getItem?: ReturnType<typeof vi.fn>;
    getLastModeration?: ReturnType<typeof vi.fn>;
  } = {},
): ApiFake {
  return {
    getItem: over.getItem ?? vi.fn(),
    // Default: no moderation. `consultarModeracoes` narrows a 404 to `[]`.
    getLastModeration:
      over.getLastModeration ??
      vi.fn().mockRejectedValue(new MercadoLivreHttpError('ML 404: not found', 404, null)),
    getItemsByIds: over.getItemsByIds ?? vi.fn().mockResolvedValue([]),
  } as unknown as ApiFake;
}

const target = { produtoId: PRODUTO, linkDocId: LINK, itemId: FAMILY_ID };

beforeEach(() => {
  vi.clearAllMocks();
  h.applyFamilyStatusAndFold.mockResolvedValue({
    outcome: 'synced-family',
    estado: 'p',
    status: 'active',
    subStatus: null,
  });
});

/* ---------------------------------- tests ---------------------------------- */

describe('reverificarAnuncio — a User-Products FAMILY (#1142)', () => {
  it('NEVER sends the family id to GET /items — it multigets the members', async () => {
    // The regression, and the reason this is a refusal rather than a fallback:
    // `GET /items/{numeric family id}` answers 404, the 404 branch records
    // `closed`, and `estado 'c'` drops the produto out of BOTH ML sweeps with
    // nothing logged.
    const db = fakeDb([
      { itemId: 'MLB-A', child: 'childA' },
      { itemId: 'MLB-B', child: 'childB' },
    ]);
    const api = apiFake({
      getItemsByIds: vi
        .fn()
        .mockResolvedValue([
          entrada(200, { id: 'MLB-A', status: 'active', sub_status: [] }),
          entrada(200, { id: 'MLB-B', status: 'paused', sub_status: ['out_of_stock'] }),
        ]),
    });

    const res = await reverificarAnuncio(db, CONTA, target, api, 1_000);

    expect(api.getItem).not.toHaveBeenCalled();
    expect(api.getItemsByIds).toHaveBeenCalledTimes(1);
    expect(api.getItemsByIds.mock.calls[0]![0]).toEqual(['MLB-A', 'MLB-B']);
    // And the parent's own status writeback is never reached with a family id.
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
    expect(res.membros).toHaveLength(2);
  });

  it("records each member's reading against its OWN link, and folds once", async () => {
    const db = fakeDb([
      { itemId: 'MLB-A', child: 'childA' },
      { itemId: 'MLB-B', child: 'childB' },
    ]);
    const api = apiFake({
      getItemsByIds: vi
        .fn()
        .mockResolvedValue([
          entrada(200, { id: 'MLB-A', status: 'active', sub_status: [] }),
          entrada(200, { id: 'MLB-B', status: 'paused', sub_status: ['out_of_stock'] }),
        ]),
    });

    await reverificarAnuncio(db, CONTA, target, api, 1_000);

    // ONE transaction for the whole family, never one per member: N folds would
    // read the siblings N times AND let a midway fold conclude against a
    // half-refreshed family.
    expect(h.applyFamilyStatusAndFold).toHaveBeenCalledTimes(1);
    const [, , alvo, observados] = h.applyFamilyStatusAndFold.mock.calls[0]!;
    expect(alvo).toEqual({ produtoId: PRODUTO, linkDocId: LINK, pmlOuterRef: PML_REF });
    expect(observados).toEqual([
      {
        memberProdutoId: 'childA',
        memberDocId: 'v-childA',
        status: 'active',
        subStatus: [],
        moderacoes: [],
        userProductId: null,
      },
      {
        memberProdutoId: 'childB',
        memberDocId: 'v-childB',
        status: 'paused',
        subStatus: ['out_of_stock'],
        moderacoes: [],
        userProductId: null,
      },
    ]);
  });

  it('reports the FOLD, never one member — the summary is all the parent can carry', async () => {
    const db = fakeDb([{ itemId: 'MLB-A', child: 'childA' }]);
    const api = apiFake({
      getItemsByIds: vi
        .fn()
        .mockResolvedValue([entrada(200, { id: 'MLB-A', status: 'closed', sub_status: [] })]),
    });
    // The fold declined to cancel — a sibling was never observed.
    h.applyFamilyStatusAndFold.mockResolvedValue({
      outcome: 'synced-member',
      estado: 'p',
      status: 'active',
      subStatus: null,
    });

    const res = await reverificarAnuncio(db, CONTA, target, api, 1_000);

    expect(res).toMatchObject({ estado: 'p', status: 'active', enviavel: true });
    // The member's own bad news still reaches the operator, at member level.
    expect(res.membros).toEqual([
      {
        itemId: 'MLB-A',
        memberDocId: 'v-childA',
        lido: true,
        status: 'closed',
        subStatus: [],
        enviavel: false,
      },
    ]);
  });

  it('a member ML answers 404 for is closed — ALONE, never the family', async () => {
    const db = fakeDb([
      { itemId: 'MLB-A', child: 'childA' },
      { itemId: 'MLB-B', child: 'childB' },
    ]);
    const api = apiFake({
      getItemsByIds: vi
        .fn()
        .mockResolvedValue([
          entrada(404, null),
          entrada(200, { id: 'MLB-B', status: 'active', sub_status: [] }),
        ]),
    });

    await reverificarAnuncio(db, CONTA, target, api, 1_000);

    const [, , , observados] = h.applyFamilyStatusAndFold.mock.calls[0]!;
    // Positional attribution: ML sends one entry per requested id and the lengths
    // match, so the body-less 404 is still placed on the member it answers for.
    expect(observados).toMatchObject([
      { memberDocId: 'v-childA', status: 'closed', subStatus: [] },
      { memberDocId: 'v-childB', status: 'active' },
    ]);
  });

  it('⚠️ a member ML could NOT read is left unobserved, never assumed closed', async () => {
    // A 403/5xx arrives INSIDE a 200 with a hollow body. Manufacturing `closed`
    // here would invent the one reading that can cancel a family.
    const db = fakeDb([
      { itemId: 'MLB-A', child: 'childA' },
      { itemId: 'MLB-B', child: 'childB' },
    ]);
    const api = apiFake({
      getItemsByIds: vi
        .fn()
        .mockResolvedValue([
          entrada(500, null),
          entrada(200, { id: 'MLB-B', status: 'active', sub_status: [] }),
        ]),
    });

    const res = await reverificarAnuncio(db, CONTA, target, api, 1_000);

    const [, , , observados] = h.applyFamilyStatusAndFold.mock.calls[0]!;
    expect(observados).toHaveLength(1);
    expect(observados[0]).toMatchObject({ memberDocId: 'v-childB' });
    expect(res.membros).toMatchObject([
      { itemId: 'MLB-A', lido: false, status: null },
      { itemId: 'MLB-B', lido: true, status: 'active' },
    ]);
  });

  it('⚠️ CHUNKS at 20 — ML truncates an over-long multiget instead of refusing it', async () => {
    // Unchunked, members past the 20th are silently never read, which the fold
    // then treats as never observed for the life of the listing.
    const membros = Array.from({ length: 21 }, (_, i) => ({
      itemId: `MLB-${String(i)}`,
      child: `child${String(i)}`,
    }));
    const getItemsByIds = vi
      .fn()
      .mockImplementation(async (ids: string[]) =>
        ids.map((id) => entrada(200, { id, status: 'active', sub_status: [] })),
      );
    const api = apiFake({ getItemsByIds });

    const res = await reverificarAnuncio(fakeDb(membros), CONTA, target, api, 1_000);

    expect(getItemsByIds).toHaveBeenCalledTimes(2);
    expect(getItemsByIds.mock.calls[0]![0]).toHaveLength(20);
    expect(getItemsByIds.mock.calls[1]![0]).toHaveLength(1);
    expect(res.membros?.every((m) => m.lido)).toBe(true);
  });

  it('asks /moderations only for a member whose status says one exists', async () => {
    const db = fakeDb([
      { itemId: 'MLB-A', child: 'childA' },
      { itemId: 'MLB-B', child: 'childB' },
    ]);
    const getLastModeration = vi.fn().mockResolvedValue([]);
    const api = apiFake({
      getLastModeration,
      getItemsByIds: vi
        .fn()
        .mockResolvedValue([
          entrada(200, { id: 'MLB-A', status: 'active', sub_status: [] }),
          entrada(200, { id: 'MLB-B', status: 'paused', sub_status: ['poor_quality_thumbnail'] }),
        ]),
    });

    await reverificarAnuncio(db, CONTA, target, api, 1_000);

    // The gate is a pure predicate over the status already in hand, so a healthy
    // family pays nothing for it.
    expect(getLastModeration).toHaveBeenCalledTimes(1);
    expect(getLastModeration).toHaveBeenCalledWith('MLB-B-ITM');
  });

  it('a LEGACY variations[] listing is not a family — its members carry no itemId', async () => {
    // Legacy variations are rows inside ONE ML item, not listings of their own.
    // Re-reading them as items would ask ML about ids that do not exist.
    const db = fakeDb([{ itemId: null, child: 'childA' }]);
    const getItem = vi.fn().mockResolvedValue({ id: 'MLB123', status: 'active', sub_status: [] });
    const api = apiFake({ getItem });

    const res = await reverificarAnuncio(
      db,
      CONTA,
      { produtoId: PRODUTO, linkDocId: LINK, itemId: 'MLB123' },
      api,
      1_000,
    );

    expect(getItem).toHaveBeenCalledWith('MLB123');
    expect(h.applyFamilyStatusAndFold).not.toHaveBeenCalled();
    expect(res.membros).toBeUndefined();
  });

  it('a family id with NO member links refuses loudly instead of guessing', async () => {
    // `GET /items/{family id}` would 404 and the 404 branch records `closed`.
    // Refusing keeps a live family out of `estado 'c'`.
    const api = apiFake();

    await expect(reverificarAnuncio(fakeDb([]), CONTA, target, api, 1_000)).rejects.toBeInstanceOf(
      ReverificacaoFamiliaSemMembrosError,
    );
    expect(api.getItem).not.toHaveBeenCalled();
    expect(api.getItemsByIds).not.toHaveBeenCalled();
    expect(h.applyItemStatusToLink).not.toHaveBeenCalled();
  });
});
