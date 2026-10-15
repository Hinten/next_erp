import { describe, expect, it, vi } from 'vitest';

import {
  impostoCategoriaSchema,
  impostoProdutoSchema,
  impostoSchema,
  regraImpostoSchema,
  type ImpostoCategoria,
  type ImpostoProduto,
  type RegraImposto,
} from '@delfrance/schemas';

import {
  createImpostoResolver,
  type ImpostoResolverDeps,
  type ResolverBundle,
} from './resolverImposto';

/**
 * What this file covers, and what it deliberately does NOT.
 *
 * The five-tier cascade's behaviour is pinned by the 725-line
 * `apps/nfe/test/lib/nfe/imposto-resolver.test.ts` and its fidelity twin, which
 * this promotion left BYTE-UNEDITED — that is the proof the move changed
 * nothing. Re-typing those 725 lines here would be exactly the second copy the
 * promotion exists to prevent.
 *
 * So this suite covers what the MOVE could break and what a caller outside
 * `apps/nfe` now depends on: that the core resolves against `@delfrance/schemas`
 * alone (the E1 import edit), and the two FOLDS the cascade is built from —
 * `pickByOperacao`'s scope preference (#222) and `trailingSegment`'s last-segment
 * rule (#398). Both folds are private, so each is exercised through the tier
 * that uses it, with a pair that must come out EQUAL and a near-miss that must
 * stay DISTINCT.
 */

const ACTIVE_OPERACAO = 'op-active';

/** Minimal valid Imposto blob — `origem` is required, so a bare NCM is invalid. */
const VALID_IMPOSTO_BLOB = {
  origem: '0',
  configuracaoICMS: { crt: '1', csosn: '102' },
} as const;

/** A second, distinguishable blob — the csosn is what every assertion reads. */
const BLOB_400 = {
  origem: '0',
  configuracaoICMS: { crt: '1', csosn: '400' },
} as const;

function impostoProdutoDoc(over: Record<string, unknown> = {}): ImpostoProduto {
  return impostoProdutoSchema.parse({
    id: 'doc-1',
    impostoOpercaoOuterRef: null,
    ...VALID_IMPOSTO_BLOB,
    ...over,
  });
}

function impostoCategoriaDoc(over: Record<string, unknown> = {}): ImpostoCategoria {
  return impostoCategoriaSchema.parse({
    id: 'cat-1',
    impostoCategoriaOperacaoOuterRef: null,
    ...VALID_IMPOSTO_BLOB,
    ...over,
  });
}

function regraDoc(over: Record<string, unknown> = {}): RegraImposto {
  return regraImpostoSchema.parse({
    id: 'regra-1',
    produtos: [],
    categorias: [],
    ncms: [],
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

describe('createImpostoResolver — o núcleo promovido resolve as cinco camadas', () => {
  it('o imposto carimbado no item vence e NÃO paga leitura nenhuma', async () => {
    const deps = makeDeps();
    const out = await createImpostoResolver(deps).resolve('p1', VALID_IMPOSTO_BLOB);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(deps.readImpostoProdutoSubcoll).not.toHaveBeenCalled();
    expect(deps.readProduto).not.toHaveBeenCalled();
  });

  it('cai para impostoProduto quando o item não traz imposto', async () => {
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([impostoProdutoDoc()]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
    expect(deps.readImpostoProdutoSubcoll).toHaveBeenCalledWith('p1');
  });

  it('cai para impostoCategoria pelo categoriaProdutoOuterRef do produto', async () => {
    const deps = makeDeps({
      readProduto: vi.fn().mockResolvedValue({ categoriaProdutoOuterRef: 'categorias/cat-7' }),
      readImpostoCategoriaSubcoll: vi.fn().mockResolvedValue([impostoCategoriaDoc(BLOB_400)]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('400');
    expect(deps.readImpostoCategoriaSubcoll).toHaveBeenCalledWith('cat-7');
  });

  it('cai para a regra da operação quando ela cita o produto', async () => {
    const deps = makeDeps({
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [regraDoc({ produtos: ['p1'], ...BLOB_400 })],
      },
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('400');
  });

  it('cai para o default da própria operação (tier 5) quando nada mais casa', async () => {
    const deps = makeDeps({
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [],
        operacao: { nome: 'Venda', tipo: 'saida', ...BLOB_400 },
      },
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    // A operação carrega campos que NÃO são do Imposto (`nome`, `tipo`); o tier
    // os descarta via impostoSchema em vez de recusar o documento inteiro.
    expect(out?.configuracaoICMS?.csosn).toBe('400');
    expect(out).not.toHaveProperty('nome');
  });

  it('nada casa em nenhuma das cinco camadas ⇒ null', async () => {
    const out = await createImpostoResolver(makeDeps()).resolve('p1', null);
    expect(out).toBeNull();
  });

  it('o Imposto resolvido satisfaz impostoSchema de @delfrance/schemas (a edição E1 do import)', async () => {
    // O núcleo promovido importa `impostoSchema` de @delfrance/schemas, onde ele
    // é DEFINIDO — nunca do pacote de integração da NF-e, que apenas o
    // re-exporta e do qual packages/data não pode depender.
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([impostoProdutoDoc()]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(() => impostoSchema.parse(out)).not.toThrow();
  });
});

describe('pickByOperacao — o fold do escopo da operação (#222)', () => {
  it('PAR: dois refs de duas partes terminando no mesmo id casam a MESMA operação — só o ÚLTIMO segmento conta', async () => {
    for (const ref of [`operacao/${ACTIVE_OPERACAO}`, `regras/${ACTIVE_OPERACAO}`]) {
      const deps = makeDeps({
        readImpostoProdutoSubcoll: vi
          .fn()
          .mockResolvedValue([impostoProdutoDoc({ id: 'exato', impostoOpercaoOuterRef: ref })]),
      });
      const out = await createImpostoResolver(deps).resolve('p1', null);
      expect(out?.configuracaoICMS?.csosn, `ref '${ref}'`).toBe('102');
    }
  });

  it('⛔ ESCOPO: um id NU nunca chega a este fold — idRefSchema recusa "op-active" na escrita', async () => {
    // `trailingSegment` aceita três formas (`p1`, `produtos/p1`,
    // `documents/produtos/p1`), mas nas DUAS camadas de subcoleção o ref de
    // escopo é `idRefSchema` — exatamente `coleção/id`, nunca um id nu e nunca
    // com o prefixo `documents/`. Ou seja: a tolerância do fold é MAIOR do que
    // o corpus que o alimenta, e as duas formas extras só são alcançáveis pelos
    // arrays da regra (`z.array(z.string())`), testados abaixo. Um teste que
    // só mostrasse que o fold APLICA não diria onde ele PARA.
    for (const ref of [ACTIVE_OPERACAO, `documents/operacao/${ACTIVE_OPERACAO}`]) {
      const parsed = impostoProdutoSchema.safeParse({
        id: 'x',
        impostoOpercaoOuterRef: ref,
        ...VALID_IMPOSTO_BLOB,
      });
      expect(parsed.success, `ref '${ref}'`).toBe(false);
    }
    expect(
      impostoCategoriaSchema.safeParse({
        id: 'x',
        impostoCategoriaOperacaoOuterRef: ACTIVE_OPERACAO,
        ...VALID_IMPOSTO_BLOB,
      }).success,
    ).toBe(false);
  });

  it('PAR: um match EXATO por operação vence o default de escopo nulo, mesmo aparecendo DEPOIS dele', async () => {
    // O default vem PRIMEIRO no array; um `.find()` que aceitasse os dois
    // devolveria ele. A sobreposição por operação tem de ganhar.
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi
        .fn()
        .mockResolvedValue([
          impostoProdutoDoc({ id: 'default', impostoOpercaoOuterRef: null, ...BLOB_400 }),
          impostoProdutoDoc({ id: 'exato', impostoOpercaoOuterRef: `operacao/${ACTIVE_OPERACAO}` }),
        ]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('102');
  });

  it('⛔ QUASE-IGUAL: uma operação cujo id apenas COMEÇA igual não casa — cai no default de escopo nulo', async () => {
    // `op-active-2` compartilha o prefixo com `op-active`. O fold é igualdade
    // exata do último segmento, não um prefixo: o doc exato NÃO participa e o
    // default (400) responde. Um fold por prefixo devolveria 102 aqui.
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi.fn().mockResolvedValue([
        impostoProdutoDoc({ id: 'default', impostoOpercaoOuterRef: null, ...BLOB_400 }),
        impostoProdutoDoc({
          id: 'outra-operacao',
          impostoOpercaoOuterRef: `operacao/${ACTIVE_OPERACAO}-2`,
        }),
      ]),
    });
    const out = await createImpostoResolver(deps).resolve('p1', null);
    expect(out?.configuracaoICMS?.csosn).toBe('400');
  });

  it('⛔ QUASE-IGUAL: um doc de OUTRA operação, sozinho, não é um default — nada resolve', async () => {
    const deps = makeDeps({
      readImpostoProdutoSubcoll: vi
        .fn()
        .mockResolvedValue([impostoProdutoDoc({ impostoOpercaoOuterRef: 'operacao/op-other' })]),
    });
    expect(await createImpostoResolver(deps).resolve('p1', null)).toBeNull();
  });
});

describe('trailingSegment — o fold do último segmento (#398)', () => {
  it('PAR: "p1", "produtos/p1" e "documents/produtos/p1" casam o MESMO produto', async () => {
    for (const entrada of ['p1', 'produtos/p1', 'documents/produtos/p1']) {
      const deps = makeDeps({
        bundle: {
          operacaoId: ACTIVE_OPERACAO,
          regrasImposto: [regraDoc({ produtos: [entrada], ...BLOB_400 })],
        },
      });
      const out = await createImpostoResolver(deps).resolve('p1', null);
      expect(out?.configuracaoICMS?.csosn, `entrada '${entrada}'`).toBe('400');
    }
  });

  it('⛔ QUASE-IGUAL: "p1/x" casa o produto "x" e NUNCA "p1" — o fold toma o ÚLTIMO segmento', async () => {
    const regra = regraDoc({ produtos: ['p1/x'], ...BLOB_400 });
    const bundle: ResolverBundle = { operacaoId: ACTIVE_OPERACAO, regrasImposto: [regra] };

    const casa = await createImpostoResolver(makeDeps({ bundle })).resolve('x', null);
    expect(casa?.configuracaoICMS?.csosn).toBe('400');

    const naoCasa = await createImpostoResolver(makeDeps({ bundle })).resolve('p1', null);
    expect(naoCasa).toBeNull();
  });
});

describe('o memo por produto', () => {
  it('duas resoluções do mesmo produto pagam UMA leitura da subcoleção', async () => {
    const readImpostoProdutoSubcoll = vi.fn().mockResolvedValue([impostoProdutoDoc()]);
    const resolver = createImpostoResolver(makeDeps({ readImpostoProdutoSubcoll }));
    await resolver.resolve('p1', null);
    await resolver.resolve('p1', null);
    expect(readImpostoProdutoSubcoll).toHaveBeenCalledTimes(1);
  });

  it('⛔ QUASE-IGUAL: dois carimbos INVÁLIDOS com NCMs diferentes não compartilham o memo', async () => {
    // O NCM do carimbo inválido dirige a camada das regras, então ele participa
    // da chave do memo. Uma chave só com o produtoUid devolveria a MESMA regra
    // para os dois itens — silenciosamente.
    const deps = makeDeps({
      bundle: {
        operacaoId: ACTIVE_OPERACAO,
        regrasImposto: [
          regraDoc({ id: 'r-a', ncms: ['11111111'] }),
          regraDoc({ id: 'r-b', ncms: ['22222222'], ...BLOB_400 }),
        ],
      },
    });
    const resolver = createImpostoResolver(deps);
    const a = await resolver.resolve('p1', { NCM: '11111111' });
    const b = await resolver.resolve('p1', { NCM: '22222222' });
    expect(a?.configuracaoICMS?.csosn).toBe('102');
    expect(b?.configuracaoICMS?.csosn).toBe('400');
  });
});
