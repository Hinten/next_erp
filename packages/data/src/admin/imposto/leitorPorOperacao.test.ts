import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { criarLeitorDeImpostoPorOperacao, MOTIVO_LEITURA_IMPOSTO } from './leitorPorOperacao';

/**
 * The HANDLE-shaped in-memory double this folder's `firestoreImpostoResolver`
 * suite uses (the whole resolved path arrives as one argument). Kept local —
 * the package convention is one double per suite.
 */
type DocData = Record<string, unknown>;

class FakeDb {
  private readonly cols = new Map<string, Map<string, DocData>>();
  readonly lidos: string[] = [];

  seed(colPath: string, id: string, data: DocData): this {
    let col = this.cols.get(colPath);
    if (!col) this.cols.set(colPath, (col = new Map()));
    col.set(id, data);
    return this;
  }

  collection(colPath: string) {
    const col = this.cols.get(colPath) ?? new Map<string, DocData>();
    const self = this;
    return {
      doc(id: string) {
        return {
          async get() {
            self.lidos.push(`${colPath}/${id}`);
            const data = col.get(id);
            return { exists: data != null, id, data: () => data };
          },
        };
      },
      async get() {
        self.lidos.push(colPath);
        return {
          docs: [...col.entries()].map(([id, data]) => ({
            id,
            ref: { path: `${colPath}/${id}` },
            data: () => data,
          })),
        };
      },
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

const OP = 'op-venda';
const IMPOSTO_PRODUTO = {
  impostoOpercaoOuterRef: `operacao/${OP}`,
  origem: '0',
  NCM: '61091000',
  configuracaoICMS: { crt: '1', csosn: '102' },
};

function dbComOperacao(operacao: DocData = { nome: 'Venda', NCM: '61099000', unidade: 'UN' }) {
  return new FakeDb().seed('operacao', OP, operacao).seed('produtos', 'p1', {});
}

describe('criarLeitorDeImpostoPorOperacao', () => {
  it('no operação ref ⇒ `sem-operacao` with ZERO reads', async () => {
    const db = new FakeDb();
    const leitor = criarLeitorDeImpostoPorOperacao({ db: asDb(db), operacaoOuterRef: null });
    expect(await leitor.ler('p1')).toEqual({
      imposto: null,
      operacao: null,
      motivo: MOTIVO_LEITURA_IMPOSTO.semOperacao,
    });
    expect(db.lidos).toEqual([]);
  });

  it('a ref to a missing operação ⇒ `operacao-inexistente`, memoised: ONE read for the whole run', async () => {
    const db = new FakeDb();
    const leitor = criarLeitorDeImpostoPorOperacao({
      db: asDb(db),
      operacaoOuterRef: 'operacao/nao-existe',
    });
    const a = await leitor.ler('p1');
    const b = await leitor.ler('p2');
    expect(a.motivo).toBe(MOTIVO_LEITURA_IMPOSTO.operacaoInexistente);
    expect(b.motivo).toBe(MOTIVO_LEITURA_IMPOSTO.operacaoInexistente);
    expect(db.lidos).toEqual(['operacao/nao-existe']);
  });

  it.each([`documents/operacao/${OP}`, `operacao/${OP}`, OP])(
    'resolves through the trailing segment of %s and hands back the RAW operação',
    async (ref) => {
      const db = dbComOperacao().seed('produtos/p1/imposto', OP, IMPOSTO_PRODUTO);
      const leitor = criarLeitorDeImpostoPorOperacao({ db: asDb(db), operacaoOuterRef: ref });
      const leitura = await leitor.ler('p1');
      expect(leitura.motivo).toBeNull();
      expect(leitura.imposto?.NCM).toBe('61091000');
      // RAW: the non-Imposto keys survive, so the per-field fallback can read them.
      expect(leitura.operacao).toMatchObject({ nome: 'Venda', NCM: '61099000' });
    },
  );

  it('two concurrent `ler()`s share ONE bundle read', async () => {
    const db = dbComOperacao()
      .seed('produtos/p1/imposto', OP, IMPOSTO_PRODUTO)
      .seed('produtos', 'p2', {})
      .seed('produtos/p2/imposto', OP, IMPOSTO_PRODUTO);
    const leitor = criarLeitorDeImpostoPorOperacao({ db: asDb(db), operacaoOuterRef: OP });
    await Promise.all([leitor.ler('p1'), leitor.ler('p2')]);
    expect(db.lidos.filter((p) => p === `operacao/${OP}`)).toHaveLength(1);
    expect(db.lidos.filter((p) => p === `operacao/${OP}/regras`)).toHaveLength(1);
  });

  it('every tier falling through ⇒ `sem-imposto`', async () => {
    // An operação with no usable default (no `origem`) makes tier 5 fall through too.
    const db = dbComOperacao({ nome: 'Venda sem padrão' });
    const leitor = criarLeitorDeImpostoPorOperacao({ db: asDb(db), operacaoOuterRef: OP });
    expect(await leitor.ler('p1')).toEqual({
      imposto: null,
      operacao: null,
      motivo: MOTIVO_LEITURA_IMPOSTO.semImposto,
    });
  });
});
