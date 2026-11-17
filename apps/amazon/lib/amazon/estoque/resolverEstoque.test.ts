/**
 * The Firestore half of the link verdict, against the fake db (which refuses
 * any query shape but the declared indexes, and — opted in here — any read of
 * a link doc or a produto without a field mask): the order import's binding
 * read through its own pieces, every read masked, the refusal-4 reader, the
 * pointers deduplicated, the reads a refusal skips, and the index pin NEXT TO
 * the children seek.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';
import { produtoAmazonLinkCollection } from '@delfrance/data/admin/collections';
import { CAMPOS_INDICE_VINCULO_AMAZON } from '@delfrance/schemas';

import {
  CAMPOS_UNIDADE_DO_DONO_AMAZON,
  FALHA_VINCULO_AMAZON,
  LIMITE_VINCULOS_AMAZON,
  criarResolvedorDeVinculosAmazon,
  lerDonosAmazon,
  lerVinculosDoSkuAmazon,
  resolucaoPorUnidadesAmazon,
} from '../pedidos/vinculoProdutoAmazon';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON,
  CAMPOS_LEITURA_DONOS_ESTOQUE_AMAZON,
  CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON,
  lerFilhosDaUnidadeEstoqueAmazon,
  lerPaisDosLinksEstoqueAmazon,
  lerVinculoEstoqueAmazon,
} from './resolverEstoque';
import {
  CAMPOS_DONO_ESTOQUE_AMAZON,
  CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON,
  CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON,
  LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON,
  avaliarVinculoEstoqueAmazon,
} from './vinculoEstoque';

const CONTA = 'conta-1';
const CANONICA = `documents/integracao/${CONTA}`;
const NUA = `integracao/${CONTA}`;
const SKU = 'SKU-1';

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

/**
 * Every read of a link doc or a produto must be masked: a link doc carries a
 * whole product payload, and Enterprise bills the data a read returns.
 */
function exigirMascaras(): void {
  db.exigirMascaraEm('prodAmazon');
  db.exigirMascaraEm('produtos');
}

function produto(id: string, dados: Record<string, unknown> = {}) {
  db.seed(`produtos/${id}`, { nome: `Produto ${id}`, ...dados });
}

/** A link doc under `produtoId` naming the conta and the SKU, with a heavy payload. */
function vinculo(
  produtoId: string,
  docId: string,
  dados: Record<string, unknown> = {},
  conta = CANONICA,
) {
  db.seed(`produtos/${produtoId}/prodAmazon/${docId}`, {
    contaAmazonOuterRef: conta,
    sku: SKU,
    asin: 'B0ZZFILHO1',
    productDataJson: { pesado: 'x'.repeat(64) },
    issues: [],
    ...dados,
  });
}

const ler = () => lerVinculoEstoqueAmazon(asDb(db), CONTA, SKU);

describe('★ the masks: every read carries only its listed fields', () => {
  it('the link query projects to the index’s fields plus the verdict’s, and no other field comes back', async () => {
    exigirMascaras();
    produto('P');
    vinculo('P', 'l1');
    const e = await ler();
    expect(db.consultas[0]).toMatchObject({
      colecao: 'prodAmazon',
      grupo: true,
      limite: LIMITE_VINCULOS_AMAZON,
      selecao: [...CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON],
    });
    expect(e.linksDoSku).toHaveLength(1);
    expect(Object.keys(e.linksDoSku[0]?.dados ?? {}).sort()).toEqual(
      ['asin', 'contaAmazonOuterRef', 'sku'].sort(),
    );
    expect(e.linksDoSku[0]?.dados.productDataJson).toBeUndefined();
  });

  it('the link fields ARE the index’s two and the verdict’s three, in that order', () => {
    expect([...CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON]).toEqual([
      'contaAmazonOuterRef',
      'sku',
      'asin',
      'produtoAmazonPaiOuterRef',
      'envioEstoqueAmazon',
    ]);
    expect(CAMPOS_LEITURA_VINCULOS_ESTOQUE_AMAZON.slice(0, 2)).toEqual([
      ...CAMPOS_INDICE_VINCULO_AMAZON,
    ]);
  });

  it('the donos are read in ONE getAll masked to the hop’s fields and the verdict’s; the unit’s fields are among them', async () => {
    exigirMascaras();
    produto('P', { statusProdutosMarketplace: {}, componentesKit: { x: 1 }, precos: { a: 1 } });
    vinculo('P', 'l1');
    const e = await ler();
    const dono = db.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/P');
    expect(dono).toEqual([
      {
        caminho: 'produtos/P',
        via: 'getAll',
        chamada: 1,
        mascara: CAMPOS_LEITURA_DONOS_ESTOQUE_AMAZON,
      },
    ]);
    expect([...CAMPOS_LEITURA_DONOS_ESTOQUE_AMAZON]).toEqual([
      ...CAMPOS_UNIDADE_DO_DONO_AMAZON,
      ...CAMPOS_DONO_ESTOQUE_AMAZON,
    ]);
    for (const campo of CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON) {
      expect(CAMPOS_LEITURA_DONOS_ESTOQUE_AMAZON, campo).toContain(campo);
    }
    expect(e.dono?.raw).toEqual({ statusProdutosMarketplace: {} });
  });

  it('the parent pointers are read masked to sku and asin; the unit masked to its three fields', async () => {
    exigirMascaras();
    produto('W', { paiId: null, filhoUnicoId: 'M' });
    produto('M', { paiId: 'W', ehKit: false, pesado: 'x' });
    produto('PAI');
    vinculo('PAI', 'lp', { sku: 'SKU-PAI', asin: 'B0ZZPAI001', productDataJson: { y: 1 } });
    vinculo('W', 'l1', { produtoAmazonPaiOuterRef: 'documents/produtos/PAI/prodAmazon/lp' });
    const e = await ler();
    expect(
      db.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/PAI/prodAmazon/lp'),
    ).toMatchObject([{ via: 'getAll', mascara: [...CAMPOS_PAI_DO_VINCULO_ESTOQUE_AMAZON] }]);
    expect(e.paisDosLinks.get('produtos/PAI/prodAmazon/lp')).toEqual({
      sku: 'SKU-PAI',
      asin: 'B0ZZPAI001',
    });
    expect(db.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/M')).toMatchObject([
      { via: 'getAll', mascara: [...CAMPOS_UNIDADE_VINCULO_ESTOQUE_AMAZON] },
    ]);
    expect(e.unidade.raw).toEqual({ paiId: 'W', ehKit: false });
  });

  it('★ NEAR-MISS: an UNMASKED getAll of a link doc reds under the same opt-in', async () => {
    exigirMascaras();
    vinculo('P', 'l1');
    const ref = produtoAmazonLinkCollection.docRef(asDb(db), { produtoId: 'P' }, 'l1');
    expect(() => db.getAll(ref)).toThrow(/sem máscara/);
    // …and the order import's own read (whole docs) is exactly what the opt-in refuses.
    await expect(criarResolvedorDeVinculosAmazon(asDb(db), CONTA).resolver(SKU)).rejects.toThrow(
      /sem select/,
    );
  });
});

describe('★ the binding is the order import’s', () => {
  /** Seeds, then the stock resolver’s resolution and the order import’s, side by side. */
  async function ambas(seed: () => void) {
    seed();
    const estoque = (await ler()).resolucao;
    const importacao = await criarResolvedorDeVinculosAmazon(asDb(db), CONTA).resolver(SKU);
    return { estoque, importacao };
  }

  it.each<[string, () => void]>([
    [
      'one dono',
      () => {
        produto('P');
        vinculo('P', 'l1');
      },
    ],
    [
      'two docs under one dono',
      () => {
        produto('P');
        vinculo('P', 'l1');
        vinculo('P', 'l2', {}, NUA);
      },
    ],
    [
      'two live donos',
      () => {
        produto('P');
        produto('Q');
        vinculo('P', 'l1');
        vinculo('Q', 'l2');
      },
    ],
    [
      'two donos hopping to one unit',
      () => {
        produto('W', { paiId: null, filhoUnicoId: 'M' });
        produto('M', { paiId: 'W' });
        vinculo('W', 'l1');
        vinculo('M', 'l2');
      },
    ],
    [
      'a gone dono beside a live one',
      () => {
        produto('Q');
        vinculo('P', 'l1');
        vinculo('Q', 'l2');
      },
    ],
    ['every dono gone', () => vinculo('P', 'l1')],
    ['no link at all', () => produto('P', { sku: SKU })],
    [
      'another conta’s link',
      () => {
        produto('P');
        vinculo('P', 'l1', {}, 'documents/integracao/c2');
      },
    ],
    [
      'a family-of-one wrapper',
      () => {
        produto('W', { paiId: null, filhoUnicoId: 'M' });
        produto('M', { paiId: 'W' });
        vinculo('W', 'l1');
      },
    ],
    [
      'a kit root with its mirror',
      () => {
        produto('K', { ehKit: true, paiId: null, filhoUnicoId: 'KM' });
        produto('KM', { paiId: 'K' });
        vinculo('K', 'l1');
      },
    ],
    [
      `the limit (${String(LIMITE_VINCULOS_AMAZON)} docs) reached`,
      () => {
        produto('P');
        for (let i = 0; i < LIMITE_VINCULOS_AMAZON; i += 1) vinculo('P', `l${String(i)}`);
      },
    ],
  ])('%s ⇒ the SAME resolution as the order import', async (_c, seed) => {
    const { estoque, importacao } = await ambas(seed);
    expect(estoque).toEqual(importacao);
  });

  it('the dono count, pure: none ⇒ unresolved; one ⇒ bound; two (even one unit twice) ⇒ ambiguous', () => {
    expect(resolucaoPorUnidadesAmazon([])).toEqual({ produtoId: null, via: 'unresolved' });
    expect(resolucaoPorUnidadesAmazon(['U'])).toEqual({ produtoId: 'U', via: 'vinculo-amazon' });
    expect(resolucaoPorUnidadesAmazon(['U', 'U'])).toEqual({
      produtoId: null,
      via: FALHA_VINCULO_AMAZON.ambiguo,
    });
    expect(resolucaoPorUnidadesAmazon(['U', 'V', 'X'])).toMatchObject({ produtoId: null });
  });
});

describe('the reads a resolution without a unit never makes', () => {
  it('★ the limit reached ⇒ ambiguous after ONE query: no dono, unit, child or parent read', async () => {
    produto('P');
    for (let i = 0; i < LIMITE_VINCULOS_AMAZON; i += 1) {
      vinculo('P', `l${String(i)}`, { produtoAmazonPaiOuterRef: 'produtos/X/prodAmazon/y' });
    }
    const e = await ler();
    expect(e.resolucao).toEqual({ produtoId: null, via: FALHA_VINCULO_AMAZON.ambiguo });
    expect(e.dono).toBeNull();
    expect(e.linksDoSku).toEqual([]);
    expect(db.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 1, escritas: 0 });
    expect(avaliarVinculoEstoqueAmazon(e)).toEqual({ apto: false, motivo: 'vinculo-ambiguo' });
  });

  it('NEAR-MISS: one under the limit binds and goes on reading', async () => {
    produto('P');
    for (let i = 0; i < LIMITE_VINCULOS_AMAZON - 1; i += 1) vinculo('P', `l${String(i)}`);
    const e = await ler();
    expect(e.resolucao).toEqual({ produtoId: 'P', via: 'vinculo-amazon' });
    expect(e.linksDoSku).toHaveLength(LIMITE_VINCULOS_AMAZON - 1);
  });

  it('two live donos ⇒ ambiguous after the query and the donos’ read, nothing more', async () => {
    produto('P');
    produto('Q');
    vinculo('P', 'l1', { produtoAmazonPaiOuterRef: 'produtos/X/prodAmazon/y' });
    vinculo('Q', 'l2');
    const e = await ler();
    expect(e.dono).toBeNull();
    expect(db.contagem).toEqual({ leituras: 2, chamadasGetAll: 1, consultas: 1, escritas: 0 });
    expect(avaliarVinculoEstoqueAmazon(e)).toEqual({ apto: false, motivo: 'vinculo-ambiguo' });
  });

  it('no link ⇒ unresolved after ONE query, no dono read', async () => {
    const e = await ler();
    expect(e.resolucao).toEqual({ produtoId: null, via: 'unresolved' });
    expect(db.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 1, escritas: 0 });
    expect(avaliarVinculoEstoqueAmazon(e)).toEqual({ apto: false, motivo: 'produto-ausente' });
  });

  it('every dono gone ⇒ unresolved, no unit, child or parent read', async () => {
    vinculo('P', 'l1', { produtoAmazonPaiOuterRef: 'produtos/X/prodAmazon/y' });
    const e = await ler();
    expect(e.resolucao).toEqual({ produtoId: null, via: 'unresolved' });
    expect(db.contagem).toEqual({ leituras: 1, chamadasGetAll: 1, consultas: 1, escritas: 0 });
  });
});

describe('★ the cost of an apt SKU', () => {
  it('a simple produto: the query, ONE dono read and the children seek — the unit is the dono, no pointer', async () => {
    exigirMascaras();
    produto('P');
    vinculo('P', 'l1');
    const e = await ler();
    expect(db.contagem).toEqual({ leituras: 1, chamadasGetAll: 1, consultas: 2, escritas: 0 });
    expect(db.leituras).toEqual(['produtos/P']);
    expect(e.unidade).toEqual({ raw: {}, filhosIds: [] });
    expect(avaliarVinculoEstoqueAmazon(e)).toMatchObject({ apto: true, unidadeId: 'P' });
  });

  it('NEAR-MISS: a family-of-one wrapper costs ONE more read, its member’s', async () => {
    exigirMascaras();
    produto('W', { paiId: null, filhoUnicoId: 'M' });
    produto('M', { paiId: 'W' });
    vinculo('W', 'l1');
    const e = await ler();
    expect(db.contagem).toEqual({ leituras: 2, chamadasGetAll: 2, consultas: 2, escritas: 0 });
    // The children sought are the UNIT’s (the member’s), never the wrapper’s.
    expect(db.consultas[1]?.filtros).toEqual([['paiId', 'M']]);
    expect(avaliarVinculoEstoqueAmazon(e)).toMatchObject({
      apto: true,
      unidadeId: 'M',
      donoId: 'W',
    });
  });
});

describe('★ refusal 4’s reader: the unit’s children, by id', () => {
  it('a KIT root with its one mirror child ⇒ filhosIds of length 1, and the verdict is apt (the kit publishes)', async () => {
    exigirMascaras();
    produto('K', { ehKit: true, paiId: null, filhoUnicoId: 'KM' });
    produto('KM', { paiId: 'K', nome: 'Espelho' });
    vinculo('K', 'l1');
    const e = await ler();
    expect(e.unidade).toEqual({
      raw: { ehKit: true, paiId: null, filhoUnicoId: 'KM' },
      filhosIds: ['KM'],
    });
    expect(avaliarVinculoEstoqueAmazon(e)).toMatchObject({ apto: true, unidadeId: 'K' });
  });

  it('NEAR-MISS: when the unit IS the dono, the unit is handed its three fields only — never the dono’s opt-out map', async () => {
    exigirMascaras();
    produto('K', {
      ehKit: true,
      paiId: null,
      filhoUnicoId: 'KM',
      statusProdutosMarketplace: { 'outra-conta': { enviarEstoque: true } },
    });
    produto('KM', { paiId: 'K', nome: 'Espelho' });
    vinculo('K', 'l1');
    const e = await ler();
    expect(e.dono?.raw).toHaveProperty('statusProdutosMarketplace');
    expect(e.unidade.raw).toEqual({ ehKit: true, paiId: null, filhoUnicoId: 'KM' });
    // ONE produto read: the unit's fields came off the dono's own masked read.
    expect(db.contagem.chamadasGetAll).toBe(1);
  });

  it('★ NEAR-MISS: two children ⇒ BOTH ids returned (a limit of 1 would hide the second), and the verdict refuses', async () => {
    produto('K', { ehKit: true, paiId: null, filhoUnicoId: 'KM' });
    produto('KM', { paiId: 'K', nome: 'A espelho' });
    produto('KV', { paiId: 'K', nome: 'B variação' });
    vinculo('K', 'l1');
    const e = await ler();
    expect([...e.unidade.filhosIds].sort()).toEqual(['KM', 'KV']);
    expect(avaliarVinculoEstoqueAmazon(e)).toEqual({
      apto: false,
      motivo: 'unidade-com-variacoes',
    });
  });

  it('the seek: paiId == <unit>, ordered by nome, at most two, the keys alone', async () => {
    for (const id of ['a', 'b', 'c']) produto(id, { paiId: 'U', nome: id });
    await expect(lerFilhosDaUnidadeEstoqueAmazon(asDb(db), 'U')).resolves.toEqual(['a', 'b']);
    expect(db.consultas.at(-1)).toEqual({
      colecao: 'produtos',
      filtros: [['paiId', 'U']],
      ordens: [['nome', 'asc']],
      limite: LIMITE_FILHOS_UNIDADE_ESTOQUE_AMAZON,
      apos: null,
      selecao: [],
    });
  });

  it('a childless non-kit unit ⇒ no children, apt; a non-kit unit with one child ⇒ refused', async () => {
    produto('P');
    vinculo('P', 'l1');
    expect(avaliarVinculoEstoqueAmazon(await ler()).apto).toBe(true);
    produto('F', { paiId: 'P' });
    expect(avaliarVinculoEstoqueAmazon(await ler())).toEqual({
      apto: false,
      motivo: 'unidade-com-variacoes',
    });
  });
});

describe('the parent pointers', () => {
  it('★ deduplicated: two links naming one parent, in both stored forms, are ONE read of ONE ref', async () => {
    produto('P');
    produto('PAI');
    vinculo('PAI', 'lp', { sku: 'SKU-PAI', asin: 'B0ZZPAI001' });
    vinculo('P', 'l1', { produtoAmazonPaiOuterRef: 'documents/produtos/PAI/prodAmazon/lp' });
    vinculo('P', 'l2', { produtoAmazonPaiOuterRef: 'produtos/PAI/prodAmazon/lp' }, NUA);
    const e = await ler();
    const pais = db.leiturasDetalhadas.filter((l) => l.caminho.includes('/prodAmazon/'));
    expect(pais.map((l) => l.caminho)).toEqual(['produtos/PAI/prodAmazon/lp']);
    expect([...e.paisDosLinks.keys()]).toEqual(['produtos/PAI/prodAmazon/lp']);
    expect(avaliarVinculoEstoqueAmazon(e)).toMatchObject({ apto: true, linkIds: ['l1', 'l2'] });
  });

  it('a pointer naming a missing doc reads "sumido"; the verdict refuses it', async () => {
    produto('P');
    vinculo('P', 'l1', { produtoAmazonPaiOuterRef: 'produtos/NADA/prodAmazon/x' });
    const e = await ler();
    expect(e.paisDosLinks.get('produtos/NADA/prodAmazon/x')).toBe('sumido');
    expect(avaliarVinculoEstoqueAmazon(e)).toEqual({
      apto: false,
      motivo: 'pai-do-vinculo-ilegivel',
    });
  });

  it('a parent carrying THIS SKU ⇒ the verdict refuses filho-com-sku-do-pai', async () => {
    produto('P');
    produto('PAI');
    vinculo('PAI', 'lp');
    vinculo('P', 'l1', { produtoAmazonPaiOuterRef: 'produtos/PAI/prodAmazon/lp' });
    // The parent's own link names the conta and the SKU too: a second live dono.
    expect((await ler()).resolucao.produtoId).toBeNull();
    db.seed('produtos/PAI/prodAmazon/lp', { sku: SKU, asin: 'B0ZZPAI001' });
    expect(avaliarVinculoEstoqueAmazon(await ler())).toEqual({
      apto: false,
      motivo: 'filho-com-sku-do-pai',
    });
  });

  it('an unreadable pointer, or none, is never read; with no readable pointer there is no parent read at all', async () => {
    produto('P');
    vinculo('P', 'l1', { produtoAmazonPaiOuterRef: 'lixo' });
    vinculo('P', 'l2', { produtoAmazonPaiOuterRef: null });
    const e = await ler();
    expect(db.leiturasDetalhadas.some((l) => l.caminho.includes('/prodAmazon/'))).toBe(false);
    expect(e.paisDosLinks.size).toBe(0);
    expect(avaliarVinculoEstoqueAmazon(e)).toEqual({
      apto: false,
      motivo: 'pai-do-vinculo-ilegivel',
    });
  });

  it('only the dono’s links’ pointers are read, never a gone dono’s', async () => {
    produto('P');
    vinculo('P', 'l1');
    vinculo('GONE', 'l9', { produtoAmazonPaiOuterRef: 'produtos/PAI/prodAmazon/lp' });
    await ler();
    expect(db.leiturasDetalhadas.some((l) => l.caminho.includes('/prodAmazon/'))).toBe(false);
  });

  it('lerPaisDosLinksEstoqueAmazon, alone: no readable pointer ⇒ no read; several ⇒ one getAll, sorted', async () => {
    const link = (linkId: string, ponteiro: unknown) => ({
      linkId,
      donoId: 'P',
      dados: { produtoAmazonPaiOuterRef: ponteiro },
    });
    await expect(lerPaisDosLinksEstoqueAmazon(asDb(db), [link('a', 'lixo')])).resolves.toEqual(
      new Map(),
    );
    expect(db.contagem.chamadasGetAll).toBe(0);
    db.seed('produtos/B/prodAmazon/b', { sku: 'S-B', asin: null, outro: 1 });
    const pais = await lerPaisDosLinksEstoqueAmazon(asDb(db), [
      link('x', 'produtos/B/prodAmazon/b'),
      link('y', 'documents/produtos/A/prodAmazon/a'),
      link('z', 'documents/produtos/B/prodAmazon/b'),
    ]);
    expect([...pais.entries()]).toEqual([
      ['produtos/A/prodAmazon/a', 'sumido'],
      ['produtos/B/prodAmazon/b', { sku: 'S-B', asin: null }],
    ]);
    expect(db.contagem.chamadasGetAll).toBe(1);
  });
});

describe('the step-5 pieces the resolver shares', () => {
  it('lerVinculosDoSkuAmazon without campos makes no projection (the order import’s read); with [] the keys alone', async () => {
    produto('P');
    vinculo('P', 'l1');
    const inteiro = await lerVinculosDoSkuAmazon(asDb(db), CONTA, SKU);
    expect(db.consultas.at(-1)).not.toHaveProperty('selecao');
    expect(inteiro).toMatchObject({ tipo: 'docs', docs: [{ linkId: 'l1', donoId: 'P' }] });
    expect(inteiro.tipo === 'docs' && inteiro.docs[0]?.dados.productDataJson).toBeTruthy();
    const chaves = await lerVinculosDoSkuAmazon(asDb(db), CONTA, SKU, { campos: [] });
    expect(db.consultas.at(-1)?.selecao).toEqual([]);
    expect(chaves).toEqual({ tipo: 'docs', docs: [{ linkId: 'l1', donoId: 'P', dados: {} }] });
  });

  it('a doc with no dono in its path counts toward the limit and is left out of the docs', async () => {
    db.seed('prodAmazon/solto', { contaAmazonOuterRef: CANONICA, sku: SKU });
    produto('P');
    vinculo('P', 'l1');
    const r = await lerVinculosDoSkuAmazon(asDb(db), CONTA, SKU);
    expect(r).toMatchObject({ tipo: 'docs', docs: [{ linkId: 'l1', donoId: 'P' }] });
    expect(r.tipo === 'docs' && r.docs).toHaveLength(1);
  });

  it('lerDonosAmazon: the hop’s fields are ALWAYS in the mask; a gone dono is null; unmasked without campos', async () => {
    produto('W', { paiId: null, filhoUnicoId: 'M', outro: 1 });
    const donos = await lerDonosAmazon(asDb(db), ['W', 'GONE'], { campos: ['outro'] });
    expect(db.leiturasDetalhadas.at(-1)?.mascara).toEqual([
      ...CAMPOS_UNIDADE_DO_DONO_AMAZON,
      'outro',
    ]);
    expect(donos).toEqual([
      { id: 'W', raw: { paiId: null, filhoUnicoId: 'M', outro: 1 }, unidadeId: 'M' },
      null,
    ]);
    await lerDonosAmazon(asDb(db), ['W']);
    expect(db.leiturasDetalhadas.at(-1)?.mascara).toBeNull();
    await expect(lerDonosAmazon(asDb(db), [])).resolves.toEqual([]);
    expect(db.contagem.chamadasGetAll).toBe(2);
  });
});

describe('★ the children seek’s fields ARE the declared COLLECTION index (root rule 1)', () => {
  function raizDoRepo(inicio: string): string {
    let dir = inicio;
    while (dir !== dirname(dir)) {
      if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
      dir = dirname(dir);
    }
    throw new Error('pnpm-workspace.yaml não encontrado');
  }
  const indices = (
    JSON.parse(
      readFileSync(
        resolve(raizDoRepo(dirname(fileURLToPath(import.meta.url))), 'firestore.indexes.json'),
        'utf8',
      ),
    ) as {
      indexes: {
        collectionGroup?: string;
        queryScope?: string;
        fields?: { fieldPath?: string; order?: string }[];
      }[];
    }
  ).indexes;

  it('the seek filters and orders on CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON, in that order', async () => {
    await lerFilhosDaUnidadeEstoqueAmazon(asDb(db), 'U');
    const [campoPai, campoOrdem] = CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON;
    expect(db.consultas.at(-1)?.filtros.map(([campo]) => campo)).toEqual([campoPai]);
    expect(db.consultas.at(-1)?.ordens).toEqual([[campoOrdem, 'asc']]);
  });

  it('exactly that entry exists: COLLECTION scope on produtos, the same fields in the same order, ASC', () => {
    const exato = indices.filter(
      (i) =>
        i.collectionGroup === 'produtos' &&
        i.queryScope === 'COLLECTION' &&
        JSON.stringify(i.fields) ===
          JSON.stringify(
            CAMPOS_INDICE_FILHOS_UNIDADE_ESTOQUE_AMAZON.map((fieldPath) => ({
              fieldPath,
              order: 'ASCENDING',
            })),
          ),
    );
    expect(exato).toHaveLength(1);
  });
});
