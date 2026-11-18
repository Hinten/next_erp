/**
 * The stock discovery on a REAL Firestore — the emulator of `ci-amazon.yml`,
 * not the in-memory fake (step 12, PR 12-e2). The offline suite counts every
 * read against `testing/fakeDb.ts`; this file proves, on the real server, what
 * only holds if the server behaves as the fake says:
 *
 *  - ★ a row of the PROJECTED window query (a classic `select` of the stamp)
 *    still carries its commit `updateTime`, equal to the document's own: the
 *    observation and the commit test both read it;
 *  - the bounds: `>` excludes the window's start, `<=` includes its end;
 *  - the document cursor of a collection-group query pages on exactly after
 *    its row: rows sharing one stamp across a page boundary are each read once;
 *  - both stored ref forms of the depósito, the conta's own links in both of
 *    its forms, and a family-of-one wrapper's link found from its member's move;
 *  - the commit test on real `Timestamp`s.
 *
 * ⚠️ The emulator does NOT enforce indexes: a pass here proves the query's SHAPE
 * and its results, never its cost. The cost guard is the declared index and its
 * pin (`packages/schemas/src/estoqueAmazon.indexes.test.ts`).
 *
 * Reads only: no write of the code under test, no network, no task (nothing
 * here reaches a client or a producer).
 *
 * ⚠️ The emulator is SHARED: every document id and the depósito here start with
 * `e2e-estoque-descoberta-`, which no other suite seeds (the window query is a
 * collection-group read filtered on that depósito, so no other suite's rows can
 * match it); the conta id is no other suite's, and no `integracao` document is
 * written, so the conta trigger never fires; `produtos`, their `estoques` and
 * their `prodAmazon` are no trigger path. Every case wipes what it seeds first,
 * and the file leaves nothing behind.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeEstoqueUid } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { type JanelaEstoqueAmazon, LINHAS_POR_PAGINA_JANELA } from './descobertaEstoque';
import {
  CAMPO_CHAVE_JANELA_ESTOQUE_AMAZON,
  DESFECHO_DESCOBERTA_ESTOQUE_AMAZON,
  type DescobertaEstoqueAmazon,
  descobrirJanelaEstoqueAmazon,
} from './descobertaFirestore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-descoberta-';
/** The conta of this file — an id no other suite seeds; no conta document is written. */
const CONTA = `${P}conta`;
const DEP = `${P}dep`;
const CANONICA = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;
const REF_CONTA = `documents/integracao/${CONTA}`;
const JANELA: JanelaEstoqueAmazon = {
  desdeMs: 1_000,
  ateMs: 2_000,
  manterDesdeMs: 1_000,
  commitAposMs: null,
  forcarPorCommit: false,
};
const SEM_PRAZO = { prazoMs: Number.MAX_SAFE_INTEGER };

function db(): Firestore {
  return getAdminFirestore();
}

/** Every path this file may seed, so each case starts clean and the file ends clean. */
const CAMINHOS = new Set<string>();

async function semear(caminho: string, dados: Record<string, unknown>): Promise<void> {
  CAMINHOS.add(caminho);
  await db().doc(caminho).set(dados);
}

async function limpar(): Promise<void> {
  const caminhos = [...CAMINHOS];
  for (let i = 0; i < caminhos.length; i += 400) {
    const lote = db().batch();
    for (const c of caminhos.slice(i, i + 400)) lote.delete(db().doc(c));
    await lote.commit();
  }
}

const produto = (id: string, dados: Record<string, unknown> = {}) =>
  semear(`produtos/${P}${id}`, { nome: `Produto ${id}`, ...dados });

/** An estoque row of `id` at this file's depósito (canonical id and form by default). */
async function linha(
  id: string,
  ultimaModificacao: number,
  { ref = CANONICA, doc }: { ref?: string; doc?: string } = {},
): Promise<string> {
  const caminho = `produtos/${P}${id}/estoques/${doc ?? makeEstoqueUid(`${P}${id}`, DEP)}`;
  await semear(caminho, { depositoOuterRef: ref, ultimaModificacao, quantidade: 3 });
  return caminho;
}

/** A link doc on `dono`, of this conta unless told otherwise, carrying a payload no read returns. */
const vinculo = (dono: string, id: string, sku: string, conta = REF_CONTA) =>
  semear(`produtos/${P}${dono}/prodAmazon/${P}${id}`, {
    contaAmazonOuterRef: conta,
    sku,
    productDataJson: { pesado: 'x'.repeat(256) },
  });

const descobrir = (janela: JanelaEstoqueAmazon = JANELA) =>
  descobrirJanelaEstoqueAmazon(
    { db: db(), contaId: CONTA, depositoId: DEP, agora: () => Date.now() },
    janela,
    SEM_PRAZO,
  );

function completa(r: DescobertaEstoqueAmazon) {
  if (r.tipo !== DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.completa) {
    throw new Error(`esperado completa, veio ${r.tipo}`);
  }
  return r;
}

describe.skipIf(!EMULATED)('the stock discovery on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ a row of the PROJECTED window query still carries its commit updateTime — the document’s own — and the observation is it', async () => {
    await produto('A');
    const caminho = await linha('A', 1_500);
    await vinculo('A', 'la', `${P}SKU-A`);
    const proprio = (await db().doc(caminho).get()).updateTime;
    expect(proprio).toBeDefined();

    // The query exactly as the module builds it, read raw: a projection, and a commit time.
    const snap = await db()
      .collectionGroup('estoques')
      .where('depositoOuterRef', '==', CANONICA)
      .where('ultimaModificacao', '>', JANELA.desdeMs)
      .where('ultimaModificacao', '<=', JANELA.ateMs)
      .orderBy('ultimaModificacao')
      .orderBy(CAMPO_CHAVE_JANELA_ESTOQUE_AMAZON)
      .select('ultimaModificacao')
      .limit(LINHAS_POR_PAGINA_JANELA)
      .get();
    expect(snap.docs.map((d) => [d.ref.path, d.data()])).toEqual([
      [caminho, { ultimaModificacao: 1_500 }],
    ]);
    expect(proprio !== undefined && snap.docs[0]?.updateTime.isEqual(proprio)).toBe(true);

    const r = completa(await descobrir());
    expect(r.observacoes.map((o) => o.sku)).toEqual([`${P}SKU-A`]);
    const obs = r.observacoes[0]?.updateTime;
    expect(obs !== undefined && proprio !== undefined && proprio.isEqual(obs as never)).toBe(true);
  });

  it('★ the bounds on the server: `>` EXCLUDES the start, `<=` INCLUDES the end (a NEAR-MISS pair at each edge)', async () => {
    for (const [id, carimbo] of [
      ['NO-INICIO', 1_000],
      ['DEPOIS', 1_001],
      ['NO-FIM', 2_000],
      ['ALEM', 2_001],
    ] as const) {
      await produto(id);
      await linha(id, carimbo);
      await vinculo(id, `l-${id}`, `${P}SKU-${id}`);
    }
    const r = completa(await descobrir());
    expect(r.observacoes.map((o) => o.sku)).toEqual([`${P}SKU-DEPOIS`, `${P}SKU-NO-FIM`]);
    expect(r.contagem).toMatchObject({ paginas: 2, linhas: 2 });
  });

  it('★ the group cursor pages on EXACTLY after its row: 301 rows sharing one stamp are each read once, across the page boundary', async () => {
    const n = LINHAS_POR_PAGINA_JANELA + 1;
    const lote = db().batch();
    for (let i = 0; i < n; i += 1) {
      const id = `${P}m${String(i).padStart(4, '0')}`;
      const caminho = `produtos/${id}/estoques/${makeEstoqueUid(id, DEP)}`;
      CAMINHOS.add(caminho);
      lote.set(db().doc(caminho), { depositoOuterRef: CANONICA, ultimaModificacao: 1_500 });
    }
    await lote.commit();
    const r = completa(await descobrir());
    // Every row once: 300 on the first page, the 301st on the second, then the empty bare form.
    expect(r.contagem).toMatchObject({
      paginas: 3,
      linhas: n,
      mantidas: n,
      produtos: n,
      sondas: n,
    });
  });

  it('★ both ref forms of the depósito, only this conta’s links (both of its forms), and a wrapper’s link found from its member’s move', async () => {
    await produto('A');
    await produto('B');
    await produto('C');
    await produto('W');
    await produto('M', { paiId: `${P}W` });
    await linha('A', 1_500);
    await linha('B', 1_500, { ref: NUA, doc: `${P}auto-legado` });
    await linha('C', 1_500, { ref: `documents/depositos/${P}outro` });
    await linha('M', 1_600);
    await vinculo('A', 'la', `${P}SKU-A`);
    await vinculo('A', 'la2', `${P}SKU-A-NUA`, `integracao/${CONTA}`);
    await vinculo('A', 'la3', `${P}SKU-A-OUTRA`, `documents/integracao/${P}outra-conta`);
    await vinculo('B', 'lb', `${P}SKU-B`);
    await vinculo('C', 'lc', `${P}SKU-C`);
    await vinculo('W', 'lw', `${P}SKU-W`);
    const r = completa(await descobrir());
    expect(r.observacoes.map((o) => o.sku)).toEqual([
      `${P}SKU-A`,
      `${P}SKU-A-NUA`,
      `${P}SKU-B`,
      `${P}SKU-W`,
    ]);
    expect(r.contagem).toMatchObject({ linhas: 3, produtos: 3, sondas: 4 });
  });

  it('★ the commit test on real Timestamps: a recovery keeps and forces only the row committed after its margin', async () => {
    await produto('A');
    await produto('B');
    const caminhoA = await linha('A', 1_500);
    await vinculo('A', 'la', `${P}SKU-A`);
    await vinculo('B', 'lb', `${P}SKU-B`);
    const commitA = (await db().doc(caminhoA).get()).updateTime;
    if (commitA === undefined) throw new Error('fixture: commit esperado');
    // B commits in a LATER millisecond than A.
    await new Promise((resolver) => setTimeout(resolver, 20));
    await linha('B', 1_500);
    const r = completa(
      await descobrir({
        desdeMs: 1_000,
        ateMs: 2_000,
        manterDesdeMs: null,
        commitAposMs: commitA.toMillis(),
        forcarPorCommit: true,
      }),
    );
    expect(r.observacoes.map((o) => [o.sku, o.forcar])).toEqual([[`${P}SKU-B`, true]]);
    expect(r.contagem).toMatchObject({ linhas: 2, mantidas: 1, produtos: 1 });
  });

  it('an empty window costs its two empty queries and answers nothing', async () => {
    await produto('A');
    await linha('A', 999);
    await vinculo('A', 'la', `${P}SKU-A`);
    const r = completa(await descobrir());
    expect(r.observacoes).toEqual([]);
    expect(r.contagem).toEqual({
      paginas: 2,
      linhas: 0,
      mantidas: 0,
      foraDeProduto: 0,
      produtos: 0,
      sondas: 0,
    });
  });
});
