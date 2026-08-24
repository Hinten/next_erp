import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ESTADO_PUBLICACAO_ML, produtoMercadoLivreLinkSchema } from '@delfrance/schemas';
import type { Firestore } from 'firebase/firestore';

const h = vi.hoisted(() => ({
  exists: false,
  /** What the transactional read finds, for the remove path. */
  stored: null as Record<string, unknown> | null,
  deletes: [] as unknown[],
  sets: [] as unknown[],
  /** Every `addDoc` — the `'adicional'` path, which runs no transaction. */
  adds: [] as unknown[],
  transactions: 0,
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    runTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      h.transactions += 1;
      return fn({
        get: async () => ({ exists: () => h.exists, data: () => h.stored ?? undefined }),
        set: (_ref: unknown, data: unknown) => {
          h.sets.push(data);
        },
        delete: (ref: unknown) => {
          h.deletes.push(ref);
        },
      });
    },
    addDoc: async (_ref: unknown, data: unknown) => {
      h.adds.push(data);
      return { id: `auto-${h.adds.length}` };
    },
  };
});

vi.mock('@/lib/data/produtoMercadoLivreLinkCollection', () => ({
  produtoMercadoLivreLinkCollection: {
    docRef: () => ({ id: 'ref' }),
    ref: () => ({ id: 'col' }),
  },
}));

const { buildListingDraft, createListingDraft, draftDocId, removeListingDraft } =
  await import('./listingDraft');

const ARGS = {
  integracaoId: 'conta-1',
  produtoNome: '  Camiseta Básica  ',
  listingTypeId: 'gold_special',
  nowMs: 1_800_000_000_000,
  modo: 'primeiro' as const,
};

beforeEach(() => {
  h.exists = false;
  h.stored = null;
  h.deletes = [];
  h.sets = [];
  h.adds = [];
  h.transactions = 0;
});

describe('buildListingDraft', () => {
  it('produces a document the stored schema accepts', () => {
    // The strongest single assertion here: `title` is `.min(1)` on the write
    // side, so a draft built from a produto whose nome had not loaded yet would
    // throw at the converter rather than save something blank.
    const parsed = produtoMercadoLivreLinkSchema.safeParse(buildListingDraft(ARGS));
    expect(parsed.success).toBe(true);
  });

  it('is a rascunho that has never reached ML', () => {
    const draft = buildListingDraft(ARGS);
    expect(draft.estado).toBe(ESTADO_PUBLICACAO_ML.rascunho);
    expect(draft.id).toBeNull();
    expect(draft.category_id).toBeNull();
    expect(draft.precoPublicado).toBeNull();
  });

  it('matches the shape publish would have created', () => {
    // `writeLinkDoc` on a first publish writes exactly this `contaOuterRef`
    // form and this title fallback; a draft made here must be indistinguishable
    // from one made there.
    const draft = buildListingDraft(ARGS);
    expect(draft.contaOuterRef).toBe('documents/integracao/conta-1');
    expect(draft.title).toBe('Camiseta Básica');
    expect(draft.dataCadastro).toBe(ARGS.nowMs);
    expect(draft.channels).toEqual(['marketplace']);
    expect(draft.condition).toBe('new');
    expect(draft.site_id).toBe('MLB');
  });

  it('carries the listing type the operator chose', () => {
    expect(buildListingDraft(ARGS).listing_type_id).toBe('gold_special');
    expect(buildListingDraft({ ...ARGS, listingTypeId: null }).listing_type_id).toBeNull();
  });
});

describe('draftDocId', () => {
  it('is the integração id, so a double click cannot make two FIRST listings', () => {
    // Tier 0: the race is impossible rather than detected. An auto-id would let
    // two clicks (or two tabs) create two drafts for an account that had none.
    // It applies to the first draft only — see the `'adicional'` cases below.
    expect(draftDocId('conta-1')).toBe('conta-1');
  });
});

describe('createListingDraft', () => {
  it('writes the draft when the account has none', async () => {
    const result = await createListingDraft({} as Firestore, 'prod-1', ARGS);
    expect(result).toEqual({ docId: 'conta-1', outcome: 'created' });
    expect(h.sets).toHaveLength(1);
  });

  it('never overwrites an existing listing', async () => {
    // The read and the write share a transaction, so "check then create" cannot
    // interleave with another tab doing the same thing.
    h.exists = true;
    const result = await createListingDraft({} as Firestore, 'prod-1', ARGS);
    expect(result.outcome).toBe('exists');
    expect(h.sets).toHaveLength(0);
  });

  it("mints a fresh id for an 'adicional' draft", async () => {
    // A produto can carry several anúncios on one account. The deterministic id
    // is taken by the first, and "another one" has no deterministic name — so
    // the second and beyond get auto-ids, exactly like the docs Flutter and a
    // first publish write.
    const result = await createListingDraft({} as Firestore, 'prod-1', {
      ...ARGS,
      modo: 'adicional',
    });

    expect(result).toEqual({ docId: 'auto-1', outcome: 'created' });
    expect(h.adds).toHaveLength(1);
  });

  it("runs no transaction for an 'adicional' draft", async () => {
    // Nothing to guard: a fresh auto-id cannot collide, and a second draft is
    // what was asked for — so a check-then-create would be protecting against
    // the outcome the operator requested.
    await createListingDraft({} as Firestore, 'prod-1', { ...ARGS, modo: 'adicional' });

    expect(h.transactions).toBe(0);
    expect(h.sets).toHaveLength(0);
  });

  it('writes the same document shape either way', async () => {
    // Downstream reads no meaning into a link doc's id, so a draft's mode must
    // not be visible in what it stores.
    await createListingDraft({} as Firestore, 'prod-1', ARGS);
    await createListingDraft({} as Firestore, 'prod-1', { ...ARGS, modo: 'adicional' });

    expect(h.adds[0]).toEqual(h.sets[0]);
  });

  it("still runs the guarded path for 'primeiro'", async () => {
    await createListingDraft({} as Firestore, 'prod-1', ARGS);
    expect(h.transactions).toBe(1);
    expect(h.adds).toHaveLength(0);
  });
});

describe('removeListingDraft', () => {
  it('deletes a listing that never reached Mercado Livre', async () => {
    h.exists = true;
    h.stored = { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho };

    expect(await removeListingDraft({} as Firestore, 'prod-1', 'L-1')).toBe('removed');
    expect(h.deletes).toHaveLength(1);
  });

  it('refuses a listing that has been published', async () => {
    // The race the transaction exists for: a publish (or the `items` webhook)
    // stamps `id` on this doc between the confirm opening and the confirm being
    // clicked. Deleting then orphans a LIVE anúncio — the status sync stops
    // resolving it, both sweeps stop reaching it, and its child
    // `variacaoMercadoLivre` docs dangle.
    h.exists = true;
    h.stored = { id: 'MLB777', estado: ESTADO_PUBLICACAO_ML.publicado };

    expect(await removeListingDraft({} as Firestore, 'prod-1', 'L-1')).toBe('published');
    expect(h.deletes).toHaveLength(0);
  });

  it('decides on the TRANSACTIONAL read, not on what the caller was holding', async () => {
    // The caller passes only an id, so there is no stale snapshot to be tempted
    // by — and that is the point. Re-checking a predicate against a binding read
    // outside the transaction is not a guard (root CLAUDE.md rule 7).
    h.exists = true;
    h.stored = { id: 'MLB777' };

    await removeListingDraft({} as Firestore, 'prod-1', 'L-1');

    expect(h.transactions).toBe(1);
    expect(h.deletes).toHaveLength(0);
  });

  it('treats an empty id as never published, like the backend does', async () => {
    // `bulkEstoquePlan` takes `link.id !== ''` as its test; the schema permits
    // `''` and the migrated corpus contains it, so a `!= null` check here would
    // leave those drafts undeletable.
    h.exists = true;
    h.stored = { id: '' };

    expect(await removeListingDraft({} as Firestore, 'prod-1', 'L-1')).toBe('removed');
    expect(h.deletes).toHaveLength(1);
  });

  it('reports a listing that is already gone rather than failing', async () => {
    h.exists = false;

    expect(await removeListingDraft({} as Firestore, 'prod-1', 'L-1')).toBe('missing');
    expect(h.deletes).toHaveLength(0);
  });
});
