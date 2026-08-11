import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ESTADO_PUBLICACAO_ML, produtoMercadoLivreLinkSchema } from '@delfrance/schemas';
import type { Firestore } from 'firebase/firestore';

const h = vi.hoisted(() => ({
  exists: false,
  sets: [] as unknown[],
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    runTransaction: async <T>(_db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        get: async () => ({ exists: () => h.exists }),
        set: (_ref: unknown, data: unknown) => {
          h.sets.push(data);
        },
      }),
  };
});

vi.mock('@/lib/data/produtoMercadoLivreLinkCollection', () => ({
  produtoMercadoLivreLinkCollection: { docRef: () => ({ id: 'ref' }) },
}));

const { buildListingDraft, createListingDraft, draftDocId } = await import('./listingDraft');

const ARGS = {
  integracaoId: 'conta-1',
  produtoNome: '  Camiseta Básica  ',
  listingTypeId: 'gold_special',
  nowMs: 1_800_000_000_000,
};

beforeEach(() => {
  h.exists = false;
  h.sets = [];
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
  it('is the integração id, so a double click cannot make two listings', () => {
    // Tier 0: the race is impossible rather than detected. An auto-id would let
    // two clicks (or two tabs) create two drafts for the same account.
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
});
