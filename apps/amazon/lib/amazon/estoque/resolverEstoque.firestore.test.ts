/**
 * The stock resolver on a REAL Firestore — the emulator of `ci-amazon.yml`, not
 * the in-memory fake (step 12, PR 12-e1). The offline suite proves every read
 * against `testing/fakeDb.ts`; this file proves, on the real server, what only
 * holds if the server behaves as the fake says:
 *
 *  - the MASKS: the link query's classic `select`, the donos', the unit's and
 *    the parent pointers' `getAll` field masks answer ONLY the listed fields
 *    (a link doc's product payload never comes back), and the children seek's
 *    `select()` answers the keys alone;
 *  - refusal 4's reader: a kit root with its one mirror child is read as ONE
 *    child id and the verdict is apt; two children are BOTH returned and the
 *    verdict refuses;
 *  - the binding is the order import's own, read on the same server.
 *
 * Reads only: no write of the code under test, no network, no task (D11 holds
 * trivially: nothing here reaches a client).
 *
 * ⚠️ The emulator is SHARED: every document id here starts with
 * `e2e-estoque-resolver-`, which no other suite seeds, and the conta id is no
 * other suite's; no `integracao` document is written, so the conta trigger
 * never fires, and `produtos` / `prodAmazon` are no trigger path. Every case
 * wipes what it seeds first, and the file leaves nothing behind.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { criarResolvedorDeVinculosAmazon } from '../pedidos/vinculoProdutoAmazon';
import { lerFilhosDaUnidadeEstoqueAmazon, lerVinculoEstoqueAmazon } from './resolverEstoque';
import { avaliarVinculoEstoqueAmazon } from './vinculoEstoque';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** The conta of this file — an id no other suite seeds; no conta document is written. */
const CONTA = 'e2e-estoque-resolver-conta';
const P = 'e2e-estoque-resolver-';
const SKU = `${P}SKU-1`;

function db(): Firestore {
  return getAdminFirestore();
}

/** Every path this file may seed, so each case starts clean and the file ends clean. */
const CAMINHOS: string[] = [];

async function semear(caminho: string, dados: Record<string, unknown>): Promise<void> {
  if (!CAMINHOS.includes(caminho)) CAMINHOS.push(caminho);
  await db().doc(caminho).set(dados);
}

async function limpar(): Promise<void> {
  await Promise.all(CAMINHOS.map((c) => db().doc(c).delete()));
}

const produto = (id: string, dados: Record<string, unknown> = {}) =>
  semear(`produtos/${P}${id}`, { nome: `Produto ${id}`, ...dados });

/** A link doc naming this conta and the SKU, carrying a product payload no read may return. */
const vinculo = (produtoId: string, linkId: string, dados: Record<string, unknown> = {}) =>
  semear(`produtos/${P}${produtoId}/prodAmazon/${P}${linkId}`, {
    contaAmazonOuterRef: `documents/integracao/${CONTA}`,
    sku: SKU,
    asin: 'B0ZZFILHO1',
    productDataJson: { pesado: 'x'.repeat(256) },
    issues: [],
    ...dados,
  });

const ler = () => lerVinculoEstoqueAmazon(db(), CONTA, SKU);

describe.skipIf(!EMULATED)('the stock resolver on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ every read carries only its listed fields: the link projection, the dono, the unit and the parent masks', async () => {
    await produto('W', {
      paiId: null,
      filhoUnicoId: `${P}M`,
      statusProdutosMarketplace: {},
      componentesKit: { x: 1 },
    });
    await produto('M', { paiId: `${P}W`, ehKit: false, precos: { a: 1 } });
    await produto('PAI');
    await vinculo('PAI', 'lp', { sku: `${P}SKU-PAI`, asin: 'B0ZZPAI001' });
    await vinculo('W', 'l1', {
      produtoAmazonPaiOuterRef: `documents/produtos/${P}PAI/prodAmazon/${P}lp`,
    });

    const e = await ler();
    // Positive first: the binding was found on this database.
    expect(e.resolucao).toEqual({ produtoId: `${P}M`, via: 'vinculo-amazon' });
    expect(e.linksDoSku.map((l) => l.linkId)).toEqual([`${P}l1`]);
    expect(Object.keys(e.linksDoSku[0]?.dados ?? {}).sort()).toEqual([
      'asin',
      'contaAmazonOuterRef',
      'produtoAmazonPaiOuterRef',
      'sku',
    ]);
    expect(e.dono).toEqual({
      id: `${P}W`,
      raw: { paiId: null, filhoUnicoId: `${P}M`, statusProdutosMarketplace: {} },
    });
    expect(e.unidade).toEqual({ raw: { paiId: `${P}W`, ehKit: false }, filhosIds: [] });
    expect([...e.paisDosLinks.entries()]).toEqual([
      [`produtos/${P}PAI/prodAmazon/${P}lp`, { sku: `${P}SKU-PAI`, asin: 'B0ZZPAI001' }],
    ]);
    expect(avaliarVinculoEstoqueAmazon(e)).toMatchObject({
      apto: true,
      unidadeId: `${P}M`,
      donoId: `${P}W`,
    });
  });

  it('★ a KIT root with its one mirror child ⇒ ONE child id, and the verdict is apt (the kit publishes)', async () => {
    await produto('K', { ehKit: true, paiId: null, filhoUnicoId: `${P}KM` });
    await produto('KM', { paiId: `${P}K`, nome: 'A espelho' });
    await vinculo('K', 'l1');
    const e = await ler();
    expect(e.unidade).toEqual({
      raw: { ehKit: true, paiId: null, filhoUnicoId: `${P}KM` },
      filhosIds: [`${P}KM`],
    });
    expect(avaliarVinculoEstoqueAmazon(e)).toMatchObject({ apto: true, unidadeId: `${P}K` });
  });

  it('★ NEAR-MISS: two children ⇒ BOTH ids, and the verdict refuses unidade-com-variacoes', async () => {
    await produto('K', { ehKit: true, paiId: null, filhoUnicoId: `${P}KM` });
    await produto('KM', { paiId: `${P}K`, nome: 'A espelho' });
    await produto('KV', { paiId: `${P}K`, nome: 'B variação' });
    await vinculo('K', 'l1');
    const e = await ler();
    expect([...e.unidade.filhosIds].sort()).toEqual([`${P}KM`, `${P}KV`]);
    expect(avaliarVinculoEstoqueAmazon(e)).toEqual({
      apto: false,
      motivo: 'unidade-com-variacoes',
    });
  });

  it('the children seek answers the keys alone, at most two, ordered by nome', async () => {
    await produto('U');
    await produto('C', { paiId: `${P}U`, nome: 'c' });
    await produto('A', { paiId: `${P}U`, nome: 'a' });
    await produto('B', { paiId: `${P}U`, nome: 'b' });
    await expect(lerFilhosDaUnidadeEstoqueAmazon(db(), `${P}U`)).resolves.toEqual([
      `${P}A`,
      `${P}B`,
    ]);
  });

  it('★ the binding is the order import’s, on the same server: one dono, two live donos, a gone dono', async () => {
    const ambas = async () => ({
      estoque: (await ler()).resolucao,
      importacao: await criarResolvedorDeVinculosAmazon(db(), CONTA).resolver(SKU),
    });

    await produto('P');
    await vinculo('P', 'l1');
    const uma = await ambas();
    expect(uma.estoque).toEqual({ produtoId: `${P}P`, via: 'vinculo-amazon' });
    expect(uma.estoque).toEqual(uma.importacao);

    await produto('Q');
    await vinculo('Q', 'l2');
    const duas = await ambas();
    expect(duas.estoque).toEqual({ produtoId: null, via: 'amazon-vinculo-ambiguo' });
    expect(duas.estoque).toEqual(duas.importacao);

    await db().doc(`produtos/${P}Q`).delete();
    const sumido = await ambas();
    expect(sumido.estoque).toEqual({ produtoId: `${P}P`, via: 'vinculo-amazon' });
    expect(sumido.estoque).toEqual(sumido.importacao);
  });
});
