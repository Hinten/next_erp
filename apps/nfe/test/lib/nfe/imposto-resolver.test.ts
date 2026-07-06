import { describe, expect, it, vi } from 'vitest';

import {
  impostoProdutoSchema,
  type ImpostoCategoria,
  type ImpostoProduto,
  type RegraImposto,
} from '@delfrance/schemas';

import {
  createImpostoResolver,
  type ImpostoResolverDeps,
  type ResolverBundle,
} from '../../../lib/nfe/imposto-resolver';

const ACTIVE_OPERACAO = 'op-active';

const VALID_IMPOSTO_BLOB = {
  origem: '0',
  configuracaoICMS: { crt: '1', csosn: '102' },
} as const;

const BLOB_400 = {
  origem: '0',
  configuracaoICMS: { crt: '1', csosn: '400' },
} as const;

/**
 * Build an `impostoProduto` fixture via the schema (fills the Dados Gerais
 * defaults and preserves the passthrough imposto blob). `impostoOpercaoOuterRef`
 * is Flutter's typo wire key.
 */
function impostoProdutoDoc(over: Record<string, unknown> = {}): ImpostoProduto {
  return impostoProdutoSchema.parse({
    id: 'doc-1',
    impostoOpercaoOuterRef: null,
    ...VALID_IMPOSTO_BLOB,
    ...over,
  });
}

function makeDeps(over: Partial<ImpostoResolverDeps> = {}): ImpostoResolverDeps {
  const bundle: ResolverBundle = { operacaoId: ACTIVE_OPERACAO, regrasImposto: [] };
  return {
    bundle,
    readProduto: vi.fn().mockResolvedValue(null),
    readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([]),
    readImpostoCategoriaSubcoll: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe('resolveItemImposto — cascade priority', () => {
  it('returns item-stamped imposto when present and valid', async () => {
    const deps = makeDeps();
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', VALID_IMPOSTO_BLOB);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(deps.readImpostoProdutoSubcoll).not.toHaveBeenCalled();
    expect(deps.readProduto).not.toHaveBeenCalled();
  });

  it('falls through to impostoProduto when item.imposto is null', async () => {
    const impostoProduto = impostoProdutoDoc();
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([impostoProduto]),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(deps.readImpostoProdutoSubcoll).toHaveBeenCalledWith('p1');
  });

  it('honours the impostoOpercaoOuterRef (typo key) scope on impostoProduto', async () => {
    const wrongScope = impostoProdutoDoc({ impostoOpercaoOuterRef: 'operacao/op-other' });
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([wrongScope]),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out).toBeNull();
  });

  it('matches impostoProduto whose ref ends with the active operacao id', async () => {
    const matchingScope = impostoProdutoDoc({
      impostoOpercaoOuterRef: `operacao/${ACTIVE_OPERACAO}`,
    });
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([matchingScope]),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('prefers an exact operação match over a null-scoped default (#222)', async () => {
    // The null-scoped default comes FIRST in the array; a plain `.find()` that
    // accepts both would wrongly return it. The per-operação override must win
    // so fiscal data respects the SELECTED operação.
    const defaultDoc = impostoProdutoDoc({ id: 'def', impostoOpercaoOuterRef: null, ...BLOB_400 });
    const exactDoc = impostoProdutoDoc({
      id: 'exact',
      impostoOpercaoOuterRef: `operacao/${ACTIVE_OPERACAO}`,
    });
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([defaultDoc, exactDoc]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102'); // exact (102), not default (400)
  });

  it('uses the null-scoped default when no exact operação match exists (#222)', async () => {
    const defaultDoc = impostoProdutoDoc({ id: 'def', impostoOpercaoOuterRef: null });
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([defaultDoc]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('prefers an exact categoria operação match over its null-scoped default (#222)', async () => {
    const defaultCat: ImpostoCategoria = {
      id: 'cat-def',
      impostoCategoriaOperacaoOuterRef: null,
      dataCadastro: null,
      ...BLOB_400,
    };
    const exactCat: ImpostoCategoria = {
      id: 'cat-exact',
      impostoCategoriaOperacaoOuterRef: `operacao/${ACTIVE_OPERACAO}`,
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
      readImpostoCategoriaSubcoll: vi.fn().mockResolvedValue([defaultCat, exactCat]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102'); // exact, not default 400
  });

  it('carries a configuracaoIBSCBS (RTC) blob through the impostoProduto tier', async () => {
    const rtc = { CST: '000', cClassTrib: '000000', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 };
    const withRtc = impostoProdutoDoc({ configuracaoIBSCBS: rtc });
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([withRtc]),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    // Stored leniently (z.unknown) and preserved verbatim through resolution.
    expect(out?.configuracaoIBSCBS).toEqual(rtc);
  });

  it('tolerates a PARTIAL configuracaoIBSCBS blob — resolution still succeeds', async () => {
    // A half-filled RTC registration must NOT disable the item's whole imposto
    // (the resolver falls through on any parse failure). Lenient storage keeps
    // it parseable; the strict check happens only at emit time.
    const out = await createImpostoResolver(makeDeps()).resolve('p1', {
      ...VALID_IMPOSTO_BLOB,
      configuracaoIBSCBS: { CST: '000' }, // missing cClassTrib + rates
    });
    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(out?.configuracaoIBSCBS).toEqual({ CST: '000' });
  });

  it('falls through to impostoCategoria when produto has a categoriaProdutoOuterRef', async () => {
    const impostoCategoria: ImpostoCategoria = {
      id: 'cat-doc',
      impostoCategoriaOperacaoOuterRef: null,
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
      readImpostoCategoriaSubcoll: vi.fn().mockResolvedValue([impostoCategoria]),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(deps.readImpostoCategoriaSubcoll).toHaveBeenCalledWith('cat-7');
  });

  it('skips impostoCategoria lookup when produto has no categoria ref', async () => {
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ NCM: '61091000' }),
    });
    const resolver = createImpostoResolver(deps);
    await resolver.resolve('p1', null);
    expect(deps.readImpostoCategoriaSubcoll).not.toHaveBeenCalled();
  });

  it('falls through to regraImposto with produto-uid OR-match', async () => {
    const regra: RegraImposto = {
      id: 'r1',
      nome: 'Default',
      produtos: ['p1'],
      categorias: [],
      ncms: [],
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [regra] },
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('falls through to regraImposto with categoria-uid OR-match', async () => {
    const regra: RegraImposto = {
      id: 'r1',
      nome: null,
      produtos: [],
      categorias: ['cat-7'],
      ncms: [],
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [regra] },
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('falls through to regraImposto with NCM OR-match', async () => {
    const regra: RegraImposto = {
      id: 'r1',
      nome: null,
      produtos: [],
      categorias: [],
      ncms: ['61091000'],
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [regra] },
      readProduto: vi.fn().mockResolvedValue({ NCM: '61091000' }),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('returns null when no rule matches (orchestrator throws downstream)', async () => {
    const deps = makeDeps();
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p-orphan', null);
    expect(out).toBeNull();
  });

  it('falls through to the operação default config when nothing else matches', async () => {
    // Tier 5 (Flutter parity): the operação doc's own tax config is the
    // last-resort default — an item matching no produto/categoria/regra still
    // emits instead of failing with NFeMissingImpostoError.
    const deps = makeDeps({
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [],
        operacao: { ...VALID_IMPOSTO_BLOB },
      },
    });
    const out = await createImpostoResolver(deps).resolve('p-orphan', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('operação default does NOT fire when the operação carries no usable Imposto', async () => {
    // An operação with no `origem` is not a valid Imposto — the tier is skipped
    // and resolution falls through to null (emission fails loudly downstream).
    const deps = makeDeps({
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [],
        operacao: { nome: 'Venda', tipo: 1 },
      },
    });
    const out = await createImpostoResolver(deps).resolve('p-orphan', null);
    expect(out).toBeNull();
  });

  it('produto/categoria/regra still win over the operação default', async () => {
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([impostoProdutoDoc()]),
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [],
        operacao: { ...BLOB_400 },
      },
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102'); // produto tier, not 400
  });

  it('first-wins among multiple regraImposto matches (Flutter parity)', async () => {
    const first: RegraImposto = {
      id: 'r1',
      nome: 'First',
      produtos: ['p1'],
      categorias: [],
      ncms: [],
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const second: RegraImposto = {
      id: 'r2',
      nome: 'Second',
      produtos: ['p1'],
      categorias: [],
      ncms: [],
      dataCadastro: null,
      ...BLOB_400,
    };
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [first, second] },
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102'); // first wins
  });
});

describe('resolveItemImposto — NCM + entry-shape normalization (#398)', () => {
  function ncmRegra(ncms: string[], blob: Record<string, unknown> = VALID_IMPOSTO_BLOB) {
    return {
      id: `r-${ncms.join('-')}`,
      nome: null,
      produtos: [],
      categorias: [],
      ncms,
      dataCadastro: null,
      ...blob,
    } as RegraImposto;
  }

  it('matches an NCM rule when produto.NCM is human-formatted (6109.10.00)', async () => {
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [ncmRegra(['61091000'])] },
      readProduto: vi.fn().mockResolvedValue({ NCM: '6109.10.00' }),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('matches when the RULE entry is formatted and produto.NCM is 8-digit', async () => {
    // A regra doc can carry a formatted NCM (hand-copied legacy data slips
    // past nothing here — the resolver normalizes both sides).
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [ncmRegra(['6109.10.00'])] },
      readProduto: vi.fn().mockResolvedValue({ NCM: '61091000' }),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('matches regra.produtos entries stored as paths (legacy shapes)', async () => {
    for (const entry of ['produtos/p1', 'documents/produtos/p1', 'p1']) {
      const regra: RegraImposto = {
        id: 'r1',
        nome: null,
        produtos: [entry],
        categorias: [],
        ncms: [],
        dataCadastro: null,
        ...VALID_IMPOSTO_BLOB,
      };
      const deps = makeDeps({
        bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [regra] },
      });
      const out = await createImpostoResolver(deps).resolve('p1', null);
      expect(out?.configuracaoICMS?.csosn).toBe('102');
    }
  });

  it('matches regra.categorias entries stored as documents/ paths', async () => {
    const regra: RegraImposto = {
      id: 'r1',
      nome: null,
      produtos: [],
      categorias: ['documents/categorias/cat-7'],
      ncms: [],
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [regra] },
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('prefers the NCM of a matched-but-invalid closer tier over produto.NCM (Flutter parity)', async () => {
    // The produto-tier doc matches the operação but fails the engine schema
    // (origem null). Its NCM — not the produto doc's — must key the NCM
    // rules, mirroring Flutter (which matched the RESOLVED imposto's NCM).
    const invalidProdutoTier = impostoProdutoDoc({ origem: null, NCM: '11111111' });
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([invalidProdutoTier]),
      readProduto: vi.fn().mockResolvedValue({ NCM: '22222222' }),
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [ncmRegra(['11111111']), ncmRegra(['22222222'], BLOB_400)],
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await createImpostoResolver(deps).resolve('p1', null);
      expect(out?.configuracaoICMS?.csosn).toBe('102'); // via the 11111111 rule
    } finally {
      warn.mockRestore();
    }
  });

  it("uses the invalid item-stamp's NCM as the closest candidate", async () => {
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [ncmRegra(['33049900'])] },
      readProduto: vi.fn().mockResolvedValue({ NCM: '22222222' }),
    });
    // Invalid stamp (no origem) carrying a formatted NCM.
    const out = await createImpostoResolver(deps).resolve('p1', { NCM: '3304.99.00' });
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('items of the same produto with different stamped NCMs do not share a cached result', async () => {
    const deps = makeDeps({
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [ncmRegra(['11111111']), ncmRegra(['22222222'], BLOB_400)],
      },
      readProduto: vi.fn().mockResolvedValue(null),
    });
    const resolver = createImpostoResolver(deps);
    const a = await resolver.resolve('p1', { NCM: '1111.11.11' });
    const b = await resolver.resolve('p1', { NCM: '2222.22.22' });
    expect(a?.configuracaoICMS?.csosn).toBe('102');
    expect(b?.configuracaoICMS?.csosn).toBe('400');
  });

  it('warns when a scoped match fails the engine schema and falls through (#398 observability)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const invalid = impostoProdutoDoc({
        id: 'bad-doc',
        origem: null,
        impostoOpercaoOuterRef: `operacao/${ACTIVE_OPERACAO}`,
      });
      const deps = makeDeps({
        readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([invalid]),
      });
      const out = await createImpostoResolver(deps).resolve('p1', null);
      expect(out).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/impostoProduto 'bad-doc'.*falling through/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('resolveItemImposto — caching', () => {
  it('memoises by produtoUid across resolve() calls', async () => {
    const impostoProduto = impostoProdutoDoc({ id: 'd1' });
    const readImpostoProduto = vi.fn().mockResolvedValue([impostoProduto]);
    const deps = makeDeps({ readImpostoProdutoSubcoll: readImpostoProduto });
    const resolver = createImpostoResolver(deps);
    await resolver.resolve('p1', null);
    await resolver.resolve('p1', null);
    await resolver.resolve('p1', null);
    expect(readImpostoProduto).toHaveBeenCalledTimes(1);
  });

  it('caches negative results too (no repeated Firestore reads on misses)', async () => {
    const readImpostoProduto = vi.fn().mockResolvedValue([]);
    const readProduto = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({
      readImpostoProdutoSubcoll: readImpostoProduto,
      readProduto,
    });
    const resolver = createImpostoResolver(deps);
    expect(await resolver.resolve('p-missing', null)).toBeNull();
    expect(await resolver.resolve('p-missing', null)).toBeNull();
    expect(readImpostoProduto).toHaveBeenCalledTimes(1);
    expect(readProduto).toHaveBeenCalledTimes(1);
  });

  it('item-stamped resolution does NOT poison the cache for later null-imposto calls', async () => {
    // p1 first carries an item-stamped imposto (CSOSN 400), then a later
    // call passes null — the cascade must still run and return whatever
    // the produto/categoria/regra resolves to (here, 102 via impostoProduto).
    const impostoProduto = impostoProdutoDoc({ id: 'd1' });
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([impostoProduto]),
    });
    const resolver = createImpostoResolver(deps);
    const first = await resolver.resolve('p1', {
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '400' },
    });
    const second = await resolver.resolve('p1', null);
    expect(first?.configuracaoICMS?.csosn).toBe('400');
    expect(second?.configuracaoICMS?.csosn).toBe('102');
  });
});

describe('resolveItemImposto — verbatim legacy Flutter wire (#423)', () => {
  it('scopes a legacy categoria doc whose ref is a BARE operação uid', async () => {
    // The legacy app stored the scope as a bare uid (or `operacao/<id>` —
    // both shapes verified in .old). Exact-beats-null (#222) must hold on
    // the legacy shape too.
    const legacyDefault: ImpostoCategoria = {
      id: 'leg-def',
      impostoCategoriaOperacaoOuterRef: null,
      dataCadastro: null,
      ...BLOB_400,
    };
    const legacyExact: ImpostoCategoria = {
      id: 'leg-exact',
      impostoCategoriaOperacaoOuterRef: ACTIVE_OPERACAO, // bare uid, no prefix
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
      readImpostoCategoriaSubcoll: vi.fn().mockResolvedValue([legacyDefault, legacyExact]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102'); // exact legacy scope wins
  });

  it("folds a legacy regra's UPPERCASE CFOP into the resolved imposto's cfop", async () => {
    const legacyRegra: RegraImposto = {
      id: 'leg-r1',
      nome: null,
      produtos: ['produtos/p1'], // legacy path-shaped entry
      categorias: [],
      ncms: [],
      dataCadastro: null,
      CFOP: '5405',
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [legacyRegra] },
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(out?.cfop).toBe('5405'); // CFOP (legacy key) survived into the engine blob
  });

  it('a lowercase cfop wins over the legacy CFOP when both are present', async () => {
    const mixedRegra: RegraImposto = {
      id: 'mix-r1',
      nome: null,
      produtos: ['p1'],
      categorias: [],
      ncms: [],
      dataCadastro: null,
      cfop: '5102',
      CFOP: '5405',
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [mixedRegra] },
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.cfop).toBe('5102');
  });
});
