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
 *  - `doc.set(data, { merge: true })` — an upsert of FLAT fields (step 3: the
 *    shared notification store's `mark` is a merge-set). Exactly that option:
 *    a plain `set` still throws, and so does a nested map in the patch, whose
 *    field-by-field deep merge this fake does not model;
 *  - every write resolves `{ writeTime }`;
 *  - the `{ __increment: n }` sentinel ({@link increment}), APPLIED on write,
 *    because `escreverAviso` writes `deps.increment(1)`;
 *  - the `{ __arrayUnion: [...] }` sentinel ({@link arrayUnion}), APPLIED on
 *    `update` only (step 20: the freight `mapa` registration writes
 *    `deps.arrayUnion(row)`), with the server's semantics — the same as
 *    `apps/shopee/lib/shopee/testing/fakeDb.ts`: an absent, `null` or non-array
 *    field becomes the elements; an array keeps every stored element untouched
 *    and gains, in order, each element not structurally equal to one already
 *    there (same key SET in any order, same values; `1` ≠ `'1'`, `0` ≠ `null`).
 *    A `create` or a merge-`set` carrying it throws: neither is modelled. The
 *    write log keeps the sentinel itself, which a read-modify-write would not;
 *  - `collection().where(campo, '==', valor)`, `where(campo, '<', valor)` (step
 *    3: the shared sweep's lane query), `where(campo, 'in', [...])` (step 5: the
 *    link-doc lookup over every stored form of the conta ref), `orderBy`,
 *    `limit`, `startAfter(doc)` and `get()` → `{ docs, empty, size, readTime }`
 *    — see "Queries" below. Each result doc carries its `ref`, whose
 *    `parent.parent` is the owning document (`ref.parent.parent.id`);
 *  - `collectionGroup(id)` (step 5: the link docs under every produto): the
 *    same query builder over every stored document whose LAST collection
 *    segment is `id`, at any depth;
 *  - `batch()` (step 5: the pedido and its pagamentos in ONE commit) — see
 *    "The batch" below.
 *
 * Everything else — a plain `set`, any other operator, a dotted update key, an
 * `undefined` value, a precondition that is not a stamp, an `orderBy` over a
 * value that is not null/boolean/number/string — throws. That is the Shopee
 * step-8 lesson: a double that silently answers "matches nothing" or "wrote it"
 * for a call it does not model lets every suite read green. The only atomic
 * multi-document write modelled is the batch below; the multi-document
 * read-and-write API is not, and this app never names it.
 *
 * ## The batch — all or nothing, each write under its own precondition
 *
 * `batch()` returns `{ create, update, commit }` (`set` and `delete` throw):
 *
 *  - `create(ref, data)` and `update(ref, patch, { lastUpdateTime }?)` validate
 *    their payload when CALLED, as the SDK does (the same refusals as the
 *    single-document writes), and queue the write. Two writes on one path in
 *    one batch, a write after `commit` and an EMPTY commit throw: none is
 *    modelled;
 *  - `commit()` first runs, in queue order, each path's injected failure and
 *    its {@link FakeDb.antesDaProximaEscrita} hook — the concurrent writer lands
 *    there — and THEN checks every write against the store as it now stands: a
 *    `create` on an existing doc rejects gRPC 6, an `update` under
 *    `lastUpdateTime` on a stale OR missing doc rejects 9 (the stamp replaces
 *    the `exists` check, as for a single update), a plain `update` on a missing
 *    doc rejects 5. The FIRST failure rejects the commit and NOTHING is applied;
 *  - otherwise every write applies under ONE commit stamp (a commit's writes
 *    share its time), each logged with the batch's number in `lote`.
 *
 * ⚠️ One divergence, on the safe side: a write that changes nothing still takes
 * the new stamp here. Code that relied on a stamp NOT moving would therefore
 * fail against this fake, never pass by accident; the emulator suite
 * (`pedidos/importarPedido.firestore.test.ts`) pins what the server does.
 *
 * ## Queries — the server's semantics, not a convenient approximation
 *
 *  - **Immutable**: every builder method returns a NEW query; the one it was
 *    called on is unchanged, like a real `Query`.
 *  - **`<` compares within ONE type**: a number bound matches only stored
 *    numbers below it, a string bound only stored strings — a `null` or a
 *    missing field never matches, as on the server. A bound of any other type
 *    throws.
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

/** The array-union sentinel this fake applies — pass it as `deps.arrayUnion`. */
export function arrayUnion(...elementos: unknown[]): unknown {
  return { __arrayUnion: elementos };
}

function ehUniao(v: unknown): v is { __arrayUnion: unknown[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { __arrayUnion?: unknown }).__arrayUnion)
  );
}

/**
 * Structural equality, the union's dedup key: the same primitive (`null` only to `null`), arrays
 * of the same length element by element, and plain objects with the same key SET (any order) and
 * equal values. Distinct: a number and its string (`1` ≠ `'1'`), `0` and `null`, arrays of
 * another length.
 *
 * This is the test double's emulation of the server's `arrayUnion` value equality, not a sameness
 * decision in product code, and it owns its own copy on purpose: a shared deep-equality helper
 * answers its callers' question, which may not be Firestore's. Its scope is pinned both ways in
 * `fakeDb.test.ts` ("an array keeps every stored element untouched…": the EQUAL pairs and the
 * NEAR-MISSES), and `frete/mapaFrete.firestore.test.ts` feeds one union to the emulator and to
 * this fake and expects the same array from both.
 */
function mesmoValorArmazenado(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => mesmoValorArmazenado(x, b[i]));
  }
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const ca = a as DocData;
  const cb = b as DocData;
  const ka = Object.keys(ca);
  if (ka.length !== Object.keys(cb).length) return false;
  return ka.every((k) => Object.hasOwn(cb, k) && mesmoValorArmazenado(ca[k], cb[k]));
}

/** The server's `arrayUnion`: keep the stored array, append each element not already in it. */
function unir(armazenado: unknown, elementos: readonly unknown[]): unknown[] {
  const saida = Array.isArray(armazenado) ? [...(armazenado as unknown[])] : [];
  for (const elemento of elementos) {
    if (!saida.some((existente) => mesmoValorArmazenado(existente, elemento))) {
      saida.push(structuredClone(elemento));
    }
  }
  return saida;
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

/** The operators this fake models (module header). */
type OperadorFake = '==' | '<' | 'in';

/** The SDK's cap on an `in` filter's values. */
const MAX_VALORES_IN = 30;

interface Filtro {
  campo: string;
  op: OperadorFake;
  valor: unknown;
}

/** Whether a stored value satisfies one filter, with the server's semantics (module header). */
function satisfaz(armazenado: unknown, f: Filtro): boolean {
  if (f.op === '==') return armazenado === f.valor;
  // `in`: equality with ANY of the values (`===`), so a missing field never matches.
  if (f.op === 'in') return (f.valor as readonly unknown[]).some((v) => armazenado === v);
  // `<`: same type only — a null, a missing field or another type never matches.
  if (typeof f.valor === 'number') return typeof armazenado === 'number' && armazenado < f.valor;
  return typeof armazenado === 'string' && armazenado < (f.valor as string);
}

interface Ordem {
  campo: string;
  direcao: 'asc' | 'desc';
}

/** One write, as {@link FakeDb.escritas} records it. */
export interface EscritaFake {
  /** `set` is only ever the merge form (`set(data, { merge: true })`). */
  readonly verbo: 'create' | 'update' | 'delete' | 'set';
  readonly caminho: string;
  /** The payload as handed over (`null` for a delete). */
  readonly dados: DocData | null;
  readonly writeTime: CarimboFake;
  /** The batch it landed in (1, 2, … per fake); absent on a single-document write. */
  readonly lote?: number;
}

/** One query, as {@link FakeDb.consultas} records it. */
export interface ConsultaFake {
  /** The collection path — or, for a group query, the collection id. */
  readonly colecao: string;
  /** A `collectionGroup()` query. */
  readonly grupo?: true;
  readonly filtros: readonly [string, OperadorFake, unknown][];
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

/** A write's precondition, as the single-document `update` and the batch take it. */
interface PrecondicaoFake {
  readonly lastUpdateTime?: unknown;
}

/** The refusals a `create` payload meets when it is handed over (module header). */
function validarCriacao(caminho: string, data: DocData): void {
  recusarIndefinido(data, caminho);
  if (Object.values(data).some(ehIncremento)) {
    throw new Error('FakeDb: increment em create — use um número');
  }
  if (Object.values(data).some(ehUniao)) {
    throw new Error('FakeDb: arrayUnion em create não é modelado — use uma lista');
  }
}

/** The refusals an `update` patch and its precondition meet when handed over. */
function validarAtualizacao(caminho: string, patch: DocData, precondicao?: PrecondicaoFake): void {
  recusarIndefinido(patch, caminho);
  for (const [chave, valor] of Object.entries(patch)) {
    // The real SDK refuses `undefined` inside the union's elements too.
    if (ehUniao(valor)) {
      valor.__arrayUnion.forEach((e, i) => recusarIndefinido(e, `${caminho}.${chave}[${i}]`));
    }
  }
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
}

/**
 * Why an `update` cannot land on the stored state, or `null`: a stamp that is
 * stale or names a document that is gone is 9 (never 5 — the stamp replaces
 * the SDK's `exists` check), a plain update of a missing document is 5.
 */
function recusaDeAtualizacao(
  atual: Stored | undefined,
  precondicao: PrecondicaoFake | undefined,
): Error | null {
  if (precondicao?.lastUpdateTime !== undefined) {
    if (atual === undefined || !atual.updateTime.isEqual(precondicao.lastUpdateTime)) {
      return grpc(9, 'FAILED_PRECONDITION');
    }
  }
  if (atual === undefined) return grpc(5, 'NOT_FOUND');
  return null;
}

/** One queued write of a batch. */
type EscritaDoLote =
  | { readonly verbo: 'create'; readonly caminho: string; readonly dados: DocData }
  | {
      readonly verbo: 'update';
      readonly caminho: string;
      readonly dados: DocData;
      readonly precondicao: PrecondicaoFake | undefined;
    };

/** A document ref's path, as the batch reads it off the ref it is handed. */
function caminhoDoRef(ref: unknown): string {
  const caminho = (ref as { path?: unknown } | null)?.path;
  if (typeof caminho !== 'string' || caminho === '') {
    throw new Error('FakeDb: o lote só aceita uma referência de documento deste fake');
  }
  return caminho;
}

/** `ref.parent` (the collection) and `ref.parent.parent` (its owning doc, or `null` at the root). */
function paiDoCaminho(caminho: string): {
  readonly id: string;
  readonly path: string;
  readonly parent: { readonly id: string; readonly path: string } | null;
} {
  const segmentos = caminho.split('/');
  const colecao = segmentos.slice(0, -1);
  const dono = segmentos.slice(0, -2);
  return {
    id: colecao.at(-1) ?? '',
    path: colecao.join('/'),
    parent: dono.length === 0 ? null : { id: dono.at(-1) ?? '', path: dono.join('/') },
  };
}

export class FakeDb {
  private readonly store = new Map<string, Stored>();
  private relogioUs = INICIO_US;
  private readonly ganchos = new Map<string, (() => Promise<void> | void)[]>();
  private readonly falhasDeLeitura = new Map<string, Error>();
  private readonly falhasDeEscrita = new Map<string, Error>();
  private readonly falhasDeConsulta = new Map<string, Error>();
  private lotes = 0;

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
    noLote?: { readonly writeTime: CarimboFake; readonly lote: number },
  ): CarimboFake {
    const writeTime = noLote?.writeTime ?? this.proximoCarimbo();
    this.escritas.push({
      verbo,
      caminho,
      dados: dados === null ? null : structuredClone(dados),
      writeTime,
      ...(noLote === undefined ? {} : { lote: noLote.lote }),
    });
    return writeTime;
  }

  private aplicar(anterior: DocData | undefined, patch: DocData): DocData {
    const saida: DocData = structuredClone(anterior ?? {});
    for (const [chave, valor] of Object.entries(patch)) {
      if (ehIncremento(valor)) {
        const atual = saida[chave];
        saida[chave] = (typeof atual === 'number' ? atual : 0) + valor.__increment;
      } else if (ehUniao(valor)) {
        saida[chave] = unir(saida[chave], valor.__arrayUnion);
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
      parent: paiDoCaminho(caminho),
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
        validarCriacao(caminho, data);
        const writeTime = this.registrar('create', caminho, data);
        this.store.set(caminho, { data: structuredClone(data), updateTime: writeTime });
        return { writeTime };
      },
      update: async (patch: DocData, precondicao?: PrecondicaoFake) => {
        validarAtualizacao(caminho, patch, precondicao);
        await this.antesDeEscrever(caminho);
        const atual = this.store.get(caminho);
        // The stamp REPLACES the SDK's `exists` precondition, so a missing
        // document fails the stamp: 9, never 5 (module header).
        const recusa = recusaDeAtualizacao(atual, precondicao);
        if (recusa !== null || atual === undefined) throw recusa ?? grpc(5, 'NOT_FOUND');
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
      // NOT async on purpose: an unmodelled call throws synchronously, before
      // anything could be mistaken for a write that landed.
      set: (data: DocData, opcoes?: unknown) => {
        const chaves =
          typeof opcoes === 'object' && opcoes !== null ? Object.keys(opcoes as object) : [];
        const ehMerge =
          chaves.length === 1 &&
          chaves[0] === 'merge' &&
          (opcoes as { merge: unknown }).merge === true;
        if (!ehMerge) {
          throw new Error(
            'FakeDb: set() não é modelado — nada neste app sobrescreve um documento inteiro ' +
              '(só set(…, { merge: true }), o mark do pipeline compartilhado)',
          );
        }
        recusarIndefinido(data, caminho);
        for (const [chave, valor] of Object.entries(data)) {
          if (chave.includes('.')) {
            throw new Error(`FakeDb: chave com ponto em set merge ('${chave}') não é modelada`);
          }
          // A merge-set UPSERTS: on a removed document it would resurrect it. Nothing in
          // this app unions through one, so refuse rather than model it.
          if (ehUniao(valor)) {
            throw new Error(`FakeDb: arrayUnion em set merge ('${chave}') não é modelado`);
          }
          // A merge-set deep-merges maps field by field; `aplicar` replaces the
          // top-level key. Refuse rather than diverge.
          if (
            typeof valor === 'object' &&
            valor !== null &&
            !Array.isArray(valor) &&
            !ehIncremento(valor)
          ) {
            throw new Error(`FakeDb: mapa aninhado em set merge ('${chave}') não é modelado`);
          }
        }
        return (async () => {
          await this.antesDeEscrever(caminho);
          const atual = this.store.get(caminho);
          const writeTime = this.registrar('set', caminho, data);
          this.store.set(caminho, { data: this.aplicar(atual?.data, data), updateTime: writeTime });
          return { writeTime };
        })();
      },
    };
  }

  collection(colecao: string) {
    const raiz = this.consulta(colecao, false, {
      filtros: [],
      ordens: [],
      limite: null,
      apos: null,
    });
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

  /** Every stored document whose LAST collection segment is `idColecao`, at any depth (module header). */
  collectionGroup(idColecao: string) {
    if (idColecao === '' || idColecao.includes('/')) {
      throw new Error('FakeDb: collectionGroup() precisa de um id de coleção, sem barra');
    }
    return this.consulta(idColecao, true, { filtros: [], ordens: [], limite: null, apos: null });
  }

  /** A batch: all or nothing, each write under its own precondition (module header). */
  batch() {
    const fila: EscritaDoLote[] = [];
    let comprometido = false;
    const enfileirar = (escrita: EscritaDoLote) => {
      if (comprometido) throw new Error('FakeDb: escrita num lote já enviado');
      if (fila.some((e) => e.caminho === escrita.caminho)) {
        throw new Error(`FakeDb: duas escritas em ${escrita.caminho} no mesmo lote não é modelado`);
      }
      fila.push(escrita);
    };
    const lote = {
      create: (ref: unknown, data: DocData) => {
        const caminho = caminhoDoRef(ref);
        validarCriacao(caminho, data);
        enfileirar({ verbo: 'create', caminho, dados: structuredClone(data) });
        return lote;
      },
      update: (ref: unknown, patch: DocData, precondicao?: PrecondicaoFake) => {
        const caminho = caminhoDoRef(ref);
        validarAtualizacao(caminho, patch, precondicao);
        // The stamp object is kept as given: `isEqual` compares it at commit.
        enfileirar({ verbo: 'update', caminho, dados: patch, precondicao });
        return lote;
      },
      set: () => {
        throw new Error('FakeDb: set() num lote não é modelado');
      },
      delete: () => {
        throw new Error('FakeDb: delete() num lote não é modelado');
      },
      commit: async () => {
        if (comprometido) throw new Error('FakeDb: lote enviado duas vezes');
        if (fila.length === 0) throw new Error('FakeDb: commit de um lote vazio não é modelado');
        comprometido = true;
        // The concurrent writers land first, then every write meets the store as it is.
        for (const e of fila) await this.antesDeEscrever(e.caminho);
        for (const e of fila) {
          const atual = this.store.get(e.caminho);
          if (e.verbo === 'create') {
            if (atual !== undefined) throw grpc(6, 'ALREADY_EXISTS');
          } else {
            const recusa = recusaDeAtualizacao(atual, e.precondicao);
            if (recusa !== null) throw recusa;
          }
        }
        // All of them, under ONE commit stamp.
        this.lotes += 1;
        const noLote = { writeTime: this.proximoCarimbo(), lote: this.lotes };
        for (const e of fila) {
          this.registrar(e.verbo, e.caminho, e.dados, noLote);
          const anterior = e.verbo === 'create' ? undefined : this.store.get(e.caminho)?.data;
          const dados =
            e.verbo === 'create' ? structuredClone(e.dados) : this.aplicar(anterior, e.dados);
          this.store.set(e.caminho, { data: dados, updateTime: noLote.writeTime });
        }
        return fila.map(() => ({ writeTime: noLote.writeTime }));
      },
    };
    return lote;
  }

  /** One immutable query: every builder method returns a NEW one (module header). */
  private consulta(colecao: string, grupo: boolean, estado: EstadoConsulta) {
    const derivar = (mudanca: Partial<EstadoConsulta>) =>
      this.consulta(colecao, grupo, { ...estado, ...mudanca });
    return {
      where: (campo: string, op: string, valor: unknown) => {
        if (op !== '==' && op !== '<' && op !== 'in') {
          throw new Error(`FakeDb: operador '${op}' em where('${campo}') não é modelado`);
        }
        if (op === '<' && typeof valor !== 'number' && typeof valor !== 'string') {
          throw new Error(`FakeDb: '<' em where('${campo}') só é modelado para número ou texto`);
        }
        if (
          op === 'in' &&
          (!Array.isArray(valor) || valor.length === 0 || valor.length > MAX_VALORES_IN)
        ) {
          // The SDK refuses an empty or oversized disjunction before any read.
          throw new Error(
            `FakeDb: 'in' em where('${campo}') precisa de 1 a ${String(MAX_VALORES_IN)} valores`,
          );
        }
        return derivar({ filtros: [...estado.filtros, { campo, op, valor }] });
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
      get: () => this.buscar(colecao, grupo, estado),
    };
  }

  private buscar(colecao: string, grupo: boolean, estado: EstadoConsulta) {
    const { filtros, ordens, limite, apos } = estado;
    const falha = this.falhasDeConsulta.get(colecao);
    if (falha) return Promise.reject(falha);
    this.consultas.push({
      colecao,
      ...(grupo ? { grupo: true as const } : {}),
      filtros: filtros.map((f) => [f.campo, f.op, f.valor] as [string, OperadorFake, unknown]),
      ordens: ordens.map((o) => [o.campo, o.direcao] as [string, 'asc' | 'desc']),
      limite,
      apos: apos === null ? null : apos.id,
    });
    const prefixo = `${colecao}/`;
    // A group query: the last collection segment, at any depth. Otherwise the direct children.
    const naColecao = (p: string): boolean => {
      if (!grupo) return p.startsWith(prefixo) && !p.slice(prefixo.length).includes('/');
      const segmentos = p.split('/');
      return segmentos.length % 2 === 0 && segmentos.at(-2) === colecao;
    };
    const encontrados = [...this.store.entries()]
      .filter(([p]) => naColecao(p))
      // Strict equality, or a same-type `<`, on the stored value: a document
      // LACKING the field never matches, like real Firestore.
      .filter(([, s]) => filtros.every((f) => satisfaz(s.data[f.campo], f)))
      // `orderBy` filters for existence: a document lacking the field is
      // dropped, while a stored `null` is kept.
      .filter(([, s]) => ordens.every((o) => s.data[o.campo] !== undefined))
      // A group query ties on the FULL path (the server's order); a collection on the id.
      .map(([p, stored]) => ({
        id: grupo ? p : p.slice(prefixo.length),
        caminho: p,
        data: stored.data,
        stored,
      }));
    if (grupo && apos !== null) {
      throw new Error('FakeDb: startAfter() numa consulta de grupo não é modelado');
    }
    // Order, THEN cursor, THEN cap — the order the server applies them in.
    const ordenados = [...encontrados].sort((a, b) => compararPosicoes(a, b, ordens));
    // Seek past the cursor's VALUES — the cursor document itself need not
    // still match (module header).
    const aPartirDe =
      apos === null
        ? ordenados
        : ordenados.filter((linha) => compararPosicoes(linha, apos, ordens) > 0);
    const limitados = limite === null ? aPartirDe : aPartirDe.slice(0, limite);
    const docs = limitados.map(({ caminho, stored }) => {
      const dados = structuredClone(stored.data);
      const id = caminho.split('/').at(-1) ?? '';
      return {
        id,
        ref: this.docRef(caminho, id),
        exists: true,
        updateTime: stored.updateTime,
        data: () => dados,
      };
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
