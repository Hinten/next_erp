import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ESTADO_PUBLICACAO_ML, produtoMercadoLivreLinkSchema } from '@delfrance/schemas';
import type { Firestore } from 'firebase/firestore';

const h = vi.hoisted(() => ({
  exists: false,
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
        get: async () => ({ exists: () => h.exists }),
        set: (_ref: unknown, data: unknown) => {
          h.sets.push(data);
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

const { buildListingDraft, createListingDraft, draftDocId } = await import('./listingDraft');

const ARGS = {
  integracaoId: 'conta-1',
  produtoNome: '  Camiseta Básica  ',
  listingTypeId: 'gold_special',
  nowMs: 1_800_000_000_000,
  modo: 'primeiro' as const,
};

beforeEach(() => {
  h.exists = false;
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
