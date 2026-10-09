import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
} from '@delfrance/integrations-mercado-livre';

// The aviso WRITE is `avisoCategoria.ts`'s, pinned in its own test; here the seam
// is what this module decides to write. The key and the motivos stay REAL — a
// resolver that derived its own key is exactly the bug worth catching.
const aviso = vi.hoisted(() => ({
  avisar: vi.fn(async () => ({ chave: 'k', resultado: 'criado' })),
  resolver: vi.fn(async () => true),
  registrar: vi.fn(async () => false),
}));
vi.mock('./avisoCategoria', async (importOriginal) => {
  const real = await importOriginal<typeof import('./avisoCategoria')>();
  return {
    ...real,
    avisarCategoriaAlterada: aviso.avisar,
    resolverAvisoCategoria: aviso.resolver,
    registrarMesmaComissao: aviso.registrar,
  };
});
// The module-level metadata cache would leak categories between tests.
vi.mock('../categorias/mlMetadataCache', () => ({
  getCategoriaCached: (api: { getCategory(id: string): Promise<unknown> }, id: string) =>
    api.getCategory(id),
}));

const {
  aplicarPlanoCategoriaDoLink,
  categoriaErpIdDe,
  comissoesIguais,
  decidirAvisoCategoria,
  percentualDaComissao,
  planCategoriaDoLink,
  planCategoriaDoProduto,
  resolverAvisosDoProduto,
} = await import('./categoriaAnuncio');
const { MOTIVO_RESOLUCAO_CATEGORIA, chaveAnuncioCategoriaAlterada } =
  await import('./avisoCategoria');
type CategoriaAnuncioApi = import('./categoriaAnuncio').CategoriaAnuncioApi;

/* ------------------------------ fake Firestore ---------------------------- */

type Dados = Record<string, unknown>;

/** Doc get/create plus a flat collection get — all `defineAdminCollection` uses here. */
class FakeDb {
  readonly docs = new Map<string, Dados>();
  readonly lidos: string[] = [];
  readonly criados: string[] = [];
  /** Fault injection: the next doc read throws this (a Firestore outage). */
  falhaNaLeitura: Error | null = null;

  seed(path: string, dados: Dados): void {
    this.docs.set(path, dados);
  }

  collection(col: string) {
    return {
      doc: (id: string) => ({
        id,
        get: async () => {
          if (this.falhaNaLeitura) throw this.falhaNaLeitura;
          this.lidos.push(`${col}/${id}`);
          const dados = this.docs.get(`${col}/${id}`);
          return { exists: dados != null, id, data: () => dados };
        },
        create: async (dados: Dados) => {
          if (this.docs.has(`${col}/${id}`)) {
            throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
          }
          this.docs.set(`${col}/${id}`, dados);
          this.criados.push(`${col}/${id}`);
        },
      }),
      get: async () => ({
        docs: [...this.docs]
          .filter(
            ([path]) => path.startsWith(`${col}/`) && !path.slice(col.length + 1).includes('/'),
          )
          .map(([path, dados]) => ({ id: path.slice(col.length + 1), data: () => dados })),
      }),
    };
  }
}
const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'conta-A';
const PRODUTO = 'prod-1';
const LINK = 'link-1';
const LINK_PATH = `produtos/${PRODUTO}/produtoMercadoLivre`;
const ALVO = { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: LINK };

/** A published listing — the shape a recategorization can happen to. */
const linkVivo = (over: Dados = {}): Dados => ({
  contaOuterRef: `documents/integracao/${CONTA}`,
  id: 'MLB777',
  estado: 'p',
  title: 'Camiseta',
  category_id: 'MLB1',
  listing_type_id: 'gold_special',
  precoPublicado: 79.9,
  ...over,
});

const PLANO = {
  tipo: 'categoria' as const,
  integracaoId: CONTA,
  anuncio: 'MLB777',
  anterior: 'MLB1',
  nova: 'MLB2',
};

const CATEGORIA_NOVA = {
  id: 'MLB2',
  name: 'Camisetas e Regatas',
  path_from_root: [
    { id: 'MLB1430', name: 'Roupas' },
    { id: 'MLB2', name: 'Camisetas e Regatas' },
  ],
};

/** The injected ML surface, typed as the real one but with the mocks reachable. */
type ApiFake = CategoriaAnuncioApi & {
  getCategory: ReturnType<typeof vi.fn>;
  getListingPrices: ReturnType<typeof vi.fn>;
};

function apiFake(
  pct: Partial<Record<string, number>> = { MLB1: 16, MLB2: 11.5 },
  over: Partial<Record<'getCategory' | 'getListingPrices', ReturnType<typeof vi.fn>>> = {},
): ApiFake {
  return {
    getCategory: over.getCategory ?? vi.fn(async () => CATEGORIA_NOVA),
    getListingPrices:
      over.getListingPrices ??
      vi.fn(async (input: { categoryId: string }) => ({
        sale_fee_amount: 10,
        sale_fee_details: { percentage_fee: pct[input.categoryId] ?? null },
      })),
  } as unknown as ApiFake;
}

function deps(api: ApiFake | Error = apiFake()) {
  return {
    increment: (by: number) => ({ __increment: by }),
    nowMs: 1_760_000_000_000,
    resolverApi: vi.fn(async (): Promise<CategoriaAnuncioApi> => {
      if (api instanceof Error) throw api;
      return api;
    }),
  };
}

/** The stored world for the `categoria` arm: link now in MLB2, produto still in MLB1. */
function seedMundo(
  db: FakeDb,
  { link = {}, produto = {} }: { link?: Dados; produto?: Dados } = {},
): void {
  db.seed(`${LINK_PATH}/${LINK}`, linkVivo({ category_id: 'MLB2', ...link }));
  db.seed(`produtos/${PRODUTO}`, {
    nome: 'Camiseta',
    categoriaProdutoOuterRef: 'documents/categorias/MLB1',
    ...produto,
  });
  db.seed('categorias/MLB1', { nome: 'Camisetas', nomeCompleto: 'Roupas > Camisetas' });
}

const avisoAbertoEm = (db: FakeDb) =>
  db.seed(`avisos/${chaveAnuncioCategoriaAlterada(ALVO)}`, { resolvidoEm: null });

/** A row CLOSED with `motivo`, which tracked the ERP category `erp`. */
const avisoFechadoEm = (db: FakeDb, motivo: string, erp = 'MLB1') =>
  db.seed(`avisos/${chaveAnuncioCategoriaAlterada(ALVO)}`, {
    resolvidoEm: 1_700_000_000_000_000,
    resolucaoMotivo: motivo,
    params: { anuncio: 'MLB777', categoriaErpId: erp, categoriaMlId: 'MLB2' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/* ------------------------------ pure decisions ---------------------------- */

describe('categoriaErpIdDe — the sameness fold, scoped both ways', () => {
  it('must come out EQUAL: every stored form of one ref', () => {
    expect(categoriaErpIdDe('documents/categorias/MLB1')).toBe('MLB1');
    expect(categoriaErpIdDe('categorias/MLB1')).toBe('MLB1');
    expect(categoriaErpIdDe('/categorias/MLB1/')).toBe('MLB1');
  });

  it('must stay DISTINCT: a prefix, a case fold, another collection, a nested path', () => {
    expect(categoriaErpIdDe('categorias/MLB12')).toBe('MLB12');
    expect(categoriaErpIdDe('categorias/mlb1')).toBe('mlb1');
    expect(categoriaErpIdDe('documents/outra/MLB1')).toBeNull();
    expect(categoriaErpIdDe('produtos/p1/categorias/MLB1')).toBeNull();
  });

  it('anything that is not a ref names no category', () => {
    expect(categoriaErpIdDe(null)).toBeNull();
    expect(categoriaErpIdDe(42)).toBeNull();
    expect(categoriaErpIdDe('categorias')).toBeNull();
  });
});

describe('planCategoriaDoLink — classifies from the payload alone', () => {
  it('a live listing ML moved → `categoria`, with both categories', () => {
    expect(planCategoriaDoLink(linkVivo(), linkVivo({ category_id: 'MLB2' }))).toEqual(PLANO);
  });

  it.each([
    ['a routine writeback (no category change)', linkVivo(), linkVivo({ errors: ['429'] })],
    [
      'the first publish (id null → set)',
      linkVivo({ id: null }),
      linkVivo({ category_id: 'MLB2' }),
    ],
    ['a UPtin re-key (id changes)', linkVivo(), linkVivo({ id: 'MLB888', category_id: 'MLB2' })],
    ['a null → X fill', linkVivo({ category_id: null }), linkVivo({ category_id: 'MLB2' })],
    [
      'a draft re-categorized by the operator',
      linkVivo({ id: null }),
      linkVivo({ id: null, category_id: 'MLB2' }),
    ],
    [
      'a listing that is not live',
      linkVivo({ estado: 'c' }),
      linkVivo({ estado: 'c', category_id: 'MLB2' }),
    ],
    [
      'a conta ref that resolves to no integração',
      linkVivo({ contaOuterRef: 'documents/produtos/x' }),
      linkVivo({ contaOuterRef: 'documents/produtos/x', category_id: 'MLB2' }),
    ],
    ['a create', null, linkVivo()],
  ])('nothing — %s', (_caso, before, after) => {
    expect(planCategoriaDoLink(before, after)).toBeNull();
  });

  it('the listing stopped being live → `fim` as `anuncio-encerrado`', () => {
    expect(planCategoriaDoLink(linkVivo(), linkVivo({ estado: 'c' }))).toEqual({
      tipo: 'fim',
      integracaoId: CONTA,
      motivo: MOTIVO_RESOLUCAO_CATEGORIA.encerrado,
    });
  });

  it('the link was deleted → `fim` as `anuncio-desvinculado`', () => {
    expect(planCategoriaDoLink(linkVivo(), null)).toEqual({
      tipo: 'fim',
      integracaoId: CONTA,
      motivo: MOTIVO_RESOLUCAO_CATEGORIA.desvinculado,
    });
  });

  it('a listing that was never live closes nothing when it goes', () => {
    expect(planCategoriaDoLink(linkVivo({ id: null }), null)).toBeNull();
  });
});

describe('decidirAvisoCategoria — the rule table, row by row', () => {
  const base = {
    anterior: 'MLB1',
    nova: 'MLB2',
    mlAtual: 'MLB2',
    erpId: 'MLB1',
    avisoAberto: false,
    erpRastreadoSemRevisao: null,
  };

  it('row 1 — the link no longer holds `nova`: a newer event owns it', () => {
    expect(decidirAvisoCategoria({ ...base, mlAtual: 'MLB3' })).toEqual({
      acao: 'nada',
      razao: 'ml-mudou-de-novo',
    });
  });

  it('row 2 — ERP already = `nova`: resolves an open row, else nothing to do', () => {
    expect(decidirAvisoCategoria({ ...base, erpId: 'MLB2', avisoAberto: true })).toEqual({
      acao: 'resolver',
      motivo: MOTIVO_RESOLUCAO_CATEGORIA.alinhada,
    });
    expect(decidirAvisoCategoria({ ...base, erpId: 'MLB2' })).toEqual({
      acao: 'nada',
      razao: 'ja-alinhada',
    });
  });

  it('row 3 — a produto with no ERP category: nothing', () => {
    expect(decidirAvisoCategoria({ ...base, erpId: null, avisoAberto: true })).toEqual({
      acao: 'nada',
      razao: 'produto-sem-categoria',
    });
  });

  it('row 4 — ERP = the category ML LEFT: raise', () => {
    expect(decidirAvisoCategoria(base)).toEqual({
      acao: 'avisar',
      categoriaErpId: 'MLB1',
      categoriaMlId: 'MLB2',
    });
  });

  it('row 4 — a SECOND move refreshes an open row even though ERP ≠ the latest `anterior`', () => {
    expect(
      decidirAvisoCategoria({
        ...base,
        anterior: 'MLB2',
        nova: 'MLB3',
        mlAtual: 'MLB3',
        avisoAberto: true,
      }),
    ).toEqual({ acao: 'avisar', categoriaErpId: 'MLB1', categoriaMlId: 'MLB3' });
  });

  it('row 5 — a curated ERP category that never followed ML: nothing', () => {
    expect(decidirAvisoCategoria({ ...base, erpId: 'camisetas-curada' })).toEqual({
      acao: 'nada',
      razao: 'categoria-erp-nao-segue-ml',
    });
  });

  it('near-misses on the narrow raise: a prefix or a case fold of `anterior` is NOT it', () => {
    expect(decidirAvisoCategoria({ ...base, erpId: 'MLB12' }).acao).toBe('nada');
    expect(decidirAvisoCategoria({ ...base, erpId: 'mlb1' }).acao).toBe('nada');
  });

  // #1843 review: ERP = A; ML moves A → B at the SAME commission (recorded, not
  // raised); later B → D at a different one. `anterior` is now B, so only the
  // closed row can say A was ever this listing's category.
  const segundaMudanca = {
    ...base,
    anterior: 'MLB2',
    nova: 'MLB3',
    mlAtual: 'MLB3',
    erpId: 'MLB1',
  };

  it('row 4 — TWO moves: a row closed without review still tracks the stale ERP category', () => {
    expect(decidirAvisoCategoria({ ...segundaMudanca, erpRastreadoSemRevisao: 'MLB1' })).toEqual({
      acao: 'avisar',
      categoriaErpId: 'MLB1',
      categoriaMlId: 'MLB3',
    });
  });

  it('…the same two moves with NO memory raise nothing — the reviewer’s exact input', () => {
    expect(decidirAvisoCategoria(segundaMudanca)).toEqual({
      acao: 'nada',
      razao: 'categoria-erp-nao-segue-ml',
    });
  });

  it('…and a memory of a DIFFERENT (or near-miss) ERP category tracks nothing', () => {
    expect(decidirAvisoCategoria({ ...segundaMudanca, erpRastreadoSemRevisao: 'MLB9' }).acao).toBe(
      'nada',
    );
    expect(decidirAvisoCategoria({ ...segundaMudanca, erpRastreadoSemRevisao: 'MLB12' }).acao).toBe(
      'nada',
    );
  });
});

describe('percentualDaComissao / comissoesIguais', () => {
  it('reads `sale_fee_details.percentage_fee` only when it is a finite number', () => {
    expect(percentualDaComissao({ sale_fee_details: { percentage_fee: 16 } })).toBe(16);
    expect(percentualDaComissao({ sale_fee_details: { percentage_fee: null } })).toBeNull();
    expect(percentualDaComissao({ sale_fee_details: null })).toBeNull();
    expect(percentualDaComissao({})).toBeNull();
  });

  it('equal is exact — 16 vs 16 is equal, 16 vs 16.5 is not', () => {
    expect(comissoesIguais({ erpPct: 16, mlPct: 16 })).toBe(true);
    expect(comissoesIguais({ erpPct: 16, mlPct: 16.5 })).toBe(false);
  });
});

describe('planCategoriaDoProduto — only a REAL change of the ERP category', () => {
  it('a changed category reports the new id', () => {
    expect(
      planCategoriaDoProduto(
        { categoriaProdutoOuterRef: 'documents/categorias/MLB1' },
        { categoriaProdutoOuterRef: 'documents/categorias/MLB2' },
      ),
    ).toEqual({ erpDepoisId: 'MLB2' });
  });

  it('a cleared category reports null', () => {
    expect(
      planCategoriaDoProduto({ categoriaProdutoOuterRef: 'categorias/MLB1' }, { nome: 'x' }),
    ).toEqual({ erpDepoisId: null });
  });

  it('the same ref in another stored form is NOT a change', () => {
    expect(
      planCategoriaDoProduto(
        { categoriaProdutoOuterRef: 'categorias/MLB1' },
        { categoriaProdutoOuterRef: 'documents/categorias/MLB1' },
      ),
    ).toBeNull();
  });

  it('an unrelated write, a create and a delete are nothing', () => {
    const p = { categoriaProdutoOuterRef: 'categorias/MLB1' };
    expect(planCategoriaDoProduto(p, { ...p, nome: 'novo' })).toBeNull();
    expect(planCategoriaDoProduto(null, p)).toBeNull();
    expect(planCategoriaDoProduto(p, null)).toBeNull();
  });
});

/* ------------------------------------ IO ---------------------------------- */

describe('aplicarPlanoCategoriaDoLink — the raise', () => {
  it('raises with names, the new chain created, and ML’s fee for BOTH categories', async () => {
    const db = new FakeDb();
    seedMundo(db);
    const api = apiFake();

    const out = await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(api),
    );

    expect(out).toEqual({ acao: 'avisado', resultado: 'criado' });
    expect(aviso.avisar).toHaveBeenCalledWith(
      db,
      {
        ...ALVO,
        anuncio: 'MLB777',
        categoriaErpId: 'MLB1',
        categoriaErpNome: 'Roupas > Camisetas',
        categoriaMlId: 'MLB2',
        categoriaMlNome: 'Roupas > Camisetas e Regatas',
        comissoes: { erpPct: 16, mlPct: 11.5 },
      },
      expect.anything(),
    );
    // The category ML moved the listing INTO now exists, so the operator can pick it.
    expect(db.criados).toEqual(['categorias/MLB1430', 'categorias/MLB2']);
    // The fee preview is asked at the listing's own price and type.
    expect(api.getListingPrices).toHaveBeenCalledWith({
      price: 79.9,
      listingTypeId: 'gold_special',
      categoryId: 'MLB1',
    });
  });

  it('an EXISTING category document is never overwritten', async () => {
    const db = new FakeDb();
    seedMundo(db);
    db.seed('categorias/MLB2', { nome: 'curada pelo ERP' });

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(),
    );

    expect(db.docs.get('categorias/MLB2')).toEqual({ nome: 'curada pelo ERP' });
  });

  it('the same commission on both sides → nothing RAISED, but the move is RECORDED', async () => {
    // Not a plain resolve: with no row yet, a resolve writes nothing, and the
    // next move would no longer know MLB1 was this listing's category (#1843
    // review). The record carries the ERP category it tracks.
    const db = new FakeDb();
    seedMundo(db);

    const out = await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(apiFake({ MLB1: 16, MLB2: 16 })),
    );

    expect(aviso.avisar).not.toHaveBeenCalled();
    expect(aviso.resolver).not.toHaveBeenCalled();
    expect(aviso.registrar).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        ...ALVO,
        categoriaErpId: 'MLB1',
        categoriaMlId: 'MLB2',
        comissoes: { erpPct: 16, mlPct: 16 },
      }),
      expect.objectContaining({ nowMs: 1_760_000_000_000 }),
    );
    expect(out).toMatchObject({ acao: 'resolvido', motivo: 'mesma-comissao' });
  });

  it('#1843 review — a SECOND move after a same-commission record raises', async () => {
    // ERP still MLB1; the first move MLB1 → MLB2 was recorded `mesma-comissao`;
    // now MLB2 → MLB3 at a different commission.
    const db = new FakeDb();
    seedMundo(db, { link: { category_id: 'MLB3' } });
    avisoFechadoEm(db, MOTIVO_RESOLUCAO_CATEGORIA.mesmaComissao);

    const out = await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      { ...PLANO, anterior: 'MLB2', nova: 'MLB3' },
      deps(apiFake({ MLB1: 16, MLB3: 13 })),
    );

    expect(out).toMatchObject({ acao: 'avisado' });
    expect(aviso.avisar).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        categoriaErpId: 'MLB1',
        categoriaMlId: 'MLB3',
        comissoes: { erpPct: 16, mlPct: 13 },
      }),
      expect.anything(),
    );
  });

  it('a listing that ENDED and was relisted keeps its memory too', async () => {
    const db = new FakeDb();
    seedMundo(db, { link: { category_id: 'MLB3' } });
    avisoFechadoEm(db, MOTIVO_RESOLUCAO_CATEGORIA.encerrado);

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      { ...PLANO, anterior: 'MLB2', nova: 'MLB3' },
      deps(apiFake({ MLB1: 16, MLB3: 13 })),
    );

    expect(aviso.avisar).toHaveBeenCalled();
  });

  it('near-miss: a row the OPERATOR closed tracks nothing, even on the same ERP category', async () => {
    const db = new FakeDb();
    seedMundo(db, { link: { category_id: 'MLB3' } });
    avisoFechadoEm(db, MOTIVO_RESOLUCAO_CATEGORIA.erpAlterada);

    const out = await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      { ...PLANO, anterior: 'MLB2', nova: 'MLB3' },
      deps(),
    );

    expect(out).toEqual({ acao: 'nada', razao: 'categoria-erp-nao-segue-ml' });
    expect(aviso.avisar).not.toHaveBeenCalled();
  });

  it('ONE fee unknown still raises — unknown is not "the same"', async () => {
    const db = new FakeDb();
    seedMundo(db);

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(apiFake({ MLB1: 16 })),
    );

    expect(aviso.avisar).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ comissoes: null }),
      expect.anything(),
    );
  });

  it('no price or no listing type → no fee preview, the aviso still goes out', async () => {
    // A UP family's parent carries no `precoPublicado`.
    const db = new FakeDb();
    seedMundo(db, { link: { precoPublicado: null } });
    const api = apiFake();

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(api),
    );

    expect(api.getListingPrices).not.toHaveBeenCalled();
    expect(aviso.avisar).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ comissoes: null }),
      expect.anything(),
    );
  });
});

describe('aplicarPlanoCategoriaDoLink — enrichment is best-effort, the aviso is not', () => {
  it.each([
    [
      'a conta that must reconnect',
      new MercadoLivreReauthRequiredError('refresh_failed', 'reconectar'),
    ],
    ['an HTTP failure on the token refresh', new MercadoLivreHttpError('ML 503', 503, null)],
  ])('%s → the aviso goes out with ids only', async (_caso, erro) => {
    const db = new FakeDb();
    seedMundo(db);

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(erro),
    );

    expect(aviso.avisar).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        categoriaErpNome: 'Roupas > Camisetas', // the ERP's own doc — no ML call
        categoriaMlNome: null,
        comissoes: null,
      }),
      expect.anything(),
    );
  });

  it('ML failing the category detail or the fees degrades each part alone', async () => {
    const db = new FakeDb();
    seedMundo(db);
    const api = apiFake(undefined, {
      getCategory: vi.fn(async () => {
        throw new MercadoLivreNetworkError('offline');
      }),
      getListingPrices: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 429', 429, null);
      }),
    });

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(api),
    );

    expect(aviso.avisar).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ categoriaMlNome: null, comissoes: null }),
      expect.anything(),
    );
    expect(db.criados).toEqual([]);
  });

  it('a NON-ML failure is not swallowed (rule 6)', async () => {
    const db = new FakeDb();
    seedMundo(db);

    await expect(
      aplicarPlanoCategoriaDoLink(
        asDb(db),
        { produtoId: PRODUTO, linkDocId: LINK },
        PLANO,
        deps(new TypeError('a bug, not an outage')),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(aviso.avisar).not.toHaveBeenCalled();
  });

  it('a Firestore failure throws — the trigger retries rather than deciding blind', async () => {
    const db = new FakeDb();
    seedMundo(db);
    db.falhaNaLeitura = Object.assign(new Error('unavailable'), { code: 14 });

    await expect(
      aplicarPlanoCategoriaDoLink(asDb(db), { produtoId: PRODUTO, linkDocId: LINK }, PLANO, deps()),
    ).rejects.toThrow('unavailable');
  });
});

describe('aplicarPlanoCategoriaDoLink — decided from the CURRENT state', () => {
  it('no ML call at all unless the decision is to raise', async () => {
    const db = new FakeDb();
    seedMundo(db, { produto: { categoriaProdutoOuterRef: 'categorias/curada' } });
    const d = deps();

    const out = await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      d,
    );

    expect(out).toEqual({ acao: 'nada', razao: 'categoria-erp-nao-segue-ml' });
    expect(d.resolverApi).not.toHaveBeenCalled();
    expect(aviso.avisar).not.toHaveBeenCalled();
  });

  it('a replayed event whose category ML has since changed again does nothing', async () => {
    const db = new FakeDb();
    seedMundo(db, { link: { category_id: 'MLB3' } });

    const out = await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(),
    );

    expect(out).toEqual({ acao: 'nada', razao: 'ml-mudou-de-novo' });
  });

  it('an open aviso and a produto ALREADY aligned → resolved, no raise', async () => {
    const db = new FakeDb();
    seedMundo(db, { produto: { categoriaProdutoOuterRef: 'categorias/MLB2' } });
    avisoAbertoEm(db);

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(),
    );

    expect(aviso.resolver).toHaveBeenCalledWith(
      db,
      ALVO,
      MOTIVO_RESOLUCAO_CATEGORIA.alinhada,
      expect.anything(),
    );
    expect(aviso.avisar).not.toHaveBeenCalled();
  });

  it('the link deleted before we looked → nothing (its delete event closes the row)', async () => {
    const db = new FakeDb();
    seedMundo(db);
    db.docs.delete(`${LINK_PATH}/${LINK}`);

    const out = await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(),
    );

    expect(out).toEqual({ acao: 'nada', razao: 'link-removido' });
  });
});

describe('aplicarPlanoCategoriaDoLink — the post-write re-read (rule 7)', () => {
  it('the operator re-categorized WHILE we raised → the row we just wrote is closed', async () => {
    // The produto trigger may have looked for this row before it existed; the
    // re-read is what makes whichever of the two runs second see the other.
    const db = new FakeDb();
    seedMundo(db);
    aviso.avisar.mockImplementationOnce(async () => {
      db.seed(`produtos/${PRODUTO}`, { categoriaProdutoOuterRef: 'categorias/MLB2' });
      return { chave: 'k', resultado: 'criado' };
    });

    const out = await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(),
    );

    expect(aviso.resolver).toHaveBeenCalledWith(
      db,
      ALVO,
      MOTIVO_RESOLUCAO_CATEGORIA.alinhada,
      expect.anything(),
    );
    expect(out).toEqual({
      acao: 'avisado',
      resultado: 'criado',
      resolvidoEmSeguida: 'categoria-erp-alinhada',
    });
  });

  it('…to something else → closed as `categoria-erp-alterada`', async () => {
    const db = new FakeDb();
    seedMundo(db);
    aviso.avisar.mockImplementationOnce(async () => {
      db.seed(`produtos/${PRODUTO}`, { categoriaProdutoOuterRef: 'categorias/curada' });
      return { chave: 'k', resultado: 'criado' };
    });

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(),
    );

    expect(aviso.resolver).toHaveBeenCalledWith(
      db,
      ALVO,
      MOTIVO_RESOLUCAO_CATEGORIA.erpAlterada,
      expect.anything(),
    );
  });

  it('nothing moved → the aviso stands', async () => {
    const db = new FakeDb();
    seedMundo(db);

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      PLANO,
      deps(),
    );

    expect(aviso.resolver).not.toHaveBeenCalled();
  });
});

describe('aplicarPlanoCategoriaDoLink — the `fim` arm', () => {
  it('closes the link’s row with the plan’s motivo, reading nothing else', async () => {
    const db = new FakeDb();
    const d = deps();

    await aplicarPlanoCategoriaDoLink(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: LINK },
      { tipo: 'fim', integracaoId: CONTA, motivo: MOTIVO_RESOLUCAO_CATEGORIA.encerrado },
      d,
    );

    expect(aviso.resolver).toHaveBeenCalledWith(db, ALVO, 'anuncio-encerrado', d);
    expect(db.lidos).toEqual([]);
    expect(d.resolverApi).not.toHaveBeenCalled();
  });
});

describe('resolverAvisosDoProduto — the produto trigger’s answer', () => {
  it('closes every listing’s row: aligned where it matches, reviewed elsewhere', async () => {
    const db = new FakeDb();
    db.seed(`${LINK_PATH}/link-1`, linkVivo({ category_id: 'MLB2' }));
    db.seed(`${LINK_PATH}/link-2`, linkVivo({ category_id: 'MLB9' }));
    // A link whose conta cannot be resolved has no aviso key to compute.
    db.seed(`${LINK_PATH}/link-3`, linkVivo({ contaOuterRef: null }));
    // A grandchild path must not be mistaken for one of the produto's links.
    db.seed(`${LINK_PATH}/link-1/sub/x`, { category_id: 'MLB2' });

    const n = await resolverAvisosDoProduto(asDb(db), PRODUTO, 'MLB2', { nowMs: 1 });

    expect(aviso.resolver).toHaveBeenCalledTimes(2);
    expect(aviso.resolver).toHaveBeenCalledWith(
      db,
      { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: 'link-1' },
      MOTIVO_RESOLUCAO_CATEGORIA.alinhada,
      { nowMs: 1 },
    );
    expect(aviso.resolver).toHaveBeenCalledWith(
      db,
      { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: 'link-2' },
      MOTIVO_RESOLUCAO_CATEGORIA.erpAlterada,
      { nowMs: 1 },
    );
    expect(n).toBe(2);
  });

  it('a cleared ERP category resolves as reviewed, never as aligned', async () => {
    const db = new FakeDb();
    db.seed(`${LINK_PATH}/link-1`, linkVivo({ category_id: 'MLB2' }));

    await resolverAvisosDoProduto(asDb(db), PRODUTO, null, { nowMs: 1 });

    expect(aviso.resolver).toHaveBeenCalledWith(
      db,
      expect.anything(),
      MOTIVO_RESOLUCAO_CATEGORIA.erpAlterada,
      expect.anything(),
    );
  });
});
