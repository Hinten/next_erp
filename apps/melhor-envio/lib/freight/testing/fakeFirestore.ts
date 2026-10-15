/**
 * TEST-ONLY in-memory Firestore for the comprar claim (#1677), over the SHARED
 * optimistic-concurrency engine (`@delfrance/data/testing`) — never a second OCC
 * model (ADR 0011). Imported by `*.test.ts` only.
 *
 * It implements just the Admin-SDK surface the claim and the route use, so the
 * REAL collection handles run against it (`compraEtiquetaCollection.docRef`,
 * `pedidoCollection.docRef` — the document paths under test are the real ones):
 *
 *  - `collection(path).doc(id)` → a ref carrying its `path`, with `get()`;
 *  - `getAll(...refs)` (the fence's batched read, outside a transaction);
 *  - the transaction shape via `OccEngine`, including `getAll`, a DOTTED-path
 *    `update` (a field path, as the Admin SDK reads it) and `delete` — which the
 *    Shopee fake this follows does not supply, and the claim needs.
 *
 * ⚠️ Every write here is transactional, so every write bumps the engine's
 * versions; the code under test makes no plain writes. A read outside a
 * transaction (the fence) sees committed state only, like the real `getAll`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { OccEngine, type OccTransaction, type OccWriteKind } from '@delfrance/data/testing';

type Dados = Record<string, unknown>;

export interface SnapFake {
  readonly id: string;
  readonly exists: boolean;
  data(): Dados | undefined;
}

export interface RefFake {
  readonly path: string;
  readonly id: string;
  get(): Promise<SnapFake>;
}

function grpc(code: number, msg: string): Error & { code: number } {
  return Object.assign(new Error(msg), { code });
}

/** Set `valor` at a dotted field path, creating intermediate maps (Admin `update` semantics). */
function aplicarCaminho(alvo: Dados, caminho: string, valor: unknown): void {
  const partes = caminho.split('.');
  let atual = alvo;
  for (const parte of partes.slice(0, -1)) {
    const proximo = atual[parte];
    if (proximo === null || typeof proximo !== 'object' || Array.isArray(proximo)) {
      atual[parte] = {};
    }
    atual = atual[parte] as Dados;
  }
  atual[partes[partes.length - 1]!] = valor;
}

export class FirestoreFake {
  private readonly docs = new Map<string, Dados>();

  /** Exposed so a test can hold a commit (`beforeCommit`) or read `txLog`. */
  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => this.aplicar(kind, path, data),
    applyDelete: (path) => {
      this.docs.delete(path);
    },
  });

  private aplicar(kind: OccWriteKind, path: string, data: Dados): void {
    const atual = this.docs.get(path);
    if (kind === 'create' && atual) throw grpc(6, 'ALREADY_EXISTS');
    if (kind === 'update') {
      if (!atual) throw grpc(5, 'NOT_FOUND');
      const copia = structuredClone(atual);
      for (const [campo, valor] of Object.entries(data)) aplicarCaminho(copia, campo, valor);
      this.docs.set(path, copia);
      return;
    }
    this.docs.set(path, structuredClone(data));
  }

  /** Seed a document as already committed. */
  semear(path: string, dados: Dados): void {
    this.docs.set(path, structuredClone(dados));
  }

  /** The committed document, or `undefined`. */
  dados(path: string): Dados | undefined {
    const d = this.docs.get(path);
    return d === undefined ? undefined : structuredClone(d);
  }

  ref(path: string): RefFake {
    const id = path.slice(path.lastIndexOf('/') + 1);
    return {
      path,
      id,
      get: () => {
        const d = this.docs.get(path);
        return Promise.resolve({
          id,
          exists: d !== undefined,
          data: () => (d === undefined ? undefined : structuredClone(d)),
        });
      },
    };
  }

  // ── the Admin-SDK surface the code under test reaches ─────────────────────

  collection(colPath: string): { doc(id: string): RefFake } {
    return { doc: (id: string) => this.ref(`${colPath}/${id}`) };
  }

  getAll(...refs: RefFake[]): Promise<SnapFake[]> {
    return Promise.all(refs.map((r) => r.get()));
  }

  runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }

  /** This fake, typed as the Admin `Firestore` the code under test expects. */
  comoFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}
