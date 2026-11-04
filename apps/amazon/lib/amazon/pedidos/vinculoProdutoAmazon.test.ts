/**
 * The link-doc lookup, against the fake db (which refuses any query shape but
 * the declared collection-group index), and the index pin NEXT TO the query.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';
import { CAMPOS_INDICE_VINCULO_AMAZON } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  FALHA_VINCULO_AMAZON,
  LIMITE_VINCULOS_AMAZON,
  criarResolvedorDeVinculosAmazon,
} from './vinculoProdutoAmazon';

const CONTA = 'conta-1';
const CANONICA = `documents/integracao/${CONTA}`;
const NUA = `integracao/${CONTA}`;

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

/** A link doc under `produtoId`, naming the conta (canonical form by default) and a SKU. */
function vinculo(produtoId: string, docId: string, sku: string, conta = CANONICA) {
  db.seed(`produtos/${produtoId}/prodAmazon/${docId}`, { contaAmazonOuterRef: conta, sku });
}

function produto(id: string, dados: Record<string, unknown> = {}) {
  db.seed(`produtos/${id}`, { nome: `Produto ${id}`, ...dados });
}

const resolver = (sku: string | null) =>
  criarResolvedorDeVinculosAmazon(asDb(db), CONTA).resolver(sku);

describe('the link lookup — one owner binds; ambiguity fails closed', () => {
  it('one link doc under one live produto ⇒ bound to it', async () => {
    produto('p1');
    vinculo('p1', 'l1', 'SKU-1');
    expect(await resolver('SKU-1')).toEqual({ produtoId: 'p1', via: 'vinculo-amazon' });
  });

  it('★ two link docs under ONE produto (one per stored ref form) ⇒ one owner, bound', async () => {
    produto('p1');
    vinculo('p1', 'l1', 'SKU-1', CANONICA);
    vinculo('p1', 'l2', 'SKU-1', NUA);
    expect(await resolver('SKU-1')).toEqual({ produtoId: 'p1', via: 'vinculo-amazon' });
  });

  it('★ two live owners ⇒ unbound + amazon-vinculo-ambiguo (never the first)', async () => {
    produto('p1');
    produto('p2');
    vinculo('p1', 'l1', 'SKU-1');
    vinculo('p2', 'l2', 'SKU-1');
    expect(await resolver('SKU-1')).toEqual({ produtoId: null, via: FALHA_VINCULO_AMAZON.ambiguo });
  });

  it('★ two owners hopping to ONE unit are still two owners ⇒ ambiguous', async () => {
    produto('pai', { paiId: null, filhoUnicoId: 'membro' });
    produto('membro', { paiId: 'pai' });
    vinculo('pai', 'l1', 'SKU-1');
    vinculo('membro', 'l2', 'SKU-1');
    expect(await resolver('SKU-1')).toEqual({ produtoId: null, via: 'amazon-vinculo-ambiguo' });
  });

  it(`★ ${String(LIMITE_VINCULOS_AMAZON)} link docs under ONE owner ⇒ the limit reached ⇒ ambiguous (a truncated read proves no single owner)`, async () => {
    produto('p1');
    for (let i = 0; i < LIMITE_VINCULOS_AMAZON; i += 1) vinculo('p1', `l${String(i)}`, 'SKU-1');
    expect(await resolver('SKU-1')).toEqual({ produtoId: null, via: 'amazon-vinculo-ambiguo' });
    expect(db.consultas.at(-1)?.limite).toBe(LIMITE_VINCULOS_AMAZON);
  });

  it(`NEAR-MISS: ${String(LIMITE_VINCULOS_AMAZON - 1)} under one owner ⇒ bound (one under the detector)`, async () => {
    produto('p1');
    for (let i = 0; i < LIMITE_VINCULOS_AMAZON - 1; i += 1) vinculo('p1', `l${String(i)}`, 'SKU-1');
    expect(await resolver('SKU-1')).toEqual({ produtoId: 'p1', via: 'vinculo-amazon' });
  });

  it('★ five under A plus one under B ⇒ ambiguous', async () => {
    produto('pa');
    produto('pb');
    for (let i = 0; i < 5; i += 1) vinculo('pa', `a${String(i)}`, 'SKU-1');
    vinculo('pb', 'b0', 'SKU-1');
    expect(await resolver('SKU-1')).toEqual({ produtoId: null, via: 'amazon-vinculo-ambiguo' });
  });

  it('★ a GONE owner is no hit; with another live owner present ⇒ bound to that one', async () => {
    vinculo('apagado', 'l1', 'SKU-1');
    expect(await resolver('SKU-1')).toEqual({ produtoId: null, via: 'unresolved' });
    produto('p2');
    vinculo('p2', 'l2', 'SKU-1');
    expect(await criarResolvedorDeVinculosAmazon(asDb(db), CONTA).resolver('SKU-1')).toEqual({
      produtoId: 'p2',
      via: 'vinculo-amazon',
    });
  });

  it('★ a família-de-um PARENT owner ⇒ its sole member (the hop); a KIT owner ⇒ the kit', async () => {
    produto('pai', { paiId: null, filhoUnicoId: 'membro' });
    vinculo('pai', 'l1', 'SKU-PAI');
    produto('kit', { ehKit: true, paiId: null, filhoUnicoId: 'espelho' });
    vinculo('kit', 'l2', 'SKU-KIT');
    const r = criarResolvedorDeVinculosAmazon(asDb(db), CONTA);
    expect(await r.resolver('SKU-PAI')).toEqual({ produtoId: 'membro', via: 'vinculo-amazon' });
    expect(await r.resolver('SKU-KIT')).toEqual({ produtoId: 'kit', via: 'vinculo-amazon' });
  });

  it('★ NEAR-MISS on the SKU bytes: case and a trailing space never match', async () => {
    produto('p1');
    vinculo('p1', 'l1', 'ABC-1');
    const r = criarResolvedorDeVinculosAmazon(asDb(db), CONTA);
    expect(await r.resolver('abc-1')).toEqual({ produtoId: null, via: 'unresolved' });
    expect(await r.resolver('ABC-1 ')).toEqual({ produtoId: null, via: 'unresolved' });
    expect(await r.resolver('ABC-1')).toEqual({ produtoId: 'p1', via: 'vinculo-amazon' });
  });

  it('★ NEAR-MISS on the link key: ANOTHER conta’s link with the same SKU ⇒ no hit', async () => {
    produto('p1');
    vinculo('p1', 'l1', 'SKU-1', 'documents/integracao/conta-2');
    expect(await resolver('SKU-1')).toEqual({ produtoId: null, via: 'unresolved' });
  });

  it('★ the legacy ref form without `documents/` ⇒ hit (both stored forms are queried)', async () => {
    produto('p1');
    vinculo('p1', 'l1', 'SKU-1', NUA);
    expect(await resolver('SKU-1')).toEqual({ produtoId: 'p1', via: 'vinculo-amazon' });
    expect(db.consultas.at(-1)?.filtros[0]).toEqual(['contaAmazonOuterRef in', [CANONICA, NUA]]);
  });

  it('★ NO SKU fallback: a produto whose own `sku` equals the line’s, with no link ⇒ STILL unbound', async () => {
    produto('p1', { sku: 'SKU-1' });
    expect(await resolver('SKU-1')).toEqual({ produtoId: null, via: 'unresolved' });
    // Only the link query ran: no produto query by SKU.
    expect(db.consultas.map((c) => c.colecao)).toEqual(['prodAmazon']);
  });

  it('no sellerSku ⇒ unbound, with no read at all', async () => {
    expect(await resolver(null)).toEqual({ produtoId: null, via: 'unresolved' });
    expect(db.operacoes).toBe(0);
  });

  it('memoised per SKU: a SKU sold on two lines costs one query and one owner read', async () => {
    produto('p1');
    vinculo('p1', 'l1', 'SKU-1');
    const r = criarResolvedorDeVinculosAmazon(asDb(db), CONTA);
    await r.resolver('SKU-1');
    await r.resolver('SKU-1');
    expect(db.consultas).toHaveLength(1);
    expect(db.leituras).toEqual(['produtos/p1']);
  });
});

describe('★ the query’s fields ARE the declared COLLECTION_GROUP index (root rule 1)', () => {
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

  it('the query filters on CAMPOS_INDICE_VINCULO_AMAZON, in that order, as a group query', async () => {
    await resolver('SKU-1');
    const consulta = db.consultas[0];
    expect(consulta?.grupo).toBe(true);
    expect(consulta?.colecao).toBe('prodAmazon');
    expect(consulta?.filtros.map(([campo]) => campo.split(' ')[0])).toEqual([
      ...CAMPOS_INDICE_VINCULO_AMAZON,
    ]);
  });

  it('exactly that entry exists: COLLECTION_GROUP scope, the same fields in the same order, ASC, no __name__', () => {
    const exato = indices.filter(
      (i) =>
        i.collectionGroup === 'prodAmazon' &&
        i.queryScope === 'COLLECTION_GROUP' &&
        JSON.stringify(i.fields) ===
          JSON.stringify(
            CAMPOS_INDICE_VINCULO_AMAZON.map((fieldPath) => ({ fieldPath, order: 'ASCENDING' })),
          ),
    );
    expect(exato).toHaveLength(1);
  });
});
