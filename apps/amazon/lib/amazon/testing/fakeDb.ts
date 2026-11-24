/**
 * A fake Admin-SDK Firestore, **for tests only**.
 *
 * ⚠️ Nothing under `lib/amazon/**` outside a `*.test.ts` may import this module
 * (`estrutura.test.ts`). Loja Integrada's and Shopee's doubles are the model but
 * cannot be imported: apps have no dependency edges between them.
 *
 * It exists so the credential store, the park, the seller guard, the avisos and
 * the expiry sweep run through the **real** `escreverAviso` / `resolverAviso`
 * and the real collection handles rather than mocks of them: the property under
 * test is what lands in the document, and a mocked writer cannot show that.
 *
 * ## Exactly what it supports — and it THROWS on anything else
 *
 *  - `doc.get()` → `{ exists, id, ref, updateTime, readTime, data() }`;
 *  - `doc.create(data)` — rejects gRPC **6** (ALREADY_EXISTS) on an existing doc;
 *  - `doc.update(patch)` — rejects gRPC **5** (NOT_FOUND) on a missing doc;
 *  - `doc.update(patch, { lastUpdateTime })` — rejects gRPC **9**
 *    (FAILED_PRECONDITION) on a stale stamp AND on a missing doc. ⚠️ Not 5: the
 *    real SDK REPLACES its default `{ exists: true }` precondition with the
 *    stamp, so a document that is gone fails the stamp;
 *  - `doc.set(data)` — a FULL overwrite (the consent write; the OAuth seam's
 *    `put`). ⚠️ `set(…, { merge: true })` THROWS everywhere but under
 *    `notificacoesAmazon/` (below): nothing else in this app may upsert a
 *    partial patch (it would resurrect a deleted conta or credential);
 *  - `doc.set(patch, { merge: true })` under `notificacoesAmazon/` ONLY — the
 *    shared notification store's `mark` (step 3). An UPSERT, as on the server (a
 *    row deleted meanwhile comes back holding the patch alone), of FLAT
 *    primitive fields: a map, an array or a sentinel in the patch throws, and so
 *    does any other option. Logged as the verb `mescla`;
 *  - `doc.delete()` — idempotent, like the real one;
 *  - every write resolves `{ writeTime }`;
 *  - the `{ __increment: n }` sentinel ({@link increment}), APPLIED on write,
 *    because `escreverAviso` writes `deps.increment(1)`;
 *  - (step 5) `getAll(...refs)` — every snapshot of ONE call shares one
 *    `readTime` and carries its `updateTime`, as the server's consistent
 *    multi-document read does; a ref that is not this fake's throws;
 *  - (step 12, PR 12-e1) `getAll(...refs, { fieldMask })` — see "Field masks
 *    and projections" below. Any OTHER read option, an option that is not the
 *    LAST argument, or a mask that is not a list of plain top-level field
 *    names and (step 13, PR 13-b) two-segment `FieldPath`s throws;
 *  - (step 5) `batch()` — see "The batch" below;
 *  - (step 5) every document ref, and every query result's `ref`, carries
 *    `parent` (the collection) and `parent.parent` (its owning document, or
 *    `null` at the root): a link doc's owner is `ref.parent.parent.id`.
 *
 * ## Field masks and projections (step 12, PR 12-e1)
 *
 * On Enterprise a read is billed by the data it returns, and a link doc
 * carries a whole product payload, so the stock reads ask for named fields:
 *
 *  - `getAll(...refs, { fieldMask: ['a', 'b'] })` answers each document with
 *    ONLY those of its fields it holds: an unmasked field reads `undefined`,
 *    exactly as the server leaves it out. The snapshot keeps its `exists`,
 *    `updateTime` and `readTime` (a masked read still feeds a precondition).
 *    An empty mask answers the keys alone;
 *  - a query's classic `.select('a', 'b')` projects every document it returns
 *    the same way; `.select()` with no field answers the keys alone (the
 *    server returns only the document names). A later `select` replaces an
 *    earlier one, as in the SDK. A projection changes no index the query
 *    needs, so the shape table below ignores it;
 *  - a field path is a plain top-level name: a dotted STRING is not modelled
 *    and throws (a server reads it as a nested path);
 *  - (step 13, PR 13-b) a `getAll` mask may also name ONE entry of a top-level
 *    map as a two-segment `FieldPath` (`new FieldPath(mapa, chave)`): the
 *    snapshot then holds `{ [mapa]: { [chave]: … } }` when the document's
 *    `mapa` is a map holding `chave`, and nothing of `mapa` otherwise; a `chave`
 *    holding a dot is ONE key, as on the server. A `FieldPath` of any other
 *    length, and one in a query's `select`, throws. The log records such an
 *    entry as the pair `[mapa, chave]`;
 *  - {@link FakeDb.exigirMascaraEm} makes ONE collection's documents refuse
 *    any read without a mask: a `get()`, an unmasked `getAll`, or a query on
 *    it without a `select` throws. A suite opts in for the collections whose
 *    reads it pins (a link doc read whole is the cost it guards against).
 *
 * ## The operation log
 *
 * {@link FakeDb.leituras} (every document path read), {@link FakeDb.consultas}
 * (every query, whole, its `limite` and its `selecao` included) and
 * {@link FakeDb.escritas} (every write that landed) are the raw log;
 * {@link FakeDb.leiturasDetalhadas} adds, per document read, how it was read
 * (`get`, or the n-th `getAll`) and the mask it carried; and
 * {@link FakeDb.contagem} counts them, which is what a cost test asserts.
 *
 * ## The batch — all or nothing, each write under its own precondition
 *
 * `batch()` returns `{ create, update, commit }`; `set` and `delete` throw.
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
 *    the `exists` check), a plain `update` on a missing doc rejects 5. The
 *    FIRST failure rejects the commit and NOTHING is applied;
 *  - otherwise every write applies under ONE commit stamp (a commit's writes
 *    share its time), each logged with the batch's number in `lote`, and the
 *    commit answers one `{ writeTime }` per write;
 *  - (PR 6) EXCEPT a content-identical `update` — one leaving the document
 *    exactly as it was, like the import's precondition carriers: the server
 *    moves nothing, so the document KEEPS its update time and that write
 *    answers the document's PREVIOUS update time as its `writeTime`. Measured
 *    on the emulator (Firestore v1.22.0): a batch of a carrier and a sibling
 *    `create` answered the carrier's previous time and the create's commit
 *    time. A caller reading `results[0].writeTime` as "the commit's time" is
 *    therefore wrong whenever a carrier comes first, and this fake shows it.
 *
 * ⚠️ One divergence, on the safe side: a SINGLE-document write that changes
 * nothing still takes the new stamp here. Code that relied on such a stamp NOT
 * moving would fail against this fake, never pass by accident; the emulator
 * suite (`pedidos/importarPedido.firestore.test.ts`) runs the real writes.
 *
 * ⚠️ The batch is the ONLY multi-document write modelled. The multi-document
 * read-and-write call is not, and this fake gains no method shaped like it:
 * this app runs none (`estrutura.test.ts` scans the fakes too).
 *
 * ## Queries: ONLY the indexed shapes, and two subcollection listings
 *
 * On Enterprise an unindexed query does not fail — it full-scans and bills
 * (root rule 1). So this fake refuses every query shape except the ones this
 * app runs, each of which is a declared composite (or its equality prefix), and
 * the two listings that need no index (7 and 9):
 *
 *  1. `integracao` · `tipo ==`, `selling_partner_id ==`, `ativo ==` · no order
 *     (the seller guard and step 3's routing; step 2 PR r's index);
 *  2. `integracao` · `tipo ==` · `orderBy(nome asc)` (the sweep's enumeration);
 *  3. `avisos` · `resolvidoEm ==` · `orderBy(criadoEm desc)` (the orphan pass),
 *     with `limit` and `startAfter(snapshot)`;
 *  4. `notificacoesAmazon` · `status ==`, `processedAt <` ·
 *     `orderBy(processedAt asc)` · `limit` (the shared sweep's lane query, both
 *     lanes; step 3's `(status, processedAt)` composite);
 *  5. (step 5) `int_frete` · `tipo ==`, `contaAmazonContaFreteAmazonOuterRef ==`,
 *     `ativo ==` · no order (the shared core's freight lookup with
 *     `apenasAtivo`: the equality prefix of the declared
 *     `(tipo, contaAmazonContaFreteAmazonOuterRef, ativo, dataCadastro DESC)`);
 *  6. (step 5) the `prodAmazon` COLLECTION GROUP · `contaAmazonOuterRef in`,
 *     `sku ==` · no order · `limit` (the link lookup; the declared
 *     `(contaAmazonOuterRef, sku)` collection-group index). A group query matches
 *     every stored document whose LAST collection segment is the id, at any
 *     depth (its cursor: "Document keys" below);
 *  7. (step 14, PR 14-c) `pedidos/{id}/nfev4` · NO filter, NO order, NO limit —
 *     the NF-e task's and the importer's ONE unfiltered listing of one pedido's
 *     NF-e documents: a subcollection read whole, never a scan of the
 *     collection group. Any filter, order or limit on it is refused;
 *  8. (step 12, PR 12-e1) `produtos` · `paiId ==` · `orderBy(nome asc)` ·
 *     `limit` (the stock resolver's seek of a unit's children; the declared
 *     `produtos (paiId ASC, nome ASC)` composite). ⚠️ Its `orderBy` drops a
 *     child LACKING `nome`, as the server's does;
 *  9. (step 12, PR 12-e1) `produtos/{id}/estoques` · NO filter, NO order, NO
 *     limit — the stock family read's listing of ONE produto's estoque
 *     partition when its canonical row is absent (a `select` is allowed, as
 *     on every query). Any filter, order or limit on it is refused, and so is
 *     the `estoques` collection group in any shape but 10;
 * 10. (step 12, PR 12-e2) the `estoques` COLLECTION GROUP · `depositoOuterRef
 *     ==`, `ultimaModificacao >`, `ultimaModificacao <=` ·
 *     `orderBy(ultimaModificacao asc)`, `orderBy(__name__ asc)` · `limit`, and
 *     `startAfter(snapshot)` (the stock movement window; the declared
 *     `estoques (depositoOuterRef ASC, ultimaModificacao ASC, __name__ ASC)`
 *     collection-group index). Both bounds, in that order, and the key order:
 *     an `in` over the ref forms, a missing bound or a missing `__name__` order
 *     is another shape, refused;
 * 11. (step 12, PR 12-e2) `produtos/{id}/prodAmazon` · NO filter, NO order, NO
 *     limit — the stock discovery's listing of ONE produto's link partition (a
 *     `select` is allowed). Any filter, order or limit on it is refused: the
 *     same filter as a collection-group query is a scan per row (shapes 6 and
 *     12 are the only group queries on `prodAmazon`);
 * 12. (step 12, PR 12-f) the `prodAmazon` COLLECTION GROUP · `contaAmazonOuterRef
 *     ==` · `orderBy(__name__ asc)` · `limit`, and `startAfter(ref)` (the
 *     reconcile's walk of one conta ref form, paged by key; the declared
 *     `prodAmazon (contaAmazonOuterRef ASC, __name__ ASC)` collection-group
 *     index). An `in` over the ref forms, or any other order, is another shape,
 *     refused.
 *
 * Semantics follow the server: `==` is strict equality on the stored value (a
 * missing field never matches); `in` is `===` against ANY of 1 to 30 values (an
 * empty or longer list throws, as the SDK does); `<`, `<=` and `>` take a
 * NUMBER bound only and compare within that type (a `null`, a string or a
 * missing field never matches; `>` excludes its bound and `<=` includes it);
 * any other operator throws; the query log names an `==` filter by its bare
 * field and any other as `'<campo> <op>'`; `orderBy` drops a document LACKING
 * the field (a `null` is kept) and orders null < boolean < number < string,
 * ties on the document's PATH in the direction of the last `orderBy`;
 * `startAfter(snapshot)` seeks by the snapshot's VALUES captured when it is
 * called, so a cursor document that has since stopped matching pages on
 * exactly as in production.
 *
 * ## Document keys (step 12, PR 12-e2)
 *
 *  - `orderBy('__name__')` orders by the document's FULL path, compared
 *    segment by segment (code-unit order within a segment, a shorter path
 *    first on a common prefix), as the server orders document keys: the path
 *    `produtos/a/…` comes before `produtos/a-b/…` although the raw string
 *    `produtos/a-b/…` sorts first (`-` is below `/`). It needs no stored field,
 *    so it drops no document. The implicit tie of every query is the same key;
 *  - on a GROUP query, `startAfter(snapshot)` takes a snapshot whose `ref` THIS
 *    fake built, and seeks by its ordered VALUES plus its full PATH (two rows
 *    of equal stamp under different produtos page by path). A hand-built
 *    snapshot is refused there; on a collection query the snapshot's id is
 *    its key, as before;
 *  - (step 12, PR 12-f) `startAfter(ref)` with a document REFERENCE this fake
 *    built is a KEY cursor, allowed only when every `orderBy` is `__name__`
 *    (a cursor carried across dispatches as a stored path, rebuilt as a ref).
 *
 * ## Stored stamps (step 12, PR 12-f)
 *
 * A live `Timestamp`-shaped value (a stamp this fake issued, such as a read's
 * `readTime` a caller stores as a clock) is kept AS a stamp: a read answers a
 * live stamp of the same instant (to the µs), which `isEqual` compares. Two
 * stored stamps of one instant are the same content.
 *
 * ## Stamps and read times
 *
 * {@link CarimboFake} is `Timestamp`-shaped and every write takes the next one
 * from ONE global clock that advances by a single MICROSECOND: stamps rise
 * strictly, and two consecutive commits share a millisecond — a guard comparing
 * `toMillis()` instead of µs would see them as equal. Every snapshot's
 * `readTime` is the latest stamp issued, so an ABSENCE orders against a later
 * commit. ⚠️ An object, never a number: the precondition compares through
 * `isEqual`, never by reference.
 *
 * ## Interleavings
 *
 * {@link FakeDb.antesDaProximaEscrita} runs a callback right before the next
 * write on a path is applied — after the caller's read, before its write — the
 * exact window a concurrent writer lands in.
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

/**
 * A `Timestamp`-shaped value WITH its methods: a stamp this fake issued, or a
 * read's `readTime` a caller stores back (module header, "Stored stamps").
 */
function ehCarimboVivo(v: unknown): v is CarimboFake {
  return (
    ehCarimbo(v) &&
    typeof (v as { isEqual?: unknown }).isEqual === 'function' &&
    typeof (v as { toMillis?: unknown }).toMillis === 'function'
  );
}

/** A plain object literal (`{...}`), never a class instance, an array or `null`. */
function ehObjetoSimples(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * A stored value copied as the server keeps it (module header, "Stored
 * stamps"): a live `Timestamp`-shaped stamp comes back a live stamp of the SAME
 * instant (to the µs, the fake's grain), maps and arrays are copied member by
 * member, and everything else goes through `structuredClone`, which still
 * refuses a function anywhere else.
 */
function clonar<T>(valor: T): T {
  if (ehCarimboVivo(valor)) {
    return carimbo(valor.seconds * 1_000_000 + Math.floor(valor.nanoseconds / 1000)) as T;
  }
  if (Array.isArray(valor)) return valor.map((v: unknown) => clonar(v)) as T;
  if (ehObjetoSimples(valor)) {
    const saida: Record<string, unknown> = {};
    for (const [chave, v] of Object.entries(valor)) saida[chave] = clonar(v);
    return saida as T;
  }
  return structuredClone(valor);
}

/** An Admin-SDK-shaped failure: a plain `Error` carrying a numeric gRPC `code`. */
export function grpc(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The increment sentinel this fake applies — pass it as `deps.increment`. */
export function increment(by: number): unknown {
  return { __increment: by };
}

/**
 * Whether two stored documents hold the SAME content, as the server decides a
 * no-op write: the same keys, each value strictly equal, maps and arrays
 * compared member by member (key order is not content). Stored data here is
 * plain JSON-shaped, plus the `Timestamp`-shaped stamps this fake issues
 * ({@link clonar}; `structuredClone` refuses anything else).
 */
function mesmoConteudo(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (ehCarimboVivo(a) || ehCarimboVivo(b)) {
    return ehCarimboVivo(a) && ehCarimboVivo(b) && a.isEqual(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => mesmoConteudo(v, b[i]))
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        Object.hasOwn(b, k) &&
        mesmoConteudo((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
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

/** The operators this fake models (module header). */
type OperadorFake = '==' | '<' | '<=' | '>' | 'in';

/** The range operators: each takes a NUMBER bound only (module header). */
const OPERADORES_DE_INTERVALO: ReadonlySet<string> = new Set(['<', '<=', '>']);

/** Whether `op` is one of the operators this fake models; any other throws in `where`. */
function ehOperadorFake(op: string): op is OperadorFake {
  return op === '==' || op === 'in' || OPERADORES_DE_INTERVALO.has(op);
}

/** The SDK's cap on an `in` filter's values. */
const MAX_VALORES_IN = 30;

/** The document key as a field path: what `orderBy('__name__')` names (module header). */
const CAMPO_NOME = '__name__';

interface Filtro {
  readonly campo: string;
  readonly op: OperadorFake;
  readonly valor: unknown;
}

/** Whether a stored value satisfies one filter, with the server's semantics (module header). */
function satisfaz(armazenado: unknown, f: Filtro): boolean {
  if (f.op === '==') return armazenado === f.valor;
  // `in`: equality with ANY of the values (`===`), so a missing field never matches.
  if (f.op === 'in') return (f.valor as readonly unknown[]).some((v) => armazenado === v);
  // A range (a number bound, checked in `where`): numbers only — a null, a
  // string or a missing field never matches, as on the server.
  if (typeof armazenado !== 'number') return false;
  const limite = f.valor as number;
  if (f.op === '<') return armazenado < limite;
  if (f.op === '<=') return armazenado <= limite;
  return armazenado > limite;
}

/** A filter as the shape table and the query log name it: the bare field for `==`. */
function rotuloDoFiltro(f: Filtro): string {
  return f.op === '==' ? f.campo : `${f.campo} ${f.op}`;
}

/** The ONE collection whose documents may take a merge-set: the shared store's `mark`. */
const PREFIXO_MESCLA = 'notificacoesAmazon/';

interface Ordem {
  readonly campo: string;
  readonly direcao: 'asc' | 'desc';
}

/** One write, as {@link FakeDb.escritas} records it. */
export interface EscritaFake {
  /** `set` is the full overwrite; `mescla` the merge-set (`notificacoesAmazon/` only). */
  readonly verbo: 'create' | 'update' | 'delete' | 'set' | 'mescla';
  readonly caminho: string;
  /** The payload as handed over (`null` for a delete). */
  readonly dados: DocData | null;
  /** Whether the update carried a `lastUpdateTime` precondition. */
  readonly comPrecondicao: boolean;
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
  /** `[campo, valor]` for `==`, `['<campo> <op>', valor]` otherwise (module header). */
  readonly filtros: readonly [string, unknown][];
  readonly ordens: readonly [string, 'asc' | 'desc'][];
  readonly limite: number | null;
  readonly apos: string | null;
  /**
   * The classic `select` projection, when the query carried one (`[]` = the
   * keys alone); absent on a query that returns whole documents.
   */
  readonly selecao?: readonly string[];
}

/** One document read, as {@link FakeDb.leiturasDetalhadas} records it. */
export interface LeituraFake {
  readonly caminho: string;
  /** `get` (one document) or `getAll` (one consistent read of several). */
  readonly via: 'get' | 'getAll';
  /** The `getAll` call it belongs to (1, 2, … per fake); absent on a `get`. */
  readonly chamada?: number;
  /**
   * The field mask it carried (`[]` = the keys alone), or `null` for the whole
   * document. A two-segment `FieldPath` is logged as its pair `[mapa, chave]`.
   */
  readonly mascara: readonly CampoMascaraFake[] | null;
}

/** One field of a `getAll` mask (module header, "Field masks"): a top-level name, or a map's ONE entry. */
export type CampoMascaraFake = string | readonly [mapa: string, chave: string];

/** The operations of one fake, counted (module header, "The operation log"). */
export interface ContagemFake {
  /** Documents read, by `get()` or inside a `getAll`. */
  readonly leituras: number;
  /** `getAll` calls: each one consistent read, however many documents it holds. */
  readonly chamadasGetAll: number;
  /** Queries run. */
  readonly consultas: number;
  /** Writes that landed. */
  readonly escritas: number;
}

/**
 * A field path as this fake models one: a non-empty plain top-level name. A
 * dotted path, a `FieldPath` object or anything else throws, synchronously.
 */
function validarCampo(campo: unknown, onde: string): string {
  if (typeof campo !== 'string' || campo === '' || campo.includes('.')) {
    throw new Error(
      `FakeDb: ${onde} só modela nomes de campo de primeiro nível (sem ponto, sem FieldPath)`,
    );
  }
  return campo;
}

/**
 * The segment list of a `FieldPath`, recognised by its SDK reader `toArray`
 * (a copy; the public type declares no reader), or `null` for anything else.
 * Structural on purpose: the fake loads no value of the SDK, so a suite that
 * mocks `firebase-admin/firestore` still masks by plain names.
 */
function segmentosDoFieldPath(campo: unknown): unknown {
  if (typeof campo !== 'object' || campo === null) return null;
  const toArray: unknown = (campo as { readonly toArray?: unknown }).toArray;
  return typeof toArray === 'function' ? (toArray as () => unknown).call(campo) : null;
}

/**
 * A `getAll` mask's field (module header, "Field masks"): a plain top-level
 * name as {@link validarCampo} has it, or a `FieldPath` of EXACTLY two
 * non-empty segments, read as its pair. Anything else throws, synchronously.
 */
function validarCampoDaMascara(campo: unknown, onde: string): CampoMascaraFake {
  const segmentos = segmentosDoFieldPath(campo);
  if (segmentos === null) return validarCampo(campo, onde);
  if (
    !Array.isArray(segmentos) ||
    segmentos.length !== 2 ||
    !segmentos.every((s) => typeof s === 'string' && s !== '')
  ) {
    throw new Error(`FakeDb: ${onde} só modela um FieldPath de dois segmentos (mapa, chave)`);
  }
  return [segmentos[0] as string, segmentos[1] as string];
}

/** Whether `valor` is a map a nested mask can read an entry of. */
function ehMapa(valor: unknown): valor is DocData {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** `dados` holding only the fields of `campos` it has (module header, "Field masks"). */
function projetar(dados: DocData, campos: readonly CampoMascaraFake[]): DocData {
  const saida: DocData = {};
  for (const campo of campos) {
    if (typeof campo === 'string') {
      if (Object.hasOwn(dados, campo)) saida[campo] = dados[campo];
      continue;
    }
    // A map's entry merges into what the mask already holds of that map (a
    // top-level name of the same map, before or after it, keeps it whole).
    const [mapa, chave] = campo;
    const origem = Object.hasOwn(dados, mapa) ? dados[mapa] : undefined;
    if (!ehMapa(origem) || !Object.hasOwn(origem, chave)) continue;
    const destino = saida[mapa];
    saida[mapa] = { ...(ehMapa(destino) ? destino : {}), [chave]: origem[chave] };
  }
  return saida;
}

/** The id of the collection a document path sits in (`produtos/p/prodAmazon/l` → `prodAmazon`). */
function colecaoDoCaminho(caminho: string): string {
  return caminho.split('/').at(-2) ?? '';
}

/**
 * The query shapes this app may run, each a declared index or its equality
 * prefix (module header). `colecao` is matched exactly; filters (an operator
 * other than `==` named with it) and orders in order; `grupo` for a group query.
 */
const FORMAS_INDEXADAS: readonly {
  readonly colecao: string;
  readonly grupo: boolean;
  readonly filtros: readonly string[];
  readonly ordens: readonly string[];
}[] = [
  {
    colecao: 'integracao',
    grupo: false,
    filtros: ['tipo', 'selling_partner_id', 'ativo'],
    ordens: [],
  },
  { colecao: 'integracao', grupo: false, filtros: ['tipo'], ordens: ['nome asc'] },
  { colecao: 'avisos', grupo: false, filtros: ['resolvidoEm'], ordens: ['criadoEm desc'] },
  {
    colecao: 'notificacoesAmazon',
    grupo: false,
    filtros: ['status', 'processedAt <'],
    ordens: ['processedAt asc'],
  },
  {
    colecao: 'int_frete',
    grupo: false,
    filtros: ['tipo', 'contaAmazonContaFreteAmazonOuterRef', 'ativo'],
    ordens: [],
  },
  { colecao: 'prodAmazon', grupo: true, filtros: ['contaAmazonOuterRef in', 'sku'], ordens: [] },
  { colecao: 'produtos', grupo: false, filtros: ['paiId'], ordens: ['nome asc'] },
  {
    colecao: 'estoques',
    grupo: true,
    filtros: ['depositoOuterRef', 'ultimaModificacao >', 'ultimaModificacao <='],
    ordens: ['ultimaModificacao asc', `${CAMPO_NOME} asc`],
  },
  {
    colecao: 'prodAmazon',
    grupo: true,
    filtros: ['contaAmazonOuterRef'],
    ordens: [`${CAMPO_NOME} asc`],
  },
];

/** Shape 7 (module header): ONE pedido's `nfev4` subcollection, by its full path. */
const LISTAGEM_NFEV4 = /^pedidos\/[^/]+\/nfev4$/;

/** Shape 9 (module header): ONE produto's `estoques` subcollection, by its full path. */
const LISTAGEM_ESTOQUES = /^produtos\/[^/]+\/estoques$/;

/** Shape 11 (module header): ONE produto's `prodAmazon` subcollection, by its full path. */
const LISTAGEM_VINCULOS_AMAZON = /^produtos\/[^/]+\/prodAmazon$/;

/** The listings read WHOLE (shapes 7, 9 and 11): one partition, no filter, order or limit. */
const LISTAGENS_INTEIRAS: readonly RegExp[] = [
  LISTAGEM_NFEV4,
  LISTAGEM_ESTOQUES,
  LISTAGEM_VINCULOS_AMAZON,
];

function formaIndexada(
  colecao: string,
  grupo: boolean,
  filtros: readonly Filtro[],
  ordens: readonly Ordem[],
  limite: number | null,
) {
  if (!grupo && LISTAGENS_INTEIRAS.some((listagem) => listagem.test(colecao))) {
    return filtros.length === 0 && ordens.length === 0 && limite === null;
  }
  const f = filtros.map(rotuloDoFiltro).join(',');
  const o = ordens.map((x) => `${x.campo} ${x.direcao}`).join(',');
  return FORMAS_INDEXADAS.some(
    (forma) =>
      forma.colecao === colecao &&
      forma.grupo === grupo &&
      forma.filtros.join(',') === f &&
      forma.ordens.join(',') === o,
  );
}

/** Firestore's cross-type order for the types modelled: null, boolean, number, string. */
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

interface Posicao {
  /** What the query log names: the bare id, or a group query's full path. */
  readonly id: string;
  /** The document's full path: its KEY, for `orderBy('__name__')` and the tie. */
  readonly caminho: string;
  readonly data: DocData;
}

/** Code-unit order, never a locale's. */
function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Two document keys in the server's order (module header, "Document keys"):
 * segment by segment, a shorter path first on a common prefix.
 */
function compararCaminhos(a: string, b: string): number {
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
    const c = compararTexto(sa[i] ?? '', sb[i] ?? '');
    if (c !== 0) return c;
  }
  return sa.length - sb.length;
}

function compararPosicoes(a: Posicao, b: Posicao, ordens: readonly Ordem[]): number {
  for (const { campo, direcao } of ordens) {
    const c =
      campo === CAMPO_NOME
        ? compararCaminhos(a.caminho, b.caminho)
        : compararValores(a.data[campo], b.data[campo], campo);
    if (c !== 0) return direcao === 'desc' ? -c : c;
  }
  const c = compararCaminhos(a.caminho, b.caminho);
  return (ordens.at(-1)?.direcao ?? 'asc') === 'desc' ? -c : c;
}

interface EstadoConsulta {
  readonly filtros: readonly Filtro[];
  readonly ordens: readonly Ordem[];
  readonly limite: number | null;
  readonly apos: Posicao | null;
  /** The classic `select` projection, or `null` for whole documents. */
  readonly selecao: readonly string[] | null;
}

/** A fresh query: no filter, no order, no limit, no cursor, whole documents. */
const CONSULTA_INICIAL: EstadoConsulta = {
  filtros: [],
  ordens: [],
  limite: null,
  apos: null,
  selecao: null,
};

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
}

/** The refusals an `update` patch and its precondition meet when handed over. */
function validarAtualizacao(caminho: string, patch: DocData, precondicao?: PrecondicaoFake): void {
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
}

/**
 * Why an `update` cannot land on the stored state, or `null`: a stamp that is
 * stale or names a document that is gone is 9 (never 5 — the stamp replaces the
 * SDK's `exists` check), a plain update of a missing document is 5.
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

/** A document ref's path, as the batch and `getAll` read it off a ref of THIS fake. */
function caminhoDoRef(ref: unknown): string {
  const caminho = (ref as { path?: unknown } | null)?.path;
  const deste = (ref as { [MARCA_DO_REF]?: unknown } | null)?.[MARCA_DO_REF] === true;
  if (!deste || typeof caminho !== 'string' || caminho === '') {
    throw new Error('FakeDb: só aceita uma referência de documento deste fake');
  }
  return caminho;
}

/** Marks a document ref this fake built (a hand-built `{ path }` is refused). */
const MARCA_DO_REF = Symbol('refDoFakeDb');

/**
 * A group query's cursor: the full path of a snapshot's `ref` THIS fake built
 * (module header, "Document keys"). A hand-built snapshot throws, synchronously.
 */
function caminhoDoCursorDeGrupo(ref: unknown): string {
  const caminho = (ref as { path?: unknown } | null | undefined)?.path;
  const deste = (ref as { [MARCA_DO_REF]?: unknown } | null | undefined)?.[MARCA_DO_REF] === true;
  if (!deste || typeof caminho !== 'string' || caminho === '') {
    throw new Error(
      'FakeDb: startAfter() numa consulta de grupo só aceita um snapshot deste fake ' +
        '(o cursor é o caminho do documento)',
    );
  }
  return caminho;
}

/** A document REFERENCE this fake built (it has no `data()`): a key cursor for `startAfter`. */
function ehRefSemDados(v: unknown): v is { readonly id: string; readonly path: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { [MARCA_DO_REF]?: unknown })[MARCA_DO_REF] === true &&
    typeof (v as { data?: unknown }).data !== 'function'
  );
}

/** A `getAll` read-options object: a plain object that is no document ref (it has no `path`). */
function ehOpcoesDeLeitura(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !('path' in v);
}

/** The ONE read option modelled, `{ fieldMask: [...] }`, read; any other shape throws. */
function mascaraDasOpcoes(opcoes: Readonly<Record<string, unknown>>): readonly CampoMascaraFake[] {
  const chaves = Object.keys(opcoes);
  const mascara: unknown = opcoes.fieldMask;
  if (chaves.length !== 1 || chaves[0] !== 'fieldMask' || !Array.isArray(mascara)) {
    throw new Error('FakeDb: getAll() com opções de leitura não é modelado (só { fieldMask })');
  }
  return mascara.map((campo: unknown) => validarCampoDaMascara(campo, 'getAll({ fieldMask })'));
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
  private chamadasGetAll = 0;
  private readonly mascarasExigidas = new Set<string>();

  /** Every write that LANDED, in order. A refused write is not here. */
  readonly escritas: EscritaFake[] = [];
  /** Every document path read with `get()` or `getAll()`, in order. */
  readonly leituras: string[] = [];
  /** Every document read, in order, with how it was read and its mask (module header). */
  readonly leiturasDetalhadas: LeituraFake[] = [];
  /** Every query, whole, in order. */
  readonly consultas: ConsultaFake[] = [];
  /** Every batch commit ATTEMPTED (landed or refused), as its paths in queue order. */
  readonly commitsDeLote: (readonly string[])[] = [];

  /** Every Firestore operation of any kind, counted: reads, queries and writes. */
  get operacoes(): number {
    return this.leituras.length + this.consultas.length + this.escritas.length;
  }

  /** The operations so far, counted by kind (module header, "The operation log"). */
  get contagem(): ContagemFake {
    return {
      leituras: this.leituras.length,
      chamadasGetAll: this.chamadasGetAll,
      consultas: this.consultas.length,
      escritas: this.escritas.length,
    };
  }

  /**
   * From now on, every read of a document of the collection `idColecao` (a
   * `get()`, a `getAll`, a query) must carry a field mask or a `select`, or it
   * throws (module header, "Field masks and projections").
   */
  exigirMascaraEm(idColecao: string): void {
    if (idColecao === '' || idColecao.includes('/')) {
      throw new Error('FakeDb: exigirMascaraEm() precisa de um id de coleção, sem barra');
    }
    this.mascarasExigidas.add(idColecao);
  }

  /** Throws when `caminho`'s collection requires a mask and the read carries none. */
  private conferirMascara(caminho: string, mascara: readonly CampoMascaraFake[] | null): void {
    if (mascara === null && this.mascarasExigidas.has(colecaoDoCaminho(caminho))) {
      throw new Error(`FakeDb: leitura de ${caminho} sem máscara de campos (exigirMascaraEm)`);
    }
  }

  /** Store a document without logging a write (fixtures). Takes a stamp. */
  seed(caminho: string, data: DocData): CarimboFake {
    recusarIndefinido(data, caminho);
    const updateTime = this.proximoCarimbo();
    this.store.set(caminho, { data: clonar(data), updateTime });
    return updateTime;
  }

  /**
   * Delete a document as ANOTHER writer would (a concurrent delete inside an
   * interception): no write is logged, but the clock moves, so a later
   * precondition on the path fails exactly as it does in production.
   */
  apagar(caminho: string): void {
    this.proximoCarimbo();
    this.store.delete(caminho);
  }

  /** The stored document, or `undefined`. A copy: mutating it changes nothing. */
  ler(caminho: string): DocData | undefined {
    const atual = this.store.get(caminho);
    return atual === undefined ? undefined : clonar(atual.data);
  }

  /** The stored document's commit stamp, or `undefined` when absent. */
  carimboDe(caminho: string): CarimboFake | undefined {
    return this.store.get(caminho)?.updateTime;
  }

  /** Every stored path, in insertion order. */
  caminhos(): string[] {
    return [...this.store.keys()];
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
    comPrecondicao = false,
    noLote?: { readonly writeTime: CarimboFake; readonly lote: number },
  ): CarimboFake {
    const writeTime = noLote?.writeTime ?? this.proximoCarimbo();
    this.escritas.push({
      verbo,
      caminho,
      dados: dados === null ? null : clonar(dados),
      comPrecondicao,
      writeTime,
      ...(noLote === undefined ? {} : { lote: noLote.lote }),
    });
    return writeTime;
  }

  private aplicar(anterior: DocData | undefined, patch: DocData): DocData {
    const saida: DocData = clonar(anterior ?? {});
    for (const [chave, valor] of Object.entries(patch)) {
      if (ehIncremento(valor)) {
        const atual = saida[chave];
        saida[chave] = (typeof atual === 'number' ? atual : 0) + valor.__increment;
      } else {
        saida[chave] = clonar(valor);
      }
    }
    return saida;
  }

  /**
   * The merge-set (module header): `notificacoesAmazon/` only, exactly
   * `{ merge: true }`, flat primitive fields. An upsert, like the server's.
   * Throws SYNCHRONOUSLY on anything unmodelled.
   */
  private mesclar(
    caminho: string,
    data: DocData,
    opcoes: unknown,
  ): Promise<{ writeTime: CarimboFake }> {
    const chaves = typeof opcoes === 'object' && opcoes !== null ? Object.keys(opcoes) : [];
    const ehMerge =
      chaves.length === 1 && chaves[0] === 'merge' && (opcoes as { merge: unknown }).merge === true;
    if (!ehMerge || !caminho.startsWith(PREFIXO_MESCLA)) {
      throw new Error(
        'FakeDb: set() com opções (merge) não é modelado fora de notificacoesAmazon/ — nada mais ' +
          'neste app faz upsert de um patch parcial; só a sobrescrita inteira',
      );
    }
    recusarIndefinido(data, caminho);
    for (const [chave, valor] of Object.entries(data)) {
      if (chave.includes('.')) {
        throw new Error(`FakeDb: chave com ponto em set merge ('${chave}') não é modelada`);
      }
      // A merge-set deep-merges maps field by field, and a sentinel is applied by
      // the server: the store's `mark` sends neither, so refuse rather than diverge.
      if (typeof valor === 'object' && valor !== null) {
        throw new Error(`FakeDb: valor não primitivo em set merge ('${chave}') não é modelado`);
      }
    }
    return (async () => {
      await this.antesDeEscrever(caminho);
      const atual = this.store.get(caminho);
      const writeTime = this.registrar('mescla', caminho, data);
      this.store.set(caminho, { data: this.aplicar(atual?.data, data), updateTime: writeTime });
      return { writeTime };
    })();
  }

  /**
   * One snapshot of `caminho`, read NOW, holding only the masked fields when
   * `mascara` is not `null` (the read is logged by the caller).
   */
  private snapshot(
    caminho: string,
    readTime: CarimboFake,
    mascara: readonly CampoMascaraFake[] | null,
  ) {
    const atual = this.store.get(caminho);
    const inteiro = atual === undefined ? undefined : clonar(atual.data);
    const dados = inteiro === undefined || mascara === null ? inteiro : projetar(inteiro, mascara);
    return {
      id: caminho.split('/').at(-1) ?? '',
      ref: this.docRef(caminho, caminho.split('/').at(-1) ?? ''),
      exists: atual !== undefined,
      updateTime: atual?.updateTime,
      readTime,
      data: () => dados,
    };
  }

  private docRef(caminho: string, id: string) {
    return {
      [MARCA_DO_REF]: true,
      id,
      path: caminho,
      parent: paiDoCaminho(caminho),
      get: () => {
        this.conferirMascara(caminho, null);
        this.leituras.push(caminho);
        this.leiturasDetalhadas.push({ caminho, via: 'get', mascara: null });
        const falha = this.falhasDeLeitura.get(caminho);
        if (falha) return Promise.reject(falha);
        return Promise.resolve(this.snapshot(caminho, this.carimboDeLeitura(), null));
      },
      create: async (data: DocData) => {
        recusarIndefinido(data, caminho);
        await this.antesDeEscrever(caminho);
        if (this.store.has(caminho)) throw grpc(6, 'ALREADY_EXISTS');
        validarCriacao(caminho, data);
        const writeTime = this.registrar('create', caminho, data);
        this.store.set(caminho, { data: clonar(data), updateTime: writeTime });
        return { writeTime };
      },
      update: async (patch: DocData, precondicao?: PrecondicaoFake) => {
        validarAtualizacao(caminho, patch, precondicao);
        await this.antesDeEscrever(caminho);
        const atual = this.store.get(caminho);
        // The stamp REPLACES the SDK's `exists` precondition: 9, never 5.
        const recusa = recusaDeAtualizacao(atual, precondicao);
        if (recusa !== null || atual === undefined) throw recusa ?? grpc(5, 'NOT_FOUND');
        const writeTime = this.registrar('update', caminho, patch, precondicao !== undefined);
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
        if (opcoes !== undefined) return this.mesclar(caminho, data, opcoes);
        recusarIndefinido(data, caminho);
        if (Object.values(data).some(ehIncremento)) {
          throw new Error('FakeDb: increment em set — use um número');
        }
        return (async () => {
          await this.antesDeEscrever(caminho);
          const writeTime = this.registrar('set', caminho, data);
          this.store.set(caminho, { data: clonar(data), updateTime: writeTime });
          return { writeTime };
        })();
      },
    };
  }

  collection(colecao: string) {
    const raiz = this.consulta(colecao, false, CONSULTA_INICIAL);
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
    return this.consulta(idColecao, true, CONSULTA_INICIAL);
  }

  /**
   * One consistent read of several documents (module header): every snapshot
   * shares ONE `readTime`, each in the order asked. A trailing
   * `{ fieldMask: [...] }` projects every snapshot to those fields; any other
   * read option, an option anywhere but last, and a ref this fake did not build
   * throw, synchronously.
   */
  getAll(...args: unknown[]) {
    const ultimo = args.at(-1);
    const comOpcoes = ehOpcoesDeLeitura(ultimo);
    const refs = comOpcoes ? args.slice(0, -1) : args;
    if (refs.length === 0) throw new Error('FakeDb: getAll() sem referências não é modelado');
    const mascara = comOpcoes ? mascaraDasOpcoes(ultimo) : null;
    const caminhos = refs.map((ref) => {
      if (ehOpcoesDeLeitura(ref)) {
        throw new Error('FakeDb: getAll() com opções de leitura fora da última posição');
      }
      return caminhoDoRef(ref);
    });
    for (const caminho of caminhos) this.conferirMascara(caminho, mascara);
    this.chamadasGetAll += 1;
    const chamada = this.chamadasGetAll;
    for (const caminho of caminhos) {
      this.leituras.push(caminho);
      this.leiturasDetalhadas.push({
        caminho,
        via: 'getAll',
        chamada,
        mascara: mascara === null ? null : [...mascara],
      });
    }
    const falha = caminhos.map((c) => this.falhasDeLeitura.get(c)).find((e) => e !== undefined);
    if (falha !== undefined) return Promise.reject(falha);
    const readTime = this.carimboDeLeitura();
    return Promise.resolve(caminhos.map((c) => this.snapshot(c, readTime, mascara)));
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
        enfileirar({ verbo: 'create', caminho, dados: clonar(data) });
        return lote;
      },
      update: (ref: unknown, patch: DocData, precondicao?: PrecondicaoFake) => {
        const caminho = caminhoDoRef(ref);
        validarAtualizacao(caminho, patch, precondicao);
        // The stamp object is kept as given: `isEqual` compares it at commit.
        enfileirar({ verbo: 'update', caminho, dados: clonar(patch), precondicao });
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
        this.commitsDeLote.push(fila.map((e) => e.caminho));
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
        const resultados: { writeTime: CarimboFake }[] = [];
        for (const e of fila) {
          const comPrecondicao = e.verbo === 'update' && e.precondicao !== undefined;
          const anterior = e.verbo === 'create' ? undefined : this.store.get(e.caminho);
          const dados =
            e.verbo === 'create' ? clonar(e.dados) : this.aplicar(anterior?.data, e.dados);
          // A content-identical update (a precondition carrier) changes nothing:
          // the document keeps its update time, and the write answers THAT
          // previous time as its `writeTime` (module header).
          const semEfeito =
            e.verbo === 'update' && anterior !== undefined && mesmoConteudo(anterior.data, dados);
          const writeTime = semEfeito ? anterior.updateTime : noLote.writeTime;
          this.registrar(e.verbo, e.caminho, e.dados, comPrecondicao, {
            writeTime,
            lote: noLote.lote,
          });
          if (!semEfeito) this.store.set(e.caminho, { data: dados, updateTime: noLote.writeTime });
          resultados.push({ writeTime });
        }
        return resultados;
      },
    };
    return lote;
  }

  /** One immutable query: every builder method returns a NEW one. */
  private consulta(colecao: string, grupo: boolean, estado: EstadoConsulta) {
    const derivar = (mudanca: Partial<EstadoConsulta>) =>
      this.consulta(colecao, grupo, { ...estado, ...mudanca });
    return {
      where: (campo: string, op: string, valor: unknown) => {
        if (!ehOperadorFake(op)) {
          throw new Error(`FakeDb: operador '${op}' em where('${campo}') não é modelado`);
        }
        if (OPERADORES_DE_INTERVALO.has(op) && typeof valor !== 'number') {
          throw new Error(
            `FakeDb: '${op}' em where('${campo}') só é modelado com um limite numérico`,
          );
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
          throw new Error('FakeDb: orderBy() depois de startAfter() — o SDK recusa');
        }
        return derivar({ ordens: [...estado.ordens, { campo, direcao }] });
      },
      limit: (n: number) => derivar({ limite: n }),
      // The classic projection (module header): `select()` alone = the keys.
      select: (...campos: unknown[]) =>
        derivar({ selecao: campos.map((campo) => validarCampo(campo, 'select()')) }),
      startAfter: (doc: { id: string; ref?: unknown; data: () => DocData | undefined }) => {
        // (step 12, PR 12-f) a document REFERENCE this fake built is a KEY
        // cursor: allowed only when every order is the key (module header,
        // "Document keys"), as the server takes a reference for `__name__` alone.
        if (ehRefSemDados(doc)) {
          if (estado.ordens.length === 0 || estado.ordens.some((o) => o.campo !== CAMPO_NOME)) {
            throw new Error(
              'FakeDb: startAfter(ref) só é modelado sob orderBy(__name__) e nenhuma outra ordem',
            );
          }
          const caminho = grupo ? caminhoDoCursorDeGrupo(doc) : `${colecao}/${doc.id}`;
          return derivar({ apos: { id: grupo ? caminho : doc.id, caminho, data: {} } });
        }
        if (
          typeof doc !== 'object' ||
          doc === null ||
          typeof doc.id !== 'string' ||
          typeof doc.data !== 'function'
        ) {
          throw new Error('FakeDb: startAfter só aceita um snapshot de documento');
        }
        // A group query's cursor is the document's FULL path (module header,
        // "Document keys"): only a snapshot whose ref this fake built carries it.
        const caminho = grupo ? caminhoDoCursorDeGrupo(doc.ref) : `${colecao}/${doc.id}`;
        const data = doc.data();
        for (const { campo } of estado.ordens) {
          if (campo !== CAMPO_NOME && data?.[campo] === undefined) {
            throw new Error(
              `FakeDb: startAfter — o snapshot '${doc.id}' não tem o campo '${campo}' do orderBy`,
            );
          }
        }
        return derivar({
          apos: { id: grupo ? caminho : doc.id, caminho, data: clonar(data ?? {}) },
        });
      },
      get: () => this.buscar(colecao, grupo, estado),
    };
  }

  private buscar(colecao: string, grupo: boolean, estado: EstadoConsulta) {
    const { filtros, ordens, limite, apos, selecao } = estado;
    const idColecao = grupo ? colecao : (colecao.split('/').at(-1) ?? '');
    if (selecao === null && this.mascarasExigidas.has(idColecao)) {
      return Promise.reject(
        new Error(`FakeDb: consulta em '${colecao}' sem select() (exigirMascaraEm)`),
      );
    }
    if (!formaIndexada(colecao, grupo, filtros, ordens, limite)) {
      return Promise.reject(
        new Error(
          `FakeDb: consulta fora dos índices declarados em '${colecao}'${grupo ? ' (grupo)' : ''} ` +
            `(filtros: ${filtros.map(rotuloDoFiltro).join(',') || '—'}; ` +
            `ordem: ${ordens.map((o) => `${o.campo} ${o.direcao}`).join(',') || '—'})`,
        ),
      );
    }
    const falha = this.falhasDeConsulta.get(colecao);
    if (falha) return Promise.reject(falha);
    this.consultas.push({
      colecao,
      ...(grupo ? { grupo: true as const } : {}),
      filtros: filtros.map((f) => [rotuloDoFiltro(f), f.valor] as [string, unknown]),
      ordens: ordens.map((o) => [o.campo, o.direcao] as [string, 'asc' | 'desc']),
      limite,
      apos: apos === null ? null : apos.id,
      ...(selecao === null ? {} : { selecao: [...selecao] }),
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
      // Strict equality, `in`, or a numeric `<`, on the stored value: a document
      // LACKING the field never matches.
      .filter(([, s]) => filtros.every((f) => satisfaz(s.data[f.campo], f)))
      // `orderBy` filters for existence; a stored `null` is kept. The key is
      // no stored field: ordering by it drops nothing.
      .filter(([, s]) =>
        ordens.every((o) => o.campo === CAMPO_NOME || s.data[o.campo] !== undefined),
      )
      // Every query ties on the document's KEY, its full path (the server's
      // order); the log names a group query's row by that path, a collection's by its id.
      .map(([p, stored]) => ({
        id: grupo ? p : p.slice(prefixo.length),
        caminho: p,
        data: stored.data,
        stored,
      }));
    // Order, THEN cursor, THEN cap — the order the server applies them in.
    const ordenados = [...encontrados].sort((a, b) => compararPosicoes(a, b, ordens));
    const aPartirDe =
      apos === null
        ? ordenados
        : ordenados.filter((linha) => compararPosicoes(linha, apos, ordens) > 0);
    const limitados = limite === null ? aPartirDe : aPartirDe.slice(0, limite);
    const readTime = this.carimboDeLeitura();
    const docs = limitados.map(({ caminho, stored }) => {
      const inteiro = clonar(stored.data);
      const dados = selecao === null ? inteiro : projetar(inteiro, selecao);
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
      readTime,
    });
  }
}

/** The cast every suite needs exactly once. */
export function asDb(db: FakeDb): Firestore {
  return db as unknown as Firestore;
}
