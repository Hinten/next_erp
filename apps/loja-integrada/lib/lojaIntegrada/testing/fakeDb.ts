/**
 * A fake Admin-SDK Firestore, **for tests only**.
 *
 * ⚠️ Nothing under `lib/lojaIntegrada/**` outside a `*.test.ts` may import this
 * module (the `apps/shopee/lib/shopee/testing/fakeDb.ts` precedent). Shopee's
 * double is the model but cannot be imported: apps have no dependency edges
 * between them, and its header forbids non-test importers.
 *
 * It exists so the credential store, the park, the avisos and the expiry sweep
 * run through the **real** `escreverAviso` / `resolverAviso` rather than a mock
 * of them: the property under test is what lands in the document, and a mocked
 * writer cannot show that.
 *
 * ## Exactly what it supports — and it THROWS on anything else
 *
 *  - `doc.get()` → `{ exists, id, updateTime, readTime, data() }`;
 *  - `doc.create(data)` — rejects gRPC 6 (ALREADY_EXISTS) on an existing doc;
 *  - `doc.update(patch)` — rejects gRPC 5 (NOT_FOUND) on a missing doc;
 *  - `doc.update(patch, { lastUpdateTime })` — rejects gRPC 9
 *    (FAILED_PRECONDITION) on a stale stamp AND on a missing doc. ⚠️ Not 5: the
 *    real SDK REPLACES its default `{ exists: true }` precondition with the
 *    stamp (`WriteBatch.update` in `@google-cloud/firestore`), so the server
 *    only ever sees an update-time precondition, and a document that is gone
 *    fails it;
 *  - `doc.delete()` — idempotent, like the real one;
 *  - every write resolves `{ writeTime }`;
 *  - the `{ __increment: n }` sentinel ({@link increment}), APPLIED on write,
 *    because `escreverAviso` writes `deps.increment(1)`;
 *  - `collection().where(campo, '==', valor)`, `orderBy`, `limit`,
 *    `startAfter(doc)` and `get()` → `{ docs, empty, size, readTime }` — see
 *    "Queries" below.
 *
 * Everything else — `set`, any other operator, a dotted update key, an
 * `undefined` value, a precondition that is not a stamp, an `orderBy` over a
 * value that is not null/boolean/number/string — throws. That is the Shopee
 * step-8 lesson: a double that silently answers "matches nothing" or "wrote it"
 * for a call it does not model lets every suite read green. Atomic
 * multi-document writes are NOT modelled at all: nothing in this app runs one,
 * and the park is a single-document precondition write.
 *
 * ## Queries — the server's semantics, not a convenient approximation
 *
 *  - **Immutable**: every builder method returns a NEW query; the one it was
 *    called on is unchanged, like a real `Query`.
 *  - **`orderBy` filters for existence**: a document LACKING the field is
 *    dropped (a `null` value is kept). Values order by type first — null,
 *    boolean, number, string — then by value; ties break on the document id in
 *    the direction of the LAST `orderBy` (ascending with none).
 *  - **`startAfter(snapshot)` seeks by the snapshot's VALUES** (its `orderBy`
 *    fields, then its id), captured when it is called — never by looking the id
 *    up in the new result. So a cursor document that has since stopped matching
 *    (a resolved aviso, a deleted row) pages on exactly as it does in
 *    production. A snapshot missing an `orderBy` field, and an `orderBy` after
 *    a cursor, throw, as the SDK does.
 *
 * ## Read times
 *
 * Every snapshot carries `readTime` = the latest stamp issued so far. A read at
 * that time sees every write stamped `<=` it, and any later write takes a
 * strictly greater stamp — the server's guarantee, and what lets an ABSENCE be
 * ordered against a later commit.
 *
 * ## The stamps
 *
 * {@link CarimboFake} is `Timestamp`-shaped — `seconds`, `nanoseconds`,
 * `isEqual`, `toMillis` — and every write takes the next one from ONE global
 * clock that advances by a single MICROSECOND. So stamps rise strictly per
 * document (and across documents), and two consecutive commits share the same
 * millisecond: a guard that compared `toMillis()` instead of µs would see them
 * as equal, which is exactly the bug the µs clock exists to avoid.
 *
 * ⚠️ An object, not a number: two reads of one real `Timestamp` are two
 * instances, so `a.updateTime === b.updateTime` is false for equal real stamps.
 * The precondition here compares through `isEqual`, never by reference.
 *
 * ## Interleavings
 *
 * {@link FakeDb.antesDaProximaEscrita} runs a callback right before the next
 * write on a path is applied — after the caller's read, before its write — which
 * is exactly the window a concurrent writer lands in. The intercepted write then
 * meets the state that callback left behind, precondition included.
 */
import type { Firestore } from 'firebase-admin/firestore';

export type DocData = Record<string, unknown>;

/** A `Timestamp`-shaped commit stamp. */
export interface CarimboFake {
  readonly seconds: number;
  readonly nanoseconds: number;
  isEqual(outro: unknown): boolean;
  toMillis(): number;
}

/** The first stamp's epoch, in µs: 2027-01-15T08:00:00Z. */
const INICIO_US = 1_800_000_000_000_000;

function carimbo(us: number): CarimboFake {
  const seconds = Math.floor(us / 1_000_000);
  const nanoseconds = (us % 1_000_000) * 1000;
  return {
    seconds,
    nanoseconds,
    isEqual: (outro: unknown) =>
      ehCarimbo(outro) && outro.seconds === seconds && outro.nanoseconds === nanoseconds,
    toMillis: () => seconds * 1000 + Math.floor(nanoseconds / 1_000_000),
  };
}

function ehCarimbo(v: unknown): v is CarimboFake {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { seconds?: unknown }).seconds === 'number' &&
    typeof (v as { nanoseconds?: unknown }).nanoseconds === 'number'
  );
}

/** An Admin-SDK-shaped failure: a plain `Error` carrying a numeric gRPC `code`. */
export function grpc(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The increment sentinel this fake applies — pass it as `deps.increment`. */
export function increment(by: number): unknown {
  return { __increment: by };
}

function ehIncremento(v: unknown): v is { __increment: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { __increment?: unknown }).__increment === 'number'
  );
}

/** The real SDK refuses `undefined` anywhere in a payload; so does this. */
function recusarIndefinido(valor: unknown, caminho: string): void {
  if (valor === undefined) {
    throw new Error(`FakeDb: valor undefined em ${caminho} — o Admin SDK recusa`);
  }
  if (typeof valor === 'object' && valor !== null && !Array.isArray(valor)) {
    for (const [k, v] of Object.entries(valor as DocData)) recusarIndefinido(v, `${caminho}.${k}`);
  }
}

interface Stored {
  data: DocData;
  updateTime: CarimboFake;
}

interface Filtro {
  campo: string;
  valor: unknown;
}

interface Ordem {
  campo: string;
  direcao: 'asc' | 'desc';
}

/** One write, as {@link FakeDb.escritas} records it. */
export interface EscritaFake {
  readonly verbo: 'create' | 'update' | 'delete';
  readonly caminho: string;
  /** The payload as handed over (`null` for a delete). */
  readonly dados: DocData | null;
  readonly writeTime: CarimboFake;
}

/** One query, as {@link FakeDb.consultas} records it. */
export interface ConsultaFake {
  readonly colecao: string;
  readonly filtros: readonly [string, '==', unknown][];
  readonly ordens: readonly [string, 'asc' | 'desc'][];
  readonly limite: number | null;
  readonly apos: string | null;
}

/**
 * Firestore's cross-type order, for the types this fake models: null, then
 * booleans, then numbers, then strings. Anything else throws.
 */
function rankDoTipo(v: unknown, campo: string): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (typeof v === 'string') return 3;
  throw new Error(`FakeDb: orderBy('${campo}') sobre um valor ${typeof v} não é modelado`);
}

function compararValores(a: unknown, b: unknown, campo: string): number {
  const ra = rankDoTipo(a, campo);
  const rb = rankDoTipo(b, campo);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a === b) return 0;
  return (a as boolean | number | string) < (b as boolean | number | string) ? -1 : 1;
}

/** A row as the ordering sees it: an id and the values of its fields. */
interface Posicao {
  readonly id: string;
  readonly data: DocData;
}

/**
 * The server's total order: each `orderBy` field, then the document id in the
 * direction of the LAST `orderBy` (ascending when there is none).
 */
function compararPosicoes(a: Posicao, b: Posicao, ordens: readonly Ordem[]): number {
  for (const { campo, direcao } of ordens) {
    const c = compararValores(a.data[campo], b.data[campo], campo);
    if (c !== 0) return direcao === 'desc' ? -c : c;
  }
  const c = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return (ordens.at(-1)?.direcao ?? 'asc') === 'desc' ? -c : c;
}

/** A `startAfter` cursor: the snapshot's id and values, frozen when it was given. */
interface Cursor {
  readonly id: string;
  readonly data: DocData;
}

/** Everything a query carries. Never mutated: each builder call copies it. */
interface EstadoConsulta {
  readonly filtros: readonly Filtro[];
  readonly ordens: readonly Ordem[];
  readonly limite: number | null;
  readonly apos: Cursor | null;
}

export class FakeDb {
  private readonly store = new Map<string, Stored>();
  private relogioUs = INICIO_US;
  private readonly ganchos = new Map<string, (() => Promise<void> | void)[]>();
  private readonly falhasDeLeitura = new Map<string, Error>();
  private readonly falhasDeEscrita = new Map<string, Error>();
  private readonly falhasDeConsulta = new Map<string, Error>();

  /** Every write that LANDED, in order. A refused write is not here. */
  readonly escritas: EscritaFake[] = [];
  /** Every document path read with `get()`, in order. */
  readonly leituras: string[] = [];
  /** Every query, whole, in order. */
  readonly consultas: ConsultaFake[] = [];

  /** Store a document without logging a write (fixtures). Takes a stamp. */
  seed(caminho: string, data: DocData): CarimboFake {
    recusarIndefinido(data, caminho);
    const updateTime = this.proximoCarimbo();
    this.store.set(caminho, { data: structuredClone(data), updateTime });
    return updateTime;
  }

  /** The stored document, or `undefined`. A copy: mutating it changes nothing. */
  ler(caminho: string): DocData | undefined {
    const atual = this.store.get(caminho);
    return atual === undefined ? undefined : structuredClone(atual.data);
  }

  /** The stored document's commit stamp, or `undefined` when absent. */
  carimboDe(caminho: string): CarimboFake | undefined {
    return this.store.get(caminho)?.updateTime;
  }

  /** Document ids directly under a collection path, in insertion order. */
  idsEm(colecao: string): string[] {
    const prefixo = `${colecao}/`;
    return [...this.store.keys()]
      .filter((p) => p.startsWith(prefixo) && !p.slice(prefixo.length).includes('/'))
      .map((p) => p.slice(prefixo.length));
  }

  /** Writes that landed on one path, in order. */
  escritasEm(caminho: string): EscritaFake[] {
    return this.escritas.filter((e) => e.caminho === caminho);
  }

  /**
   * Run `fn` right before the NEXT write on `caminho` is applied (one-shot;
   * queue several to intercept several writes). `fn` may write through this
   * same fake — its writes are not intercepted by the hook that is running.
   */
  antesDaProximaEscrita(caminho: string, fn: () => Promise<void> | void): void {
    this.ganchos.set(caminho, [...(this.ganchos.get(caminho) ?? []), fn]);
  }

  /** Every `get()` on `caminho` rejects with `err` until cleared with `null`. */
  falharLeitura(caminho: string, err: Error | null): void {
    if (err === null) this.falhasDeLeitura.delete(caminho);
    else this.falhasDeLeitura.set(caminho, err);
  }

  /** Every query on `colecao` rejects with `err` until cleared with `null`. */
  falharConsulta(colecao: string, err: Error | null): void {
    if (err === null) this.falhasDeConsulta.delete(colecao);
    else this.falhasDeConsulta.set(colecao, err);
  }

  /** Every write on `caminho` rejects with `err` until cleared with `null`. */
  falharEscrita(caminho: string, err: Error | null): void {
    if (err === null) this.falhasDeEscrita.delete(caminho);
    else this.falhasDeEscrita.set(caminho, err);
  }

  private proximoCarimbo(): CarimboFake {
    this.relogioUs += 1;
    return carimbo(this.relogioUs);
  }

  /** A snapshot's `readTime`: the latest stamp issued; every later write is greater. */
  private carimboDeLeitura(): CarimboFake {
    return carimbo(this.relogioUs);
  }

  private async antesDeEscrever(caminho: string): Promise<void> {
    const falha = this.falhasDeEscrita.get(caminho);
    if (falha) throw falha;
    const fila = this.ganchos.get(caminho);
    const gancho = fila?.shift();
    if (fila !== undefined && fila.length === 0) this.ganchos.delete(caminho);
    if (gancho !== undefined) await gancho();
  }

  private registrar(
    verbo: EscritaFake['verbo'],
    caminho: string,
    dados: DocData | null,
  ): CarimboFake {
    const writeTime = this.proximoCarimbo();
    this.escritas.push({
      verbo,
      caminho,
      dados: dados === null ? null : structuredClone(dados),
      writeTime,
    });
    return writeTime;
  }

  private aplicar(anterior: DocData | undefined, patch: DocData): DocData {
    const saida: DocData = structuredClone(anterior ?? {});
    for (const [chave, valor] of Object.entries(patch)) {
      if (ehIncremento(valor)) {
        const atual = saida[chave];
        saida[chave] = (typeof atual === 'number' ? atual : 0) + valor.__increment;
      } else {
        saida[chave] = structuredClone(valor);
      }
    }
    return saida;
  }

  private docRef(caminho: string, id: string) {
    return {
      id,
      path: caminho,
      get: () => {
        this.leituras.push(caminho);
        const falha = this.falhasDeLeitura.get(caminho);
        if (falha) return Promise.reject(falha);
        const atual = this.store.get(caminho);
        const dados = atual === undefined ? undefined : structuredClone(atual.data);
        return Promise.resolve({
          id,
          exists: atual !== undefined,
          updateTime: atual?.updateTime,
          readTime: this.carimboDeLeitura(),
          data: () => dados,
        });
      },
      create: async (data: DocData) => {
        recusarIndefinido(data, caminho);
        await this.antesDeEscrever(caminho);
        if (this.store.has(caminho)) throw grpc(6, 'ALREADY_EXISTS');
        if (Object.values(data).some(ehIncremento)) {
          throw new Error('FakeDb: increment em create — use um número');
        }
        const writeTime = this.registrar('create', caminho, data);
        this.store.set(caminho, { data: structuredClone(data), updateTime: writeTime });
        return { writeTime };
      },
      update: async (patch: DocData, precondicao?: { lastUpdateTime?: unknown }) => {
        recusarIndefinido(patch, caminho);
        if (Object.keys(patch).length === 0) throw new Error('FakeDb: update vazio');
        for (const chave of Object.keys(patch)) {
          if (chave.includes('.')) {
            throw new Error(`FakeDb: chave com ponto em update ('${chave}') não é modelada`);
          }
        }
        if (precondicao !== undefined) {
          const chaves = Object.keys(precondicao);
          if (chaves.length !== 1 || chaves[0] !== 'lastUpdateTime') {
            throw new Error(`FakeDb: precondição não modelada: ${chaves.join(', ')}`);
          }
          if (!ehCarimbo(precondicao.lastUpdateTime)) {
            throw new Error('FakeDb: lastUpdateTime precisa ser um carimbo (Timestamp)');
          }
        }
        await this.antesDeEscrever(caminho);
        const atual = this.store.get(caminho);
        if (precondicao?.lastUpdateTime !== undefined) {
          // The stamp REPLACES the SDK's `exists` precondition, so a missing
          // document fails the stamp: 9, never 5 (module header).
          if (atual === undefined || !atual.updateTime.isEqual(precondicao.lastUpdateTime)) {
            throw grpc(9, 'FAILED_PRECONDITION');
          }
        }
        if (atual === undefined) throw grpc(5, 'NOT_FOUND');
        const writeTime = this.registrar('update', caminho, patch);
        this.store.set(caminho, { data: this.aplicar(atual.data, patch), updateTime: writeTime });
        return { writeTime };
      },
      delete: async (precondicao?: unknown) => {
        if (precondicao !== undefined) {
          throw new Error('FakeDb: delete com precondição não é modelado');
        }
        await this.antesDeEscrever(caminho);
        const writeTime = this.registrar('delete', caminho, null);
        this.store.delete(caminho);
        return { writeTime };
      },
      set: () => {
        throw new Error(
          'FakeDb: set() não é modelado — nada neste app sobrescreve um documento inteiro',
        );
      },
    };
  }

  collection(colecao: string) {
    const raiz = this.consulta(colecao, { filtros: [], ordens: [], limite: null, apos: null });
    return {
      ...raiz,
      doc: (id?: string) => {
        if (typeof id !== 'string' || id === '') {
          throw new Error('FakeDb: doc() sem id não é modelado');
        }
        return this.docRef(`${colecao}/${id}`, id);
      },
    };
  }

  /** One immutable query: every builder method returns a NEW one (module header). */
  private consulta(colecao: string, estado: EstadoConsulta) {
    const derivar = (mudanca: Partial<EstadoConsulta>) =>
      this.consulta(colecao, { ...estado, ...mudanca });
    return {
      where: (campo: string, op: string, valor: unknown) => {
        if (op !== '==') {
          throw new Error(`FakeDb: operador '${op}' em where('${campo}') não é modelado`);
        }
        return derivar({ filtros: [...estado.filtros, { campo, valor }] });
      },
      orderBy: (campo: string, direcao: 'asc' | 'desc' = 'asc') => {
        if (estado.apos !== null) {
          // The SDK freezes a cursor's values against the orderBy known when it
          // was set, and refuses a later one.
          throw new Error('FakeDb: orderBy() depois de startAfter() — o SDK recusa');
        }
        return derivar({ ordens: [...estado.ordens, { campo, direcao }] });
      },
      limit: (n: number) => derivar({ limite: n }),
      startAfter: (doc: { id: string; data: () => DocData | undefined }) => {
        if (
          typeof doc !== 'object' ||
          doc === null ||
          typeof doc.id !== 'string' ||
          typeof doc.data !== 'function'
        ) {
          throw new Error('FakeDb: startAfter só aceita um snapshot de documento');
        }
        const data = doc.data();
        for (const { campo } of estado.ordens) {
          if (data?.[campo] === undefined) {
            throw new Error(
              `FakeDb: startAfter — o snapshot '${doc.id}' não tem o campo '${campo}' do orderBy`,
            );
          }
        }
        return derivar({ apos: { id: doc.id, data: structuredClone(data ?? {}) } });
      },
      get: () => this.buscar(colecao, estado),
    };
  }

  private buscar(colecao: string, estado: EstadoConsulta) {
    const { filtros, ordens, limite, apos } = estado;
    const falha = this.falhasDeConsulta.get(colecao);
    if (falha) return Promise.reject(falha);
    this.consultas.push({
      colecao,
      filtros: filtros.map((f) => [f.campo, '==', f.valor] as [string, '==', unknown]),
      ordens: ordens.map((o) => [o.campo, o.direcao] as [string, 'asc' | 'desc']),
      limite,
      apos: apos === null ? null : apos.id,
    });
    const prefixo = `${colecao}/`;
    const encontrados = [...this.store.entries()]
      .filter(([p]) => p.startsWith(prefixo) && !p.slice(prefixo.length).includes('/'))
      // Strict equality on the stored value: a document LACKING the field never
      // matches, like real Firestore.
      .filter(([, s]) => filtros.every((f) => s.data[f.campo] === f.valor))
      // `orderBy` filters for existence: a document lacking the field is
      // dropped, while a stored `null` is kept.
      .filter(([, s]) => ordens.every((o) => s.data[o.campo] !== undefined))
      .map(([p, stored]) => ({ id: p.slice(prefixo.length), data: stored.data, stored }));
    // Order, THEN cursor, THEN cap — the order the server applies them in.
    const ordenados = [...encontrados].sort((a, b) => compararPosicoes(a, b, ordens));
    // Seek past the cursor's VALUES — the cursor document itself need not
    // still match (module header).
    const aPartirDe =
      apos === null
        ? ordenados
        : ordenados.filter((linha) => compararPosicoes(linha, apos, ordens) > 0);
    const limitados = limite === null ? aPartirDe : aPartirDe.slice(0, limite);
    const docs = limitados.map(({ id, stored }) => {
      const dados = structuredClone(stored.data);
      return { id, exists: true, updateTime: stored.updateTime, data: () => dados };
    });
    return Promise.resolve({
      docs,
      empty: docs.length === 0,
      size: docs.length,
      readTime: this.carimboDeLeitura(),
    });
  }
}

/** The cast every suite needs exactly once. */
export function asDb(db: FakeDb): Firestore {
  return db as unknown as Firestore;
}
