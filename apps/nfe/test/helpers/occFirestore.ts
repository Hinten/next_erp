/**
 * TEST-ONLY in-memory Firestore over the SHARED optimistic-concurrency engine
 * (`@delfrance/data/testing`) — never a second OCC model (ADR 0011). For the
 * #1675 claim races: two transactions started together, one held at
 * `occ.beforeCommit`, so the other commits first and the held one must abort,
 * re-run its callback and decide again on the fresh snapshot.
 *
 * It implements only the Admin surface the claims reach: `collection(p).doc(id)`
 * (what the collection handles' `docRef` builds), a snapshot with `updateTime`
 * (bumped on every committed write), and `runTransaction` — whose `tx.set` takes
 * the Admin `{ merge: true }` option the engine's own `set` does not model.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { OccEngine, type OccWriteKind } from '@delfrance/data/testing';

type Dados = Record<string, unknown>;

/** Marks a buffered `set` as a merge — stripped before the doc is stored. */
const MESCLAR = '__mesclar__';

export interface RefFake {
  readonly path: string;
  readonly id: string;
  get(): Promise<{
    id: string;
    exists: boolean;
    data(): Dados | undefined;
    updateTime: Timestamp | undefined;
  }>;
}

export class FirestoreOcc {
  private readonly docs = new Map<string, Dados>();
  private readonly versoes = new Map<string, number>();

  /** Exposed so a test can hold a commit (`beforeCommit`) or read `txLog`. */
  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => this.aplicar(kind, path, data),
  });

  private aplicar(kind: OccWriteKind, path: string, data: Dados): void {
    const atual = this.docs.get(path);
    if (kind === 'set' && data[MESCLAR] === true) {
      const { [MESCLAR]: _marca, ...patch } = data;
      this.docs.set(path, { ...(atual ?? {}), ...structuredClone(patch) });
    } else if (kind === 'set') {
      this.docs.set(path, structuredClone(data));
    } else {
      throw new Error(`FirestoreOcc: a ${kind} write is not modelled — the claims only set`);
    }
    this.versoes.set(path, (this.versoes.get(path) ?? 0) + 1);
  }

  /** Seed a document as already committed. */
  semear(path: string, dados: Dados): void {
    this.docs.set(path, structuredClone(dados));
    this.versoes.set(path, (this.versoes.get(path) ?? 0) + 1);
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
        const versao = this.versoes.get(path);
        return Promise.resolve({
          id,
          exists: d !== undefined,
          data: () => (d === undefined ? undefined : structuredClone(d)),
          updateTime: versao === undefined ? undefined : Timestamp.fromMillis(versao),
        });
      },
    };
  }

  collection(colPath: string): { doc(id: string): RefFake } {
    return { doc: (id: string) => this.ref(`${colPath}/${id}`) };
  }

  runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return this.occ.runTransaction((tx) =>
      fn({
        get: tx.get,
        getAll: tx.getAll,
        set: (ref: RefFake, data: Dados, opts?: { merge?: boolean }) =>
          tx.set(ref, opts?.merge === true ? { ...data, [MESCLAR]: true } : data),
      }),
    );
  }

  /** This fake, typed as the Admin `Firestore` the code under test expects. */
  comoFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}
