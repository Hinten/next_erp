import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ESTADO_PUBLICACAO_ML, produtoMercadoLivreLinkSchema } from '@delfrance/schemas';
import type { Firestore } from 'firebase/firestore';

const h = vi.hoisted(() => ({
  exists: false,
  /** What the transactional read finds, for the remove path. */
  stored: null as Record<string, unknown> | null,
  deletes: [] as unknown[],
  sets: [] as unknown[],
  updates: [] as Array<{ ref: unknown; data: Record<string, unknown> }>,
  /** Every `addDoc` — the `'adicional'` path, which runs no transaction. */
  adds: [] as unknown[],
  transactions: 0,
  /** The `variacaoMercadoLivre` member refs the group query finds. */
  membros: [] as unknown[],
  /** How many times the member query ran — it must be OUTSIDE the transaction. */
  groupQueries: 0,
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
        update: (ref: unknown, data: Record<string, unknown>) => {
          h.updates.push({ ref, data });
        },
      });
    },
    addDoc: async (_ref: unknown, data: unknown) => {
      h.adds.push(data);
      return { id: `auto-${h.adds.length}` };
    },
    getDocs: async () => {
      h.groupQueries += 1;
      return { docs: h.membros.map((ref) => ({ ref })) };
    },
  };
});

// The member lookup is a collection-group query, and `groupQuery` reaches the
// real `collectionGroup`, which rejects the `{}` stand-in this suite passes for
// `db`. Only the three helpers `listingDraft` actually uses are stubbed; what
// they build is irrelevant here, since `getDocs` is stubbed too.
vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown, parts: unknown[]) => ({ __built: [base, parts] }),
  groupQuery: () => ({ __group: true }),
  whereEqual: (...parts: unknown[]) => ({ __where: parts }),
}));

vi.mock('@/lib/data/variacaoMercadoLivreLinkCollection', () => ({
  variacaoMercadoLivreLinkCollection: { converter: {} },
}));

vi.mock('@/lib/data/produtoMercadoLivreLinkCollection', () => ({
  produtoMercadoLivreLinkCollection: {
    docRef: () => ({ id: 'ref' }),
    ref: () => ({ id: 'col' }),
  },
}));

const {
  buildListingDraft,
  createListingDraft,
  descartarAnuncioRemovido,
  draftDocId,
  removeListing,
} = await import('./listingDraft');

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
  h.updates = [];
  h.adds = [];
  h.transactions = 0;
  h.membros = [];
  h.groupQueries = 0;
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

describe('removeListing', () => {
  it('deletes a listing that never reached Mercado Livre', async () => {
    h.exists = true;
    h.stored = { id: null, estado: ESTADO_PUBLICACAO_ML.rascunho };

    expect(await removeListing({} as Firestore, 'prod-1', 'L-1')).toBe('removed');
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

    expect(await removeListing({} as Firestore, 'prod-1', 'L-1')).toBe('published');
    expect(h.deletes).toHaveLength(0);
  });

  it('decides on the TRANSACTIONAL read, not on what the caller was holding', async () => {
    // The caller passes only an id, so there is no stale snapshot to be tempted
    // by — and that is the point. Re-checking a predicate against a binding read
    // outside the transaction is not a guard (root CLAUDE.md rule 7).
    h.exists = true;
    h.stored = { id: 'MLB777' };

    await removeListing({} as Firestore, 'prod-1', 'L-1');

    expect(h.transactions).toBe(1);
    expect(h.deletes).toHaveLength(0);
  });

  it('treats an empty id as never published, like the backend does', async () => {
    // `bulkEstoquePlan` takes `link.id !== ''` as its test; the schema permits
    // `''` and the migrated corpus contains it, so a `!= null` check here would
    // leave those drafts undeletable.
    h.exists = true;
    h.stored = { id: '' };

    expect(await removeListing({} as Firestore, 'prod-1', 'L-1')).toBe('removed');
    expect(h.deletes).toHaveLength(1);
  });

  it('reports a listing that is already gone rather than failing', async () => {
    h.exists = false;

    expect(await removeListing({} as Firestore, 'prod-1', 'L-1')).toBe('missing');
    expect(h.deletes).toHaveLength(0);
  });

  /**
   * #1226. The published refusal above rests entirely on "deleting would orphan
   * a LIVE anúncio". ML removed this one, so there is nothing live to orphan —
   * and the produto is otherwise stuck with a dead item id for ever.
   */
  it('deletes a listing Mercado Livre REMOVED, despite its item id', async () => {
    h.exists = true;
    h.stored = { id: 'MLB777', estado: ESTADO_PUBLICACAO_ML.removidoPorModeracao };

    expect(await removeListing({} as Firestore, 'prod-1', 'L-1')).toBe('removed');
    expect(h.deletes).toHaveLength(1);
  });

  /**
   * ⚠️ The near-miss that keeps the rung honest: `removidoPorModeracao` is the
   * ONLY published estado that may be deleted. A cancelled listing still exists
   * on ML — closed, but resolvable — and an `'E'` one is live and merely latched.
   */
  it('still refuses every OTHER published estado', async () => {
    for (const estado of [
      ESTADO_PUBLICACAO_ML.cancelado,
      ESTADO_PUBLICACAO_ML.erro,
      ESTADO_PUBLICACAO_ML.pausado,
      ESTADO_PUBLICACAO_ML.emRevisao,
    ]) {
      h.exists = true;
      h.stored = { id: 'MLB777', estado };
      expect(await removeListing({} as Firestore, 'prod-1', 'L-1')).toBe('published');
    }
    expect(h.deletes).toHaveLength(0);
  });

  it('takes the member links with it, so none is left pointing at nothing', async () => {
    h.exists = true;
    h.stored = { id: 'MLB777', estado: ESTADO_PUBLICACAO_ML.removidoPorModeracao };
    h.membros = [{ id: 'M-1' }, { id: 'M-2' }];

    expect(await removeListing({} as Firestore, 'prod-1', 'L-1')).toBe('removed');
    // Two members plus the parent.
    expect(h.deletes).toHaveLength(3);
  });

  it('does not delete the members when the parent write is refused', async () => {
    // The guard runs first, inside the transaction, so a refusal costs nothing.
    h.exists = true;
    h.stored = { id: 'MLB777', estado: ESTADO_PUBLICACAO_ML.publicado };
    h.membros = [{ id: 'M-1' }];

    expect(await removeListing({} as Firestore, 'prod-1', 'L-1')).toBe('published');
    expect(h.deletes).toHaveLength(0);
  });
});

/* --------------------- descartarAnuncioRemovido (#1226) -------------------- */

describe('descartarAnuncioRemovido', () => {
  const REMOVIDO = {
    id: 'MLB777',
    estado: ESTADO_PUBLICACAO_ML.removidoPorModeracao,
  };

  it('clears the dead ML identity and returns the listing to rascunho', async () => {
    h.exists = true;
    h.stored = REMOVIDO;

    expect(await descartarAnuncioRemovido({} as Firestore, 'prod-1', 'L-1')).toBe('descartado');
    const patch = h.updates[0]!.data;
    // `id: null` is the whole point — it is what makes `assemblePublishInput`
    // take the POST branch instead of PUTing an item ML deleted.
    expect(patch.id).toBeNull();
    expect(patch.estado).toBe(ESTADO_PUBLICACAO_ML.rascunho);
    expect(patch.status).toBeNull();
    expect(patch.sub_status).toBeNull();
    expect(patch.userProductId).toBeNull();
    // NULL, not `[]`: the new listing has not been moderated, and `[]` would
    // record a verdict nobody obtained.
    expect(patch.moderacoes).toBeNull();
    expect(patch.errors).toEqual([]);
    expect(patch.causas).toEqual([]);
  });

  /**
   * ⚠️ This is the entire difference from {@link removeListing}, and the reason
   * the action exists: a removal is usually one wrong field (the case that
   * motivated the issue is a wrong category), while the listing's copy is hours
   * of work. A patch that cleared any of these would make the two actions the
   * same one with extra steps.
   */
  it('keeps everything the operator authored', async () => {
    h.exists = true;
    h.stored = REMOVIDO;

    await descartarAnuncioRemovido({} as Firestore, 'prod-1', 'L-1');

    const patch = h.updates[0]!.data;
    for (const campo of [
      'title',
      'category_id',
      'attributes',
      'descricao',
      'listing_type_id',
      'condition',
      'video_id',
    ]) {
      expect(patch).not.toHaveProperty(campo);
    }
    expect(h.deletes).toHaveLength(0);
  });

  it('refuses a listing that is not in the removed state', async () => {
    // The same race the delete guards, from the other side: discarding the
    // identity of a listing that is merely paused abandons a LIVE anúncio.
    for (const estado of [
      ESTADO_PUBLICACAO_ML.publicado,
      ESTADO_PUBLICACAO_ML.pausado,
      ESTADO_PUBLICACAO_ML.cancelado,
      ESTADO_PUBLICACAO_ML.rascunho,
    ]) {
      h.exists = true;
      h.stored = { id: 'MLB777', estado };
      expect(await descartarAnuncioRemovido({} as Firestore, 'prod-1', 'L-1')).toBe('nao-removido');
    }
    expect(h.updates).toHaveLength(0);
  });

  it('decides on the TRANSACTIONAL read, not on what the caller was holding', async () => {
    h.exists = true;
    h.stored = { id: 'MLB777', estado: ESTADO_PUBLICACAO_ML.publicado };

    await descartarAnuncioRemovido({} as Firestore, 'prod-1', 'L-1');

    expect(h.transactions).toBe(1);
    expect(h.updates).toHaveLength(0);
  });

  /**
   * ⚠️ MARKED, never deleted — `variacoesFantasma.ts`'s precedent. The member
   * link carries the variation's `sku` and `attribute_combinations`, which a
   * republish would otherwise have to rebuild from nothing.
   */
  it('strips each member of its ML identity and keeps the rest', async () => {
    h.exists = true;
    h.stored = REMOVIDO;
    h.membros = [{ id: 'M-1' }, { id: 'M-2' }];

    await descartarAnuncioRemovido({} as Firestore, 'prod-1', 'L-1');

    expect(h.deletes).toHaveLength(0);
    // Two members plus the parent.
    expect(h.updates).toHaveLength(3);
    const membro = h.updates[0]!.data;
    expect(membro.itemId).toBeNull();
    expect(membro.status).toBeNull();
    expect(membro.moderacoes).toBeNull();
    expect(membro).not.toHaveProperty('sku');
    expect(membro).not.toHaveProperty('attribute_combinations');
  });

  /**
   * The Web SDK's `runTransaction` takes document reads only, so the member
   * query cannot go inside one. Pinning it here records that as a decision
   * rather than an oversight — the window it opens is the same one
   * `removeListing` has always accepted.
   */
  it('reads the members OUTSIDE the transaction, exactly once', async () => {
    h.exists = true;
    h.stored = REMOVIDO;

    await descartarAnuncioRemovido({} as Firestore, 'prod-1', 'L-1');

    expect(h.groupQueries).toBe(1);
    expect(h.transactions).toBe(1);
  });

  it('reports a listing that is already gone rather than failing', async () => {
    h.exists = false;

    expect(await descartarAnuncioRemovido({} as Firestore, 'prod-1', 'L-1')).toBe('missing');
    expect(h.updates).toHaveLength(0);
  });
});
