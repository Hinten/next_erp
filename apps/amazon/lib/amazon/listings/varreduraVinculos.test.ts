/**
 * The shared walk and page core on the counting fake db: the walk's query
 * shape and paging, the grouping, and the stateless smallest-path dedupe —
 * a SKU whose link docs straddle a page boundary is evaluated on exactly ONE
 * page and counted `ja-visto` on the other, for both flows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON } from '@delfrance/schemas';

import type { LeituraVinculosDoSkuAmazon } from '../pedidos/vinculoProdutoAmazon';
import { FakeDb, asDb } from '../testing/fakeDb';
import { FLUXO_LISTING_AMAZON, type FluxoListingAmazon } from './fluxoListing';
import {
  CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON,
  type CamposVinculoListingAmazon,
  camposDoResolverListingAmazon,
} from './resolverVinculo';
import {
  CAMPOS_VARREDURA_VINCULOS_AMAZON,
  CONTADOR_VARREDURA_VINCULOS_AMAZON,
  type CursoresVarreduraVinculosAmazon,
  PAGINA_VARREDURA_VINCULOS_AMAZON,
  agruparPaginaVarreduraVinculosAmazon,
  compararCaminhosVinculosAmazon,
  lerPaginaVarreduraVinculosAmazon,
  paginaAvaliaSkuVinculosAmazon,
  paginaVarreduraVinculosAmazon,
  varreduraVinculosConcluida,
} from './varreduraVinculos';

const CONTA = 'conta-varredura';
const CANONICA = `documents/integracao/${CONTA}`;
const NUA = `integracao/${CONTA}`;
const AGORA = 5_000_000;
const PRAZO = { agora: () => AGORA, prazoMs: AGORA + 60_000 };

/** Each flow's masks (price with no tabela: the walk reads links only). */
const CAMPOS: Readonly<Record<FluxoListingAmazon, CamposVinculoListingAmazon>> = {
  [FLUXO_LISTING_AMAZON.estoque]: camposDoResolverListingAmazon({
    fluxo: FLUXO_LISTING_AMAZON.estoque,
  }),
  [FLUXO_LISTING_AMAZON.preco]: camposDoResolverListingAmazon({
    fluxo: FLUXO_LISTING_AMAZON.preco,
    tabelaIds: [],
  }),
};

const INICIO: CursoresVarreduraVinculosAmazon = {
  canonica: { ultimoCaminho: null, concluida: false },
  nua: { ultimoCaminho: null, concluida: false },
};

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.exigirMascaraEm('prodAmazon');
});

function vinculo(produtoId: string, linkId: string, sku: unknown, conta = CANONICA) {
  db.seed(`produtos/${produtoId}/prodAmazon/${linkId}`, {
    contaAmazonOuterRef: conta,
    sku,
    productDataJson: { pesado: 'x'.repeat(32) },
    envioEstoqueAmazon: { emMs: 1 },
    envioPrecoAmazon: { emMs: 2 },
  });
}

/** 300 filler links between `produtos/a000` and `produtos/zzz`, each its own SKU. */
function semearPaginaCheia(): void {
  vinculo('a000', 'l', 'SKU-X');
  for (let i = 0; i < PAGINA_VARREDURA_VINCULOS_AMAZON; i += 1) {
    vinculo(`f${String(i).padStart(3, '0')}`, 'l', `SKU-F${String(i).padStart(3, '0')}`);
  }
  vinculo('zzz', 'l', 'SKU-X');
}

const pagina = (cursores: CursoresVarreduraVinculosAmazon, fluxo: FluxoListingAmazon) =>
  paginaVarreduraVinculosAmazon(asDb(db), CONTA, cursores, {
    campos: CAMPOS[fluxo],
    prazo: PRAZO,
  });

describe('★ the dedupe: a SKU straddling a page boundary is evaluated on exactly ONE page', () => {
  it.each([FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco])(
    '%s: the page of its smallest path evaluates it; the other counts it ja-visto',
    async (fluxo) => {
      semearPaginaCheia();
      const p1 = await pagina(INICIO, fluxo);
      if (p1.tipo !== 'pagina') throw new Error('a primeira página truncou');
      expect(p1.vinculos).toBe(PAGINA_VARREDURA_VINCULOS_AMAZON);
      expect(p1.skus).toContain('SKU-X');
      expect(p1.aAvaliar).toContain('SKU-X');
      expect(p1.porChave[CONTADOR_VARREDURA_VINCULOS_AMAZON.jaVisto]).toBeUndefined();
      expect(varreduraVinculosConcluida(p1.cursores)).toBe(false);

      const p2 = await pagina(p1.cursores, fluxo);
      if (p2.tipo !== 'pagina') throw new Error('a segunda página truncou');
      expect(p2.skus).toContain('SKU-X');
      expect(p2.aAvaliar).not.toContain('SKU-X');
      expect(p2.porChave[CONTADOR_VARREDURA_VINCULOS_AMAZON.jaVisto]).toBe(1);
      expect(varreduraVinculosConcluida(p2.cursores)).toBe(true);
      // Every SKU of the walk is evaluated exactly once over both pages.
      const avaliados = [...p1.aAvaliar, ...p2.aAvaliar];
      expect(avaliados.filter((s) => s === 'SKU-X')).toHaveLength(1);
      expect(new Set(avaliados).size).toBe(avaliados.length);
      expect(avaliados).toHaveLength(PAGINA_VARREDURA_VINCULOS_AMAZON + 1);
    },
  );

  it.each([FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco])(
    '%s: the dedupe reads each SKU’s links at the flow’s projection, and hands them on',
    async (fluxo) => {
      vinculo('p1', 'l', 'SKU-1');
      vinculo('p2', 'l', 'SKU-1', NUA);
      const p = await pagina(INICIO, fluxo);
      if (p.tipo !== 'pagina') throw new Error('truncou');
      const leitura = db.consultas.filter(
        (q) => q.colecao === 'prodAmazon' && q.filtros.some(([c]) => c === 'sku'),
      );
      expect(leitura.map((q) => q.selecao)).toEqual([
        [...CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON[fluxo]],
      ]);
      const lida = p.vinculosLidos.get('SKU-1');
      expect(lida?.tipo === 'docs' && lida.docs.map((d) => d.linkId)).toEqual(['l', 'l']);
      const dados = lida?.tipo === 'docs' ? (lida.docs[0]?.dados ?? {}) : {};
      const proprio =
        fluxo === FLUXO_LISTING_AMAZON.estoque ? 'envioEstoqueAmazon' : 'envioPrecoAmazon';
      const alheio =
        fluxo === FLUXO_LISTING_AMAZON.estoque ? 'envioPrecoAmazon' : 'envioEstoqueAmazon';
      expect(dados).toHaveProperty(proprio);
      expect(dados).not.toHaveProperty(alheio);
      expect(dados.productDataJson).toBeUndefined();
      // Both docs of SKU-1 are on this page: evaluated here, nothing counted.
      expect(p.aAvaliar).toEqual(['SKU-1']);
      expect(p.porChave).toEqual({});
    },
  );

  it('the page core hands the grouping’s counters on, before ja-visto', async () => {
    semearPaginaCheia();
    vinculo('b-sem-sku', 'l', '');
    db.seed('prodAmazon/solto', { contaAmazonOuterRef: CANONICA, sku: 'SKU-SOLTO' });
    const p1 = await pagina(INICIO, FLUXO_LISTING_AMAZON.preco);
    if (p1.tipo !== 'pagina') throw new Error('a primeira página truncou');
    expect(Object.entries(p1.porChave)).toEqual([
      [CONTADOR_VARREDURA_VINCULOS_AMAZON.foraDeProduto, 1],
      [CONTADOR_VARREDURA_VINCULOS_AMAZON.semSku, 1],
    ]);
    const p2 = await pagina(p1.cursores, FLUXO_LISTING_AMAZON.preco);
    if (p2.tipo !== 'pagina') throw new Error('a segunda página truncou');
    expect(Object.entries(p2.porChave)).toEqual([[CONTADOR_VARREDURA_VINCULOS_AMAZON.jaVisto, 1]]);
    expect(p1.skus).not.toContain('');
  });
});

describe('the smallest-path rule, pure', () => {
  const docs = (...caminhos: string[]): LeituraVinculosDoSkuAmazon => ({
    tipo: 'docs',
    docs: caminhos.map((c) => {
      const [, donoId = '', , linkId = ''] = c.split('/');
      return { linkId, donoId, dados: {} };
    }),
  });

  it('this page holds the smallest ⇒ evaluated; another page holds it ⇒ skipped', () => {
    const todos = docs('produtos/a/prodAmazon/l', 'produtos/b/prodAmazon/l');
    expect(paginaAvaliaSkuVinculosAmazon(['produtos/a/prodAmazon/l'], todos)).toBe(true);
    expect(paginaAvaliaSkuVinculosAmazon(['produtos/b/prodAmazon/l'], todos)).toBe(false);
  });

  it('★ the order is the server’s, segment by segment (NEAR-MISS: a whole-string compare would pick the other)', () => {
    const a = 'produtos/a/prodAmazon/l';
    const ab = 'produtos/a-b/prodAmazon/l';
    expect(a < ab).toBe(false);
    expect(compararCaminhosVinculosAmazon(a, ab)).toBeLessThan(0);
    expect(paginaAvaliaSkuVinculosAmazon([a], docs(a, ab))).toBe(true);
    expect(paginaAvaliaSkuVinculosAmazon([ab], docs(a, ab))).toBe(false);
  });

  it('a SKU whose query reached the limit is evaluated on every page holding one of its docs', () => {
    expect(paginaAvaliaSkuVinculosAmazon(['produtos/z/prodAmazon/l'], { tipo: 'limite' })).toBe(
      true,
    );
  });
});

describe('the grouping, pure', () => {
  it('docs by SKU in page order; a doc under no produto counted fora-de-produto, one without a SKU sem-sku', () => {
    const g = agruparPaginaVarreduraVinculosAmazon([
      { caminho: 'produtos/a/prodAmazon/1', sku: 'B' },
      { caminho: 'prodAmazon/solto', sku: 'C' },
      { caminho: 'produtos/b/prodAmazon/1', sku: null },
      { caminho: 'produtos/c/prodAmazon/1', sku: 'A' },
      { caminho: 'produtos/d/prodAmazon/1', sku: 'B' },
    ]);
    expect(g.skus).toEqual(['B', 'A']);
    expect(g.caminhosDoSku.get('B')).toEqual([
      'produtos/a/prodAmazon/1',
      'produtos/d/prodAmazon/1',
    ]);
    expect(g.porChave).toEqual({ 'fora-de-produto': 1, 'sem-sku': 1 });
  });
});

describe('★ the walk: ONE == per ref form, by key, projected, paged', () => {
  it('the canonical form, then the bare one, each its own == on the declared index, ordered by __name__', async () => {
    vinculo('p1', 'l', 'SKU-1');
    vinculo('p2', 'l', 'SKU-2', NUA);
    const p = await lerPaginaVarreduraVinculosAmazon(asDb(db), CONTA, INICIO, PRAZO);
    if (typeof p === 'string') throw new Error(p);
    expect(p.docs.map((d) => d.sku)).toEqual(['SKU-1', 'SKU-2']);
    const walk = db.consultas.filter((q) => q.ordens.some(([c]) => c === '__name__'));
    const [campo] = CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON;
    expect(walk.map((q) => q.filtros)).toEqual([[[campo, CANONICA]], [[campo, NUA]]]);
    for (const q of walk) {
      expect(q).toMatchObject({
        colecao: 'prodAmazon',
        grupo: true,
        ordens: [['__name__', 'asc']],
        selecao: [...CAMPOS_VARREDURA_VINCULOS_AMAZON],
      });
    }
    expect(walk.map((q) => q.limite)).toEqual([PAGINA_VARREDURA_VINCULOS_AMAZON, 299]);
    expect(varreduraVinculosConcluida(p.cursores)).toBe(true);
  });

  it('the deadline before a query ⇒ prazo, nothing read', async () => {
    vinculo('p1', 'l', 'SKU-1');
    const passou = { agora: () => AGORA, prazoMs: AGORA };
    expect(await lerPaginaVarreduraVinculosAmazon(asDb(db), CONTA, INICIO, passou)).toBe('prazo');
    expect(
      await paginaVarreduraVinculosAmazon(asDb(db), CONTA, INICIO, {
        campos: CAMPOS.preco,
        prazo: passou,
      }),
    ).toEqual({ tipo: 'truncada', motivo: 'prazo' });
    expect(db.contagem.consultas).toBe(0);
  });

  it('the deadline after the walk, before the dedupe read ⇒ truncada prazo', async () => {
    vinculo('p1', 'l', 'SKU-1');
    const r = await paginaVarreduraVinculosAmazon(asDb(db), CONTA, INICIO, {
      campos: CAMPOS.estoque,
      prazo: { agora: () => (db.contagem.consultas >= 2 ? AGORA + 1 : AGORA), prazoMs: AGORA + 1 },
    });
    expect(r).toEqual({ tipo: 'truncada', motivo: 'prazo' });
  });

  it('★ a form that ends SHORT on a doc under no produto keeps its previous cursor (a stored cursor is always a produto’s link path); NEAR-MISS: one ending on a produto’s link stores that link', async () => {
    vinculo('a', 'l', 'SKU-A');
    vinculo('b', 'l', 'SKU-B');
    // A canonical-form link doc under no produto, after every produto by key.
    db.seed('zzz/x/prodAmazon/l', { contaAmazonOuterRef: CANONICA, sku: 'SKU-Z' });
    const depoisDeA: CursoresVarreduraVinculosAmazon = {
      canonica: { ultimoCaminho: 'produtos/a/prodAmazon/l', concluida: false },
      nua: { ultimoCaminho: null, concluida: false },
    };
    const p = await lerPaginaVarreduraVinculosAmazon(asDb(db), CONTA, depoisDeA, PRAZO);
    if (typeof p === 'string') throw new Error(p);
    expect(p.docs.map((d) => d.caminho)).toEqual(['produtos/b/prodAmazon/l', 'zzz/x/prodAmazon/l']);
    expect(p.cursores.canonica).toEqual({
      ultimoCaminho: 'produtos/a/prodAmazon/l',
      concluida: true,
    });
    // NEAR-MISS: the same short form without the stray doc ends on b's link.
    db.apagar('zzz/x/prodAmazon/l');
    const q = await lerPaginaVarreduraVinculosAmazon(asDb(db), CONTA, depoisDeA, PRAZO);
    if (typeof q === 'string') throw new Error(q);
    expect(q.cursores.canonica).toEqual({
      ultimoCaminho: 'produtos/b/prodAmazon/l',
      concluida: true,
    });
  });

  it('a full page whose last doc is under no produto ⇒ cursor-ilegivel', async () => {
    for (let i = 0; i < PAGINA_VARREDURA_VINCULOS_AMAZON; i += 1) {
      db.seed(`prodAmazon/solto${String(i).padStart(3, '0')}`, {
        contaAmazonOuterRef: CANONICA,
        sku: `S-${String(i)}`,
      });
    }
    expect(await lerPaginaVarreduraVinculosAmazon(asDb(db), CONTA, INICIO, PRAZO)).toBe(
      'cursor-ilegivel',
    );
  });
});
