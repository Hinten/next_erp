/**
 * The shared per-SKU link reader: each flow's masks (the stock masks
 * unchanged, the price masks with one `precos` entry per tabela), the link
 * projection never dropped, and the unit's parent read only for a flow that
 * reads it and a unit that names one. The masks with a `precos` entry (a
 * two-segment path) run on the emulator (`avaliacaoLoteVinculos.firestore.test.ts`):
 * the fake db models top-level names only.
 */
import { FieldPath } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeDb, asDb } from '../testing/fakeDb';
import { FLUXO_LISTING_AMAZON } from './fluxoListing';
import {
  CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON,
  type CamposVinculoListingAmazon,
  camposContidosListingAmazon,
  camposDoResolverListingAmazon,
  lerVinculoListingAmazon,
  mascaraFirestoreListingAmazon,
  projetarCamposListingAmazon,
} from './resolverVinculo';

const CONTA = 'conta-resolver';
const CANONICA = `documents/integracao/${CONTA}`;
const SKU = 'SKU-1';

const ESTOQUE = camposDoResolverListingAmazon({ fluxo: FLUXO_LISTING_AMAZON.estoque });
/** The price masks with no tabela: top-level names only, which the fake db models. */
const PRECO_SEM_TABELA = camposDoResolverListingAmazon({
  fluxo: FLUXO_LISTING_AMAZON.preco,
  tabelaIds: [],
});

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.exigirMascaraEm('prodAmazon');
  db.exigirMascaraEm('produtos');
});

function produto(id: string, dados: Record<string, unknown> = {}) {
  db.seed(`produtos/${id}`, { nome: `Produto ${id}`, precos: { t: { valor: 9 } }, ...dados });
}

function vinculo(produtoId: string, linkId: string, dados: Record<string, unknown> = {}) {
  db.seed(`produtos/${produtoId}/prodAmazon/${linkId}`, {
    contaAmazonOuterRef: CANONICA,
    sku: SKU,
    asin: 'B0ZZRESOLV',
    productDataJson: { pesado: 'x'.repeat(64) },
    envioEstoqueAmazon: { emMs: 1 },
    envioPrecoAmazon: { emMs: 2 },
    ...dados,
  });
}

const ler = (campos: CamposVinculoListingAmazon) =>
  lerVinculoListingAmazon(asDb(db), CONTA, SKU, campos);

describe('★ each flow’s masks', () => {
  it('stock: the index’s two and the verdict’s three on the link, the opt-out map on the dono, refusal 4’s fields, no parent', () => {
    expect(ESTOQUE).toEqual({
      fluxo: FLUXO_LISTING_AMAZON.estoque,
      vinculo: [
        'contaAmazonOuterRef',
        'sku',
        'asin',
        'produtoAmazonPaiOuterRef',
        'envioEstoqueAmazon',
      ],
      dono: ['statusProdutosMarketplace'],
      unidade: ['ehKit', 'paiId', 'filhoUnicoId'],
      paiDaUnidade: null,
    });
  });

  it('price: its OWN outcome field, no dono field, one precos entry per tabela on the unit and its parent', () => {
    const preco = camposDoResolverListingAmazon({
      fluxo: FLUXO_LISTING_AMAZON.preco,
      tabelaIds: ['normal', 'promo', 'normal'],
    });
    expect(preco).toEqual({
      fluxo: FLUXO_LISTING_AMAZON.preco,
      vinculo: [
        'contaAmazonOuterRef',
        'sku',
        'asin',
        'produtoAmazonPaiOuterRef',
        'envioPrecoAmazon',
      ],
      dono: [],
      unidade: [
        'ehKit',
        'paiId',
        'filhoUnicoId',
        { mapa: 'precos', chave: 'normal' },
        { mapa: 'precos', chave: 'promo' },
      ],
      paiDaUnidade: [
        { mapa: 'precos', chave: 'normal' },
        { mapa: 'precos', chave: 'promo' },
        'propagatePriceToChildren',
      ],
    });
    // NEAR-MISS: neither flow's link projection names the other flow's outcome.
    expect(CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON.preco).not.toContain('envioEstoqueAmazon');
    expect(CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON.estoque).not.toContain('envioPrecoAmazon');
  });

  it('a tabela id that is not a document id is refused before anything is read', () => {
    for (const id of ['', 'a/b']) {
      expect(() =>
        camposDoResolverListingAmazon({ fluxo: FLUXO_LISTING_AMAZON.preco, tabelaIds: [id] }),
      ).toThrow(RangeError);
    }
  });

  it('a precos entry reaches the SDK as ONE two-segment path, whatever its key holds; a name stays a name', () => {
    const [nome, entrada] = mascaraFirestoreListingAmazon([
      'paiId',
      { mapa: 'precos', chave: 'a.b' },
    ]);
    expect(nome).toBe('paiId');
    expect(entrada).toBeInstanceOf(FieldPath);
    expect((entrada as FieldPath).isEqual(new FieldPath('precos', 'a.b'))).toBe(true);
    // NEAR-MISS: the dotted string is another path (three segments).
    expect((entrada as FieldPath).isEqual(new FieldPath('precos', 'a', 'b'))).toBe(false);
  });

  it('the projection keeps only the asked precos entries; a non-object map or an absent key gives nothing', () => {
    const campos = ['paiId', { mapa: 'precos', chave: 'n' }, { mapa: 'precos', chave: 'p' }];
    expect(
      projetarCamposListingAmazon({ paiId: 'W', nome: 'x', precos: { n: 1, z: 2 } }, campos),
    ).toEqual({ paiId: 'W', precos: { n: 1 } });
    expect(projetarCamposListingAmazon({ precos: 7 }, campos)).toEqual({});
    expect(projetarCamposListingAmazon({ precos: { z: 1 } }, campos)).toEqual({});
  });

  it('a read holds a mask only when every field is a top-level name it carried', () => {
    expect(camposContidosListingAmazon(['a', 'b'], ['b', 'a', 'c'])).toBe(true);
    expect(
      camposContidosListingAmazon(['a', { mapa: 'precos', chave: 'n' }], ['a', 'precos']),
    ).toBe(false);
    expect(camposContidosListingAmazon(['a', 'd'], ['a'])).toBe(false);
  });
});

describe('★ the link projection is never dropped', () => {
  it.each([
    ['estoque', ESTOQUE],
    ['preco', PRECO_SEM_TABELA],
  ] as const)(
    '%s: the query carries the flow’s select; no payload and no other flow’s outcome comes back',
    async (fluxo, campos) => {
      produto('P');
      vinculo('P', 'l1');
      const { entrada } = await ler(campos);
      expect(db.consultas[0]).toMatchObject({
        colecao: 'prodAmazon',
        grupo: true,
        selecao: [...CAMPOS_LEITURA_VINCULOS_LISTING_AMAZON[fluxo]],
      });
      const dados = entrada.linksDoSku[0]?.dados ?? {};
      expect(dados.productDataJson).toBeUndefined();
      const proprio = fluxo === 'estoque' ? 'envioEstoqueAmazon' : 'envioPrecoAmazon';
      const alheio = fluxo === 'estoque' ? 'envioPrecoAmazon' : 'envioEstoqueAmazon';
      expect(dados[proprio]).toBeDefined();
      expect(dados[alheio]).toBeUndefined();
    },
  );
});

describe('★ the unit and its parent', () => {
  it('price: the unit IS the dono and carries a paiId ⇒ the unit off the dono’s read, then ONE masked parent read', async () => {
    produto('PAI', { propagatePriceToChildren: true });
    produto('F', { paiId: 'PAI' });
    vinculo('F', 'l1');
    const r = await ler(PRECO_SEM_TABELA);
    expect(r.entrada.unidade.raw).toEqual({ paiId: 'PAI' });
    expect(r.paiDaUnidade).toEqual({ id: 'PAI', raw: { propagatePriceToChildren: true } });
    expect(db.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/PAI')).toMatchObject([
      { via: 'getAll', mascara: ['propagatePriceToChildren'] },
    ]);
    // The dono's read is masked to the hop's fields alone: price reads no opt-out map.
    expect(db.leiturasDetalhadas.filter((l) => l.caminho === 'produtos/F')).toMatchObject([
      { via: 'getAll', mascara: ['ehKit', 'paiId', 'filhoUnicoId'] },
    ]);
  });

  it('NEAR-MISS: stock reads NO parent, even for a unit that names one', async () => {
    produto('PAI', { propagatePriceToChildren: true });
    produto('F', { paiId: 'PAI' });
    vinculo('F', 'l1');
    const r = await ler(ESTOQUE);
    expect(r.paiDaUnidade).toBeNull();
    expect(db.leituras).not.toContain('produtos/PAI');
  });

  it('NEAR-MISS: price, a unit with no paiId ⇒ no parent read at all', async () => {
    produto('P');
    vinculo('P', 'l1');
    const r = await ler(PRECO_SEM_TABELA);
    expect(r.paiDaUnidade).toBeNull();
    expect(db.contagem.chamadasGetAll).toBe(1);
  });

  it('price: a family-of-one wrapper’s member is read on its own, and its parent (the wrapper) once more, masked', async () => {
    produto('W', { paiId: null, filhoUnicoId: 'M', propagatePriceToChildren: false });
    produto('M', { paiId: 'W' });
    vinculo('W', 'l1');
    const r = await ler(PRECO_SEM_TABELA);
    expect(r.entrada.unidade.raw).toEqual({ paiId: 'W' });
    expect(r.paiDaUnidade).toEqual({ id: 'W', raw: { propagatePriceToChildren: false } });
    expect(db.leiturasDetalhadas.map((l) => l.caminho)).toEqual([
      'produtos/W',
      'produtos/M',
      'produtos/W',
    ]);
  });

  it('a paiId that is not a document id is never read; a parent that is gone reads raw null', async () => {
    produto('F', { paiId: 'a/b' });
    vinculo('F', 'l1');
    expect((await ler(PRECO_SEM_TABELA)).paiDaUnidade).toEqual({ id: null, raw: null });
    db = new FakeDb();
    produto('G', { paiId: 'SUMIDO' });
    vinculo('G', 'l1');
    expect((await ler(PRECO_SEM_TABELA)).paiDaUnidade).toEqual({ id: 'SUMIDO', raw: null });
  });

  it('no unit named (two live donos) ⇒ no unit, no parent, nothing past the donos', async () => {
    produto('P', { paiId: 'X' });
    produto('Q', { paiId: 'X' });
    vinculo('P', 'l1');
    vinculo('Q', 'l2');
    const r = await ler(PRECO_SEM_TABELA);
    expect(r.entrada.dono).toBeNull();
    expect(r.paiDaUnidade).toBeNull();
    expect(db.contagem).toMatchObject({ chamadasGetAll: 1, consultas: 1 });
  });
});
