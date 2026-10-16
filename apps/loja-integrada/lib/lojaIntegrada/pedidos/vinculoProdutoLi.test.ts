/**
 * `vinculoProdutoLi.ts`: the link-doc lookup over every stored form of the conta
 * ref, the owner read and its hop, and the cascade's order — against
 * `testing/fakeDb.ts` and a fake read client (no network: D17).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LiHttpError,
  LiNotFoundError,
  LiSchemaError,
  type LiLeituraClient,
} from '@delfrance/integrations-loja-integrada';

import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import type { ReferenciaDeProdutoLi } from './itensMapeamento';
import {
  CAMPOS_INDICE_VINCULO_LI,
  GRUPO_VINCULO_LI,
  criarResolvedorDeLinhasLi,
  unidadeVendavelDoDonoLi,
  vinculoDoProdutoLi,
} from './vinculoProdutoLi';

const CONTA = 'conta-li-vinculo';

const REQ = { operacao: 'buscarProdutoPorIdExterno', correlationId: 'c', refCredencial: 'r.1' };

/** A read client whose `id_externo` GET answers from `respostas` (an Error is thrown). */
function clienteFalso(respostas: Record<string, unknown> = {}): {
  cliente: LiLeituraClient;
  caminhos: string[];
} {
  const caminhos: string[] = [];
  const cliente = {
    get: (p: { caminho: string }) => {
      caminhos.push(p.caminho);
      const r = respostas[p.caminho];
      if (r instanceof Error) return Promise.reject(r);
      if (r === undefined) {
        return Promise.reject(new LiNotFoundError({ ...REQ, caminho: p.caminho, status: 404 }));
      }
      return Promise.resolve({ dados: r, status: 200, correlationId: 'c', refCredencial: 'r.1' });
    },
  } as unknown as LiLeituraClient;
  return { cliente, caminhos };
}

function seedProduto(db: FakeDb, id: string, campos: DocData = {}): void {
  db.seed(`produtos/${id}`, { sku: `sku-${id}`, paiId: null, ...campos });
}

function seedVinculo(db: FakeDb, produtoId: string, docId: string, campos: DocData): void {
  db.seed(`produtos/${produtoId}/produtolojaintegrada/${docId}`, { sku: 's', ...campos });
}

function ref(over: Partial<ReferenciaDeProdutoLi> = {}): ReferenciaDeProdutoLi {
  return {
    ensureUniqueId: '501',
    forma: { forma: 'id-li', idLi: '7001' },
    idLiPai: null,
    sku: null,
    ...over,
  };
}

describe('the index the lookup needs is declared (Enterprise full-scans without it)', () => {
  it('firestore.indexes.json holds a COLLECTION_GROUP index on exactly the lookup’s fields, in order', () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
    const indices = (
      JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
        indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string }[] }[];
      }
    ).indexes;
    const casados = indices.filter(
      (i) =>
        i.collectionGroup === GRUPO_VINCULO_LI &&
        i.queryScope === 'COLLECTION_GROUP' &&
        JSON.stringify(i.fields.map((f) => f.fieldPath)) ===
          JSON.stringify([...CAMPOS_INDICE_VINCULO_LI]),
    );
    expect(casados).toHaveLength(1);
  });

  it('the query is built from those constants: `in` over both ref forms, then the NUMBER id', async () => {
    const db = new FakeDb();
    await vinculoDoProdutoLi(asDb(db), CONTA, '7001');
    expect(db.consultas).toEqual([
      {
        colecao: GRUPO_VINCULO_LI,
        grupo: true,
        filtros: [
          [
            CAMPOS_INDICE_VINCULO_LI[0],
            'in',
            [`documents/integracao/${CONTA}`, `integracao/${CONTA}`],
          ],
          [CAMPOS_INDICE_VINCULO_LI[1], '==', 7001],
        ],
        ordens: [],
        limite: 5,
        apos: null,
      },
    ]);
  });
});

describe('vinculoDoProdutoLi — owners, not hits', () => {
  it('both stored ref forms are found; another conta’s and a TEXT id are not', async () => {
    const db = new FakeDb();
    seedVinculo(db, 'p1', 'a', { contaLojaIntegrada: `documents/integracao/${CONTA}`, id: 7001 });
    seedVinculo(db, 'p2', 'b', { contaLojaIntegrada: `integracao/${CONTA}`, id: 7002 });
    seedVinculo(db, 'p3', 'c', { contaLojaIntegrada: 'documents/integracao/outra', id: 7001 });
    seedVinculo(db, 'p4', 'd', { contaLojaIntegrada: `documents/integracao/${CONTA}`, id: '7003' });
    expect(await vinculoDoProdutoLi(asDb(db), CONTA, '7001')).toEqual({ tipo: 'um', donoId: 'p1' });
    expect(await vinculoDoProdutoLi(asDb(db), CONTA, '7002')).toEqual({ tipo: 'um', donoId: 'p2' });
    expect(await vinculoDoProdutoLi(asDb(db), CONTA, '7003')).toEqual({ tipo: 'nenhum' });
  });

  it('two docs under ONE produto are one owner; two produtos are ambiguous', async () => {
    const db = new FakeDb();
    seedVinculo(db, 'p1', 'a', { contaLojaIntegrada: `documents/integracao/${CONTA}`, id: 7001 });
    seedVinculo(db, 'p1', 'b', { contaLojaIntegrada: `integracao/${CONTA}`, id: 7001 });
    expect(await vinculoDoProdutoLi(asDb(db), CONTA, '7001')).toEqual({ tipo: 'um', donoId: 'p1' });
    seedVinculo(db, 'p2', 'c', { contaLojaIntegrada: `integracao/${CONTA}`, id: 7001 });
    expect(await vinculoDoProdutoLi(asDb(db), CONTA, '7001')).toEqual({
      tipo: 'ambiguo',
      donoIds: ['p1', 'p2'],
    });
  });
});

describe('unidadeVendavelDoDonoLi — the hop, the shared rule', () => {
  it('a família-de-um root ⇒ its member; a kit root ⇒ itself; a child ⇒ itself even with a stale filhoUnicoId; gone ⇒ null', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { filhoUnicoId: 'membro' });
    seedProduto(db, 'kit', { filhoUnicoId: 'membro-kit', ehKit: true });
    seedProduto(db, 'filho', { paiId: 'raiz', filhoUnicoId: 'velho' });
    expect(await unidadeVendavelDoDonoLi(asDb(db), 'raiz')).toBe('membro');
    expect(await unidadeVendavelDoDonoLi(asDb(db), 'kit')).toBe('kit');
    expect(await unidadeVendavelDoDonoLi(asDb(db), 'filho')).toBe('filho');
    expect(await unidadeVendavelDoDonoLi(asDb(db), 'sumiu')).toBeNull();
  });
});

describe('the cascade', () => {
  it('(1) the line’s own id binds the hopped owner, with the via and the id', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { filhoUnicoId: 'membro' });
    seedVinculo(db, 'raiz', 'a', { contaLojaIntegrada: `documents/integracao/${CONTA}`, id: 7001 });
    const { cliente, caminhos } = clienteFalso();
    const r = await criarResolvedorDeLinhasLi(asDb(db), CONTA, cliente).resolver(ref());
    expect(r).toEqual({ produtoId: 'membro', via: 'vinculo-li', idLi: '7001' });
    expect(caminhos).toEqual([]);
  });

  it('(1) an owner that no longer exists is no hit: the SKU rungs decide', async () => {
    const db = new FakeDb();
    seedVinculo(db, 'sumiu', 'a', {
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 7001,
    });
    seedProduto(db, 'por-sku', { sku: 'S-1' });
    const { cliente } = clienteFalso();
    const r = await criarResolvedorDeLinhasLi(asDb(db), CONTA, cliente).resolver(
      ref({ sku: 'S-1' }),
    );
    expect(r).toEqual({ produtoId: 'por-sku', via: 'sku-root', idLi: '7001' });
  });

  it('(1) an ambiguous link ends the cascade unbound — no SKU rung binds it', async () => {
    const db = new FakeDb();
    seedVinculo(db, 'p1', 'a', { contaLojaIntegrada: `documents/integracao/${CONTA}`, id: 7001 });
    seedVinculo(db, 'p2', 'b', { contaLojaIntegrada: `documents/integracao/${CONTA}`, id: 7001 });
    seedProduto(db, 'por-sku', { sku: 'S-1' });
    const { cliente } = clienteFalso();
    const r = await criarResolvedorDeLinhasLi(asDb(db), CONTA, cliente).resolver(
      ref({ sku: 'S-1' }),
    );
    expect(r).toEqual({ produtoId: null, via: 'vinculo-ambiguo', idLi: '7001' });
  });

  it('(2) the parent link scopes the SKU rung and never binds by itself', async () => {
    const db = new FakeDb();
    seedProduto(db, 'pai');
    seedProduto(db, 'filho', { paiId: 'pai', sku: 'S-1' });
    seedVinculo(db, 'pai', 'a', { contaLojaIntegrada: `documents/integracao/${CONTA}`, id: 7000 });
    const { cliente } = clienteFalso();
    const resolvedor = criarResolvedorDeLinhasLi(asDb(db), CONTA, cliente);
    expect(await resolvedor.resolver(ref({ idLiPai: '7000', sku: 'S-1' }))).toEqual({
      produtoId: 'filho',
      via: 'sku-child',
      idLi: '7001',
    });
    // A line whose SKU names nothing under the parent: unbound, the parent NOT bound.
    expect(await resolvedor.resolver(ref({ idLiPai: '7000', sku: 'outro' }))).toEqual({
      produtoId: null,
      via: 'unresolved',
      idLi: '7001',
    });
    // The parent's link is read ONCE per order (memo).
    expect(db.consultas.filter((q) => q.grupo === true && q.filtros[1]?.[2] === 7000)).toHaveLength(
      1,
    );
  });

  it('(4) id_externo: the SKU FIRST — a hit makes no Loja Integrada call', async () => {
    const db = new FakeDb();
    seedProduto(db, 'por-sku', { sku: 'S-1' });
    const { cliente, caminhos } = clienteFalso();
    const r = await criarResolvedorDeLinhasLi(asDb(db), CONTA, cliente).resolver(
      ref({ forma: { forma: 'id-externo', idExterno: '321' }, sku: 'S-1' }),
    );
    expect(r).toEqual({ produtoId: 'por-sku', via: 'sku-root', idLi: null });
    expect(caminhos).toEqual([]);
  });

  it('(4) id_externo after a SKU miss: the GET, then the link docs', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p-ext', { paiId: 'x' });
    seedVinculo(db, 'p-ext', 'a', { contaLojaIntegrada: `integracao/${CONTA}`, id: 8001 });
    const { cliente, caminhos } = clienteFalso({ '/v1/produto/321/': { id: 8001, sku: 'x' } });
    const r = await criarResolvedorDeLinhasLi(asDb(db), CONTA, cliente).resolver(
      ref({ forma: { forma: 'id-externo', idExterno: '321' }, sku: 'nada' }),
    );
    expect(r).toEqual({ produtoId: 'p-ext', via: 'vinculo-id-externo', idLi: '8001' });
    expect(caminhos).toEqual(['/v1/produto/321/']);
  });

  it('(4) an AMBIGUOUS SKU ends the cascade: no GET', async () => {
    const db = new FakeDb();
    seedProduto(db, 'a', { sku: 'S-1' });
    seedProduto(db, 'b', { sku: 'S-1' });
    const { cliente, caminhos } = clienteFalso();
    const r = await criarResolvedorDeLinhasLi(asDb(db), CONTA, cliente).resolver(
      ref({ forma: { forma: 'id-externo', idExterno: '321' }, sku: 'S-1' }),
    );
    expect(r).toEqual({ produtoId: null, via: 'ambiguous-sku', idLi: null });
    expect(caminhos).toEqual([]);
  });

  it('(4) a 404 and a malformed body are the LINE’s; any other error rethrows', async () => {
    const db = new FakeDb();
    const externo = ref({ forma: { forma: 'id-externo', idExterno: '321' }, sku: null });
    const caminho = '/v1/produto/321/';
    expect(
      await criarResolvedorDeLinhasLi(asDb(db), CONTA, clienteFalso().cliente).resolver(externo),
    ).toEqual({ produtoId: null, via: 'id-externo-inexistente', idLi: null });
    const schema = new LiSchemaError({
      ...REQ,
      caminho,
      status: 200,
      motivo: 'formato',
      campos: ['id'],
    });
    expect(
      await criarResolvedorDeLinhasLi(
        asDb(db),
        CONTA,
        clienteFalso({ [caminho]: schema }).cliente,
      ).resolver(externo),
    ).toEqual({ produtoId: null, via: 'id-externo-ilegivel', idLi: null });
    const http = new LiHttpError({ ...REQ, caminho, status: 503 });
    await expect(
      criarResolvedorDeLinhasLi(
        asDb(db),
        CONTA,
        clienteFalso({ [caminho]: http }).cliente,
      ).resolver(externo),
    ).rejects.toBe(http);
  });

  it('a line that names NEITHER form reaches the SKU rungs only', async () => {
    const db = new FakeDb();
    seedProduto(db, 'por-sku', { sku: 'S-1' });
    const { cliente, caminhos } = clienteFalso();
    const r = await criarResolvedorDeLinhasLi(asDb(db), CONTA, cliente).resolver(
      ref({ forma: { forma: 'nenhuma' }, sku: 'S-1' }),
    );
    expect(r).toEqual({ produtoId: 'por-sku', via: 'sku-root', idLi: null });
    expect(caminhos).toEqual([]);
    expect(db.consultas.filter((q) => q.grupo === true)).toEqual([]);
  });
});
