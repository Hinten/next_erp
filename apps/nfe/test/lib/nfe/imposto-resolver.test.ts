import { describe, expect, it, vi } from 'vitest';

import type {
  ImpostoCategoria,
  ImpostoProduto,
  RegraImposto,
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
};

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
    const impostoProduto: ImpostoProduto = {
      id: 'doc-1',
      impostoOperacaoOuterRef: null,
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([impostoProduto]),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(deps.readImpostoProdutoSubcoll).toHaveBeenCalledWith('p1');
  });

  it('honours impostoOperacaoOuterRef scope on impostoProduto', async () => {
    const wrongScope: ImpostoProduto = {
      id: 'doc-1',
      impostoOperacaoOuterRef: 'operacao/op-other',
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([wrongScope]),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out).toBeNull();
  });

  it('matches impostoProduto whose ref ends with the active operacao id', async () => {
    const matchingScope: ImpostoProduto = {
      id: 'doc-1',
      impostoOperacaoOuterRef: `operacao/${ACTIVE_OPERACAO}`,
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([matchingScope]),
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('falls through to impostoCategoria when produto has a categoriaProdutoOuterRef', async () => {
    const impostoCategoria: ImpostoCategoria = {
      id: 'cat-doc',
      impostoOperacaoOuterRef: null,
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
    const deps = makeDeps({
      readProduto: vi
        .fn()
        .mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
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
      readProduto: vi
        .fn()
        .mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
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

  it('first-wins among multiple regraImposto matches (Flutter parity)', async () => {
    const first: RegraImposto = {
      id: 'r1',
      nome: 'First',
      produtos: ['p1'],
      categorias: [],
      ncms: [],
      dataCadastro: null,
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '102' },
    };
    const second: RegraImposto = {
      id: 'r2',
      nome: 'Second',
      produtos: ['p1'],
      categorias: [],
      ncms: [],
      dataCadastro: null,
      origem: '0',
      configuracaoICMS: { crt: '1', csosn: '400' },
    };
    const deps = makeDeps({
      bundle: { operacaoId: ACTIVE_OPERACAO, regrasImposto: [first, second] },
    });
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102'); // first wins
  });
});

describe('resolveItemImposto — caching', () => {
  it('memoises by produtoUid across resolve() calls', async () => {
    const impostoProduto: ImpostoProduto = {
      id: 'd1',
      impostoOperacaoOuterRef: null,
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
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
    const impostoProduto: ImpostoProduto = {
      id: 'd1',
      impostoOperacaoOuterRef: null,
      dataCadastro: null,
      ...VALID_IMPOSTO_BLOB,
    };
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
