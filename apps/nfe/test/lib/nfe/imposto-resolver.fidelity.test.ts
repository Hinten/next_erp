/**
 * Fidelity tests for the Imposto resolver cascade.
 *
 * The unit tests in `imposto-resolver.test.ts` exercise each cascade
 * level in isolation. These tests exercise scenarios where multiple
 * levels are seeded simultaneously and the priority must be enforced,
 * plus an end-to-end round-trip from a resolved Imposto into the
 * `<imposto>` XML produced by `buildImpostoXml`.
 *
 * Priority (Flutter parity): item-stamped > impostoProduto > impostoCategoria > regraImposto.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  impostoProdutoSchema,
  type ImpostoCategoria,
  type ImpostoProduto,
  type RegraImposto,
} from '@delfrance/schemas';
import { buildImpostoXml } from '@delfrance/integrations-nfe';

import {
  createImpostoResolver,
  type ImpostoResolverDeps,
  type ResolverBundle,
} from '../../../lib/nfe/imposto-resolver';

const ACTIVE_OPERACAO = 'op-active';
const OTHER_OPERACAO = 'op-other';

// CSOSN sentinels — each cascade level uses a distinct CSOSN so the
// resolved Imposto pins down exactly which source won.
const CSOSN_ITEM = '102'; // sem permissão de crédito
const CSOSN_PRODUTO = '101'; // com permissão de crédito
const CSOSN_PRODUTO_101_CRED = { pCredSN: 1.25, vCredICMSSN: 18.75 };
const CSOSN_CATEGORIA = '400'; // não tributada pelo SN
const CSOSN_REGRA = '300'; // imune

function impostoBlob(csosn: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    origem: '0',
    configuracaoICMS: { crt: '1', csosn, ...extra },
    configuracaoPIS: { CST: '49' },
    configuracaoCOFINS: { CST: '49' },
  };
}

function itemImposto(): Record<string, unknown> {
  return impostoBlob(CSOSN_ITEM);
}

function produtoDoc(
  produtoUid: string,
  csosn: string,
  scope: string | null = null,
): ImpostoProduto {
  // Flutter typo wire key; the schema fills Dados Gerais defaults + keeps the blob.
  return impostoProdutoSchema.parse({
    id: `${produtoUid}-imp`,
    impostoOpercaoOuterRef: scope,
    ...impostoBlob(csosn, csosn === '101' ? { csosn101: CSOSN_PRODUTO_101_CRED } : {}),
  });
}

function categoriaDoc(
  categoriaUid: string,
  csosn: string,
  scope: string | null = null,
): ImpostoCategoria {
  return {
    id: `${categoriaUid}-imp`,
    impostoOperacaoOuterRef: scope,
    dataCadastro: null,
    ...impostoBlob(csosn),
  };
}

function regraDoc(over: Partial<RegraImposto>, csosn: string): RegraImposto {
  return {
    id: 'r1',
    nome: 'Default rule',
    produtos: [],
    categorias: [],
    ncms: [],
    dataCadastro: null,
    ...impostoBlob(csosn),
    ...over,
  };
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

describe('resolver fidelity — single-source resolution', () => {
  it('item-stamped wins and skips every Firestore read', async () => {
    const deps = makeDeps();
    const resolver = createImpostoResolver(deps);
    const out = await resolver.resolve('P-1', itemImposto());
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_ITEM);
    expect(deps.readProduto).not.toHaveBeenCalled();
    expect(deps.readImpostoProdutoSubcoll).not.toHaveBeenCalled();
    expect(deps.readImpostoCategoriaSubcoll).not.toHaveBeenCalled();
  });

  it('impostoProduto resolves when item.imposto is null', async () => {
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([produtoDoc('P-1', CSOSN_PRODUTO)]),
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_PRODUTO);
  });

  it('impostoCategoria resolves through produto.categoriaProdutoOuterRef', async () => {
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
      readImpostoCategoriaSubcoll: vi
        .fn()
        .mockResolvedValue([categoriaDoc('cat-7', CSOSN_CATEGORIA)]),
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_CATEGORIA);
  });

  it('regraImposto resolves via OR-match on produtoUid', async () => {
    const deps = makeDeps({
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [regraDoc({ produtos: ['P-1'] }, CSOSN_REGRA)],
      },
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_REGRA);
  });
});

describe('resolver fidelity — stacked priority enforcement', () => {
  /**
   * Helper: seed all four cascade levels at once. Each scenario peels
   * off one level to prove the next-highest still wins.
   */
  function seedAllFourLevels(): ImpostoResolverDeps {
    return makeDeps({
      readProduto: vi.fn().mockResolvedValue({
        categoriaProdutoOuterRef: 'categorias/cat-7',
        NCM: '61091000',
      }),
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([produtoDoc('P-1', CSOSN_PRODUTO)]),
      readImpostoCategoriaSubcoll: vi
        .fn()
        .mockResolvedValue([categoriaDoc('cat-7', CSOSN_CATEGORIA)]),
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [regraDoc({ produtos: ['P-1'] }, CSOSN_REGRA)],
      },
    });
  }

  it('item-stamped wins over impostoProduto + impostoCategoria + regraImposto', async () => {
    const out = await createImpostoResolver(seedAllFourLevels()).resolve('P-1', itemImposto());
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_ITEM);
  });

  it('impostoProduto wins over impostoCategoria + regraImposto when item is absent', async () => {
    const out = await createImpostoResolver(seedAllFourLevels()).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_PRODUTO);
  });

  it('impostoCategoria wins over regraImposto when item + impostoProduto are absent', async () => {
    const deps = seedAllFourLevels();
    deps.readImpostoProdutoSubcoll = vi.fn().mockResolvedValue([]);
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_CATEGORIA);
  });

  it('regraImposto is the fallback when every higher-priority source is absent', async () => {
    const deps = seedAllFourLevels();
    deps.readImpostoProdutoSubcoll = vi.fn().mockResolvedValue([]);
    deps.readImpostoCategoriaSubcoll = vi.fn().mockResolvedValue([]);
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_REGRA);
  });
});

describe('resolver fidelity — operacao-scope precedence', () => {
  it('impostoProduto: doc scoped to the active operacao wins over a null-scoped sibling', async () => {
    // Two impostoProduto docs in the same subcollection:
    //   - one with `impostoOperacaoOuterRef='operacao/op-active'` → CSOSN 101
    //   - one with `impostoOperacaoOuterRef=null`                  → CSOSN 400 (default)
    // The scoped doc must win (Flutter parity — `.find()` order matters, but
    // operacaoMatches semantics make the scoped one match first regardless).
    const scoped = produtoDoc('P-1', CSOSN_PRODUTO, `operacao/${ACTIVE_OPERACAO}`);
    const fallback = produtoDoc('P-1', CSOSN_CATEGORIA, null);
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([scoped, fallback]),
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_PRODUTO);
  });

  it('impostoProduto: a wrong-operacao-scoped doc loses to a null-scoped fallback', async () => {
    const wrongScope = produtoDoc('P-1', CSOSN_PRODUTO, `operacao/${OTHER_OPERACAO}`);
    const fallback = produtoDoc('P-1', CSOSN_CATEGORIA, null);
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([wrongScope, fallback]),
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_CATEGORIA);
  });

  it('impostoCategoria: scoped doc wins over null-scoped sibling', async () => {
    const scoped = categoriaDoc('cat-7', CSOSN_PRODUTO, `operacao/${ACTIVE_OPERACAO}`);
    const fallback = categoriaDoc('cat-7', CSOSN_CATEGORIA, null);
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
      readImpostoCategoriaSubcoll: vi.fn().mockResolvedValue([scoped, fallback]),
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_PRODUTO);
  });

  it('impostoCategoria: wrong-scoped doc loses to null-scoped fallback', async () => {
    const wrongScope = categoriaDoc('cat-7', CSOSN_PRODUTO, `operacao/${OTHER_OPERACAO}`);
    const fallback = categoriaDoc('cat-7', CSOSN_CATEGORIA, null);
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
      readImpostoCategoriaSubcoll: vi.fn().mockResolvedValue([wrongScope, fallback]),
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_CATEGORIA);
  });
});

describe('resolver fidelity — categoriaProdutoOuterRef shape tolerance', () => {
  // The Flutter side serialises outer refs as either a doc path string
  // (modern) or a DocumentReference-shaped `{ path }` object (legacy).
  // `parseCategoriaUid` accepts both.

  it('accepts string-shaped categoriaProdutoOuterRef', async () => {
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
      readImpostoCategoriaSubcoll: vi
        .fn()
        .mockResolvedValue([categoriaDoc('cat-7', CSOSN_CATEGORIA)]),
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_CATEGORIA);
    expect(deps.readImpostoCategoriaSubcoll).toHaveBeenCalledWith('cat-7');
  });

  it('accepts DocumentReference-shaped categoriaProdutoOuterRef', async () => {
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({
        categoriaProdutoOuterRef: { path: 'categorias/cat-7' },
      }),
      readImpostoCategoriaSubcoll: vi
        .fn()
        .mockResolvedValue([categoriaDoc('cat-7', CSOSN_CATEGORIA)]),
    });
    const out = await createImpostoResolver(deps).resolve('P-1', null);
    expect(out?.configuracaoICMS?.csosn).toBe(CSOSN_CATEGORIA);
    expect(deps.readImpostoCategoriaSubcoll).toHaveBeenCalledWith('cat-7');
  });
});

describe('resolver fidelity — round-trip into buildImpostoXml', () => {
  /**
   * The resolver's output must be consumable by the tribute engine —
   * the per-item `<imposto>` XML emitter. Pick a realistic stacked
   * scenario, resolve it, feed the result into `buildImpostoXml`, and
   * assert the emitted fragment matches the resolved CSOSN.
   */
  it('item-stamped resolution serialises into <ICMSSN102> via buildImpostoXml', async () => {
    const deps = makeDeps({
      // The other levels seeded would lose to item-stamped, but exercise
      // the stack to prove fidelity is preserved from top of cascade
      // through to wire XML.
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([produtoDoc('P-1', CSOSN_PRODUTO)]),
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [regraDoc({ produtos: ['P-1'] }, CSOSN_REGRA)],
      },
    });
    const imposto = await createImpostoResolver(deps).resolve('P-1', itemImposto());
    expect(imposto).not.toBeNull();
    const xml = buildImpostoXml(imposto!, { vProd: 100 });
    expect(xml).toContain('<ICMSSN102>');
    expect(xml).toContain('<CSOSN>102</CSOSN>');
    expect(xml).toContain('<orig>0</orig>');
    expect(xml).toContain('<PIS>');
    expect(xml).toContain('<COFINS>');
  });

  it('impostoProduto resolution (CSOSN 101) round-trips to <ICMSSN101> with the credit fields', async () => {
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([produtoDoc('P-1', CSOSN_PRODUTO)]),
    });
    const imposto = await createImpostoResolver(deps).resolve('P-1', null);
    expect(imposto).not.toBeNull();
    const xml = buildImpostoXml(imposto!, { vProd: 1500 });
    expect(xml).toContain('<ICMSSN101>');
    expect(xml).toContain('<CSOSN>101</CSOSN>');
    expect(xml).toContain('<pCredSN>1.2500</pCredSN>');
    expect(xml).toContain('<vCredICMSSN>18.75</vCredICMSSN>');
  });

  it('regraImposto resolution (CSOSN 300) round-trips to <ICMSSN102> (the 300/400 path)', async () => {
    // CSOSN 102/103/300/400 all dispatch to <ICMSSN102> per the tribute
    // engine — the wire shape is the same (orig + CSOSN only).
    const deps = makeDeps({
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [regraDoc({ produtos: ['P-1'] }, CSOSN_REGRA)],
      },
    });
    const imposto = await createImpostoResolver(deps).resolve('P-1', null);
    expect(imposto).not.toBeNull();
    const xml = buildImpostoXml(imposto!, { vProd: 100 });
    expect(xml).toContain('<ICMSSN102>');
    expect(xml).toContain('<CSOSN>300</CSOSN>');
  });
});
