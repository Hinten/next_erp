import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  PREFIXO_PROVISORIA,
  limparMensagensProvisorias,
  makeMensagemProvisoriaId,
} from './mensagemProvisoria';

type DocData = Record<string, unknown>;

/**
 * Own FakeDb (in-repo convention). It models the ONE thing under test: a doc-id
 * RANGE query, which is how the cleanup finds provisional bubbles without a
 * schema field to mark them.
 */
class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }
  collection(path: string) {
    const col = this.col(path);
    const q = (min: string | null, max: string | null) => ({
      where: (campo: unknown, op: string, valor: unknown) => {
        // Only the documentId() range is modelled — anything else is a bug in
        // the code under test, not something to silently accept. A real
        // `FieldPath.documentId()` stringifies to `__name__`, which is what makes
        // this a faithful stand-in rather than a marker of our own invention.
        if (String(campo) !== '__name__') {
          throw new Error(`unexpected where on ${String(campo)}`);
        }
        if (op === '>=') return q(String(valor), max);
        if (op === '<') return q(min, String(valor));
        throw new Error(`unexpected op ${op}`);
      },
      get: async () => ({
        docs: [...col.entries()]
          .filter(([id]) => (min == null || id >= min) && (max == null || id < max))
          .map(([id, data]) => ({
            id,
            data: () => data,
            ref: {
              delete: async () => {
                col.delete(id);
              },
            },
          })),
      }),
    });
    return { ...q(null, null), doc: (id: string) => ({ id, __col: col }) };
  }
}
const asDb = (f: FakeDb) => f as unknown as Firestore;

const CONVERSA = 'conv-1';
const CAMINHO = `chat/${CONVERSA}/mensagem`;

describe('makeMensagemProvisoriaId', () => {
  it('is unique per millisecond, NOT bucketed by minute', () => {
    // ⚠️ The bug this replaced: the id was `local-<pack>-<minute>`, so two
    // replies inside the same minute collided on one doc and the first was
    // silently overwritten — ordinary behaviour in a chat, and it dropped a
    // message the customer had already received.
    const a = makeMensagemProvisoriaId(1_753_180_800_000);
    const b = makeMensagemProvisoriaId(1_753_180_800_000 + 1_000); // 1s later
    expect(a).not.toBe(b);
  });

  it('carries the prefix the cleanup range-scans on', () => {
    expect(makeMensagemProvisoriaId(1)).toBe(`${PREFIXO_PROVISORIA}1`);
  });
});

describe('limparMensagensProvisorias', () => {
  it('deletes a provisional bubble the import superseded', async () => {
    // ⚠️ Without this the reply sat in the thread TWICE forever: once here,
    // once at the ML id the importer writes it to.
    const db = new FakeDb();
    db.seed(CAMINHO, makeMensagemProvisoriaId(1_000), { conteudo: 'oi', timestamp: 1_000 });

    const n = await limparMensagensProvisorias(asDb(db), CONVERSA, 2_000);

    expect(n).toBe(1);
    expect(db.docs(CAMINHO).size).toBe(0);
  });

  it('KEEPS a bubble newer than the import — its message has not come back yet', async () => {
    // A reply sent after ML produced this snapshot is not in it. Deleting the
    // placeholder would reopen the exact gap it exists to cover.
    const db = new FakeDb();
    db.seed(CAMINHO, makeMensagemProvisoriaId(5_000), { conteudo: 'novo', timestamp: 5_000 });

    const n = await limparMensagensProvisorias(asDb(db), CONVERSA, 2_000);

    expect(n).toBe(0);
    expect(db.docs(CAMINHO).size).toBe(1);
  });

  it('deletes one at EXACTLY the import boundary', async () => {
    // `<=`, not `<`: a message whose timestamp equals the newest imported one
    // IS in that import.
    const db = new FakeDb();
    db.seed(CAMINHO, makeMensagemProvisoriaId(2_000), { conteudo: 'oi', timestamp: 2_000 });
    expect(await limparMensagensProvisorias(asDb(db), CONVERSA, 2_000)).toBe(1);
  });

  it('never touches a REAL message, whatever its timestamp', async () => {
    // The range is the `local-` doc-id prefix. An ML-keyed id sorts outside it,
    // so the importer's own writes can never be collected.
    const db = new FakeDb();
    db.seed(CAMINHO, 'fd1d2e37ad004ede9e0bf25d1215002d', { conteudo: 'real', timestamp: 1 });
    db.seed(CAMINHO, 'ja_respondidanull', { conteudo: 'resposta', timestamp: 1 });
    db.seed(CAMINHO, 'PDD9545', { conteudo: 'motivo', timestamp: 1 });

    const n = await limparMensagensProvisorias(asDb(db), CONVERSA, 9_999_999);

    expect(n).toBe(0);
    expect(db.docs(CAMINHO).size).toBe(3);
  });

  it('is a no-op when the import carried no timestamp at all', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, makeMensagemProvisoriaId(1_000), { conteudo: 'oi', timestamp: 1_000 });
    expect(await limparMensagensProvisorias(asDb(db), CONVERSA, null)).toBe(0);
    expect(db.docs(CAMINHO).size).toBe(1);
  });

  it('ignores a provisional doc with no usable timestamp rather than deleting it', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, makeMensagemProvisoriaId(1_000), { conteudo: 'oi', timestamp: null });
    expect(await limparMensagensProvisorias(asDb(db), CONVERSA, 9_999)).toBe(0);
  });
});
