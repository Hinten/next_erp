import { describe, expect, it } from 'vitest';
import type { Firestore, Transaction } from 'firebase-admin/firestore';

import { sobrevivemVinculosDoProdutoLi } from './sobreviventesLi';

/* -------------------------------------------------------------------------- */
/*                               fake Firestore                               */
/* -------------------------------------------------------------------------- */
/**
 * Per-suite in-memory double, this package's convention (`integracoesComProduto.test.ts`,
 * `sondaSkuLi.test.ts`) — packages/data cannot import from apps/.
 *
 * Scoped to what the survivor read touches: `collection(path)` over link docs seeded by their full
 * path, and the read-only `tx` below, whose `get` runs the target's own `get`. The guarded write
 * that hands this closure its `tx` is the core's, pinned by `integracoesComProduto.test.ts`.
 *
 * ⚠️ Every method that would NARROW a query (`where`, `orderBy`, `limit`, `select`, the cursors)
 * is RECORDED rather than refused, and the double does not apply it: a narrowed read still returns
 * every doc, so only the recorded shape can tell an unfiltered read from a filtered one — which is
 * exactly what the index-decision test asserts. Every `get()` is recorded too, so "nothing was read
 * beside the transaction" means something.
 */
type DocData = Record<string, unknown>;

interface Leitura {
  readonly colecao: string;
  readonly estreitamentos: readonly string[];
}

const ESTREITAMENTOS = [
  'where',
  'orderBy',
  'limit',
  'limitToLast',
  'offset',
  'select',
  'startAt',
  'startAfter',
  'endAt',
  'endBefore',
] as const;

class FakeDb {
  /** Full document path → data. */
  readonly docs = new Map<string, DocData>();
  readonly leituras: Leitura[] = [];

  seed(path: string, data: DocData): this {
    this.docs.set(path, data);
    return this;
  }

  collection(path: string) {
    return this.consulta(path, []);
  }

  private consulta(colecao: string, estreitamentos: readonly string[]) {
    const self = this;
    const metodos = Object.fromEntries(
      ESTREITAMENTOS.map((nome) => [nome, () => self.consulta(colecao, [...estreitamentos, nome])]),
    );
    return {
      ...metodos,
      path: colecao,
      async get() {
        self.leituras.push({ colecao, estreitamentos });
        const prefixo = `${colecao}/`;
        const docs = [...self.docs.entries()]
          .filter(([p]) => p.startsWith(prefixo) && !p.slice(prefixo.length).includes('/'))
          .map(([p, d]) => ({ id: p.slice(prefixo.length), data: () => d }));
        return { docs };
      },
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/** What a `tx.get` was handed — the double's query object, read back through its own fields. */
interface AlvoFake {
  readonly path: string;
  readonly get: () => Promise<unknown>;
}

/**
 * A read-only `tx`, enough for a survivor closure — which only reads. Every target it is handed is
 * kept in `alvos`, so a test can say WHAT the guarded read read.
 */
function txLeitura(alvos: AlvoFake[] = []): Transaction {
  return {
    get: async (alvo: AlvoFake) => {
      alvos.push(alvo);
      return alvo.get();
    },
  } as unknown as Transaction;
}

/* ---------------------------------- fixtures ------------------------------ */

const PRODUTO = 'produto-li-1';
const OUTRO_PRODUTO = 'produto-li-2';
const C1 = 'C1';
const C2 = 'C2';
/** The spec's public example store product id. */
const ID_LI = 182904918;

/** A counting link of conta {@link C1}: a store product id, not in the trash. */
function link(over: DocData = {}): DocData {
  return {
    contaLojaIntegrada: `documents/integracao/${C1}`,
    id: ID_LI,
    sku: 'SKU-TESTE-1',
    nome: 'Produto de teste',
    ativo: true,
    bloqueado: false,
    removido: false,
    ...over,
  };
}

function semearLink(db: FakeDb, id: string, over: DocData = {}, produto = PRODUTO): void {
  db.seed(`produtos/${produto}/produtolojaintegrada/${id}`, link(over));
}

async function sobrevive(db: FakeDb, conta = C1, produto = PRODUTO): Promise<boolean> {
  return sobrevivemVinculosDoProdutoLi(asDb(db), produto, conta)(txLeitura());
}

/* -------------------------------------------------------------------------- */
/*                     what survives — the plan's own readers                  */
/* -------------------------------------------------------------------------- */

describe('sobrevivemVinculosDoProdutoLi — what survives', () => {
  it('a counting sibling of the SAME conta survives', async () => {
    const db = new FakeDb();
    semearLink(db, 'l1', { removido: true });
    semearLink(db, 'l2');

    await expect(sobrevive(db)).resolves.toBe(true);
  });

  it.each([
    ['a hidden one', { ativo: false }],
    ['a blocked one', { bloqueado: true }],
    ['its id as decimal text', { id: '182904918' }],
    ['its ref in the bare form', { contaLojaIntegrada: `integracao/${C1}` }],
    ['its ref with a leading slash', { contaLojaIntegrada: `/documents/integracao/${C1}` }],
  ])('EQUAL: %s survives too — the filter is the plan’s own readers', async (_caso, over) => {
    // Each of these COUNTS for C1 in the plan, so each must survive here: a query filtered on
    // the two canonical ref forms, or typed on `id`, would miss it and drop a live conta.
    const db = new FakeDb();
    semearLink(db, 'l1', over);

    await expect(sobrevive(db)).resolves.toBe(true);
  });

  it.each([
    ['of ANOTHER conta', { contaLojaIntegrada: `documents/integracao/${C2}` }],
    ['in the trash', { removido: true }],
    ["with id '07'", { id: '07' }],
    ['with id null', { id: null }],
    ['with a malformed conta ref', { contaLojaIntegrada: 'documents/categorias/C1' }],
    ['with its conta ref inside an array', { contaLojaIntegrada: [`documents/integracao/${C1}`] }],
    [
      'carrying only another channel’s conta field',
      { contaLojaIntegrada: undefined, contaOuterRef: `documents/integracao/${C1}` },
    ],
  ])('NEAR-MISS: a sibling %s does not survive', async (_caso, over) => {
    const db = new FakeDb();
    semearLink(db, 'l1', over);

    await expect(sobrevive(db)).resolves.toBe(false);
  });

  it('an empty subcollection answers false', async () => {
    await expect(sobrevive(new FakeDb())).resolves.toBe(false);
  });

  it('a counting link under ANOTHER produto is not this produto’s survivor', async () => {
    const db = new FakeDb();
    semearLink(db, 'l1', {}, OUTRO_PRODUTO);

    await expect(sobrevive(db)).resolves.toBe(false);
    await expect(sobrevive(db, C1, OUTRO_PRODUTO)).resolves.toBe(true);
  });

  it('a link document with no data reads as an empty link — false, never a throw', async () => {
    const tx = {
      get: async () => ({ docs: [{ data: () => undefined }] }),
    } as unknown as Transaction;

    await expect(sobrevivemVinculosDoProdutoLi(asDb(new FakeDb()), PRODUTO, C1)(tx)).resolves.toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                 the read itself — rule 7 and the index decision             */
/* -------------------------------------------------------------------------- */

describe('sobrevivemVinculosDoProdutoLi — the read', () => {
  it('⛔ the verdict is the TRANSACTION’s read, never a read beside it', async () => {
    // Rule 7: only a read inside the guarded write's read set is a guard. A plain `get()` beside
    // it would miss a counting link written between that read and the commit, and drop a live
    // conta. So the transaction here answers the OPPOSITE of what is stored, both ways, and the
    // verdict must follow the transaction each time.
    const db = new FakeDb();
    const alvos: AlvoFake[] = [];
    const txQueVe = (docs: DocData[]): Transaction =>
      ({
        get: async (alvo: AlvoFake) => {
          alvos.push(alvo);
          return { docs: docs.map((d) => ({ data: () => d })) };
        },
      }) as unknown as Transaction;

    // Nothing stored, a counting link in the transaction's snapshot ⇒ it survives.
    await expect(
      sobrevivemVinculosDoProdutoLi(asDb(db), PRODUTO, C1)(txQueVe([link()])),
    ).resolves.toBe(true);
    // A counting link stored, none in the transaction's snapshot ⇒ nothing survives.
    semearLink(db, 'l1');
    await expect(sobrevivemVinculosDoProdutoLi(asDb(db), PRODUTO, C1)(txQueVe([]))).resolves.toBe(
      false,
    );

    // Nothing was read beside the transaction...
    expect(db.leituras).toEqual([]);
    // ...and what it was handed is this produto's own link collection.
    expect(alvos.map((a) => a.path)).toEqual([
      `produtos/${PRODUTO}/produtolojaintegrada`,
      `produtos/${PRODUTO}/produtolojaintegrada`,
    ]);
  });

  it('builds the closure without reading, and every run reads afresh (a retry re-derives)', async () => {
    // Nothing may be captured before the guarded write opens: a retry re-runs the closure, and a
    // verdict cached from an earlier attempt would be re-applied over the winner.
    const db = new FakeDb();
    const sobrevivem = sobrevivemVinculosDoProdutoLi(asDb(db), PRODUTO, C1);
    expect(db.leituras).toEqual([]);

    await expect(sobrevivem(txLeitura())).resolves.toBe(false);
    semearLink(db, 'l1');
    await expect(sobrevivem(txLeitura())).resolves.toBe(true);
    semearLink(db, 'l1', { removido: true });
    await expect(sobrevivem(txLeitura())).resolves.toBe(false);
    expect(db.leituras).toHaveLength(3);
  });

  it('⛔ the read is UNFILTERED: the produto’s WHOLE subcollection — no where, no order, no limit, no projection', async () => {
    // THE INDEX DECISION, pinned (the module's header): no `produtolojaintegrada` COLLECTION
    // index exists, so a `where` would be an undeclared predicate that silently full-scans on
    // Enterprise — and the conta filter must stay in code, where it is the plan's own readers.
    const db = new FakeDb();
    semearLink(db, 'l1');
    semearLink(db, 'l2', { contaLojaIntegrada: `documents/integracao/${C2}` });
    const alvos: AlvoFake[] = [];

    await sobrevivemVinculosDoProdutoLi(asDb(db), PRODUTO, C1)(txLeitura(alvos));

    expect(alvos).toHaveLength(1);
    expect(db.leituras).toEqual([
      { colecao: `produtos/${PRODUTO}/produtolojaintegrada`, estreitamentos: [] },
    ]);
  });
});
