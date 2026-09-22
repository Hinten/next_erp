/**
 * A fake Admin-SDK Firestore, **for tests only**.
 *
 * ⚠️ Nothing under `lib/shopee/**` outside a `*.test.ts` may import this module,
 * and nothing does — the precedent is `apps/web/lib/testing`. It ships in the
 * app tree rather than beside one suite because SIX suites need it
 * (`conta/expiracaoSweep`, `avisos/pushSaude`, `notificacoes/notificacao`,
 * `notificacoes/lostPushSweep`, `notificacoes/pushConfigMonitor`,
 * `notificacoes/orderBackfill`), and a second copy is exactly the shape the
 * root `CLAUDE.md` names: two files that read as agreeing while drifting toward
 * plausible.
 *
 * It exists so a producer's suite runs through the **real**
 * `escreverAviso` / `resolverAviso` / notification store rather than through a
 * mock of them. The property under test is the plano (or the document) the
 * producer hands over, and a mocked writer cannot show that.
 *
 * Seven deliberate extensions over the original in
 * `packages/data/src/admin/avisos/escreverAviso.test.ts`:
 *
 *  - the `collection().where().where().where().limit().get()` chain that
 *    `findIntegracaoByShopId` runs — and the same chain WITHOUT `limit()`,
 *    which is how the order backfill enumerates every active conta;
 *  - EVERY write is recorded in order ({@link FakeDb.writes}), whatever its
 *    verb, so a test can assert that a sweep wrote once per conta and NOWHERE
 *    else (`patches` stays the update-only view several suites read);
 *  - EVERY path touched is recorded ({@link FakeDb.caminhos}), so a test can
 *    assert that nothing under `/credenciais/` is ever read;
 *  - every `update` patch is recorded ({@link FakeDb.patches}), so a test can
 *    assert which fields a producer OMITTED — an absent key and a `null` are
 *    different facts (`camposInformados`, root `CLAUDE.md` rule 7);
 *  - the `{ __increment: n }` sentinel is APPLIED on write, so `ocorrencias`
 *    across three runs reads back as a number. The patch log still proves the
 *    sentinel itself was written (rule 7 tier 0), which a read-modify-write
 *    would not produce;
 *  - `collection().doc()` with NO id mints an auto id, which is what
 *    `newDocId` does for a notification payload whose derived doc id was
 *    refused by `asDocId`.
 *
 * Added by step 5 (#1513), strictly ADDITIVELY — no existing behaviour changed,
 * so the six suites above are untouched:
 *
 *  - {@link FakeDb.collectionGroup}, the chain `defineAdminCollection`'s
 *    `groupQuery(db)` runs (`where().where().limit().get()`), whose rows expose
 *    `ref.parent.parent.id` — the OWNING document's id, which is how the Shopee
 *    produto cascade recovers a produto from a `prodshopee`/`variashopee` link
 *    doc. Same shape as the double in
 *    `apps/mercado-livre/.../orderProdutoResolve.test.ts`;
 *  - {@link FakeDb.consultas}, every query issued through either entry point
 *    with its clauses and limit, in order — so a test can assert that a rung was
 *    SKIPPED (zero queries), that the conta filter really was sent to the
 *    server, and that a memoised resolution costs ONE query set for two lines.
 *
 * ⚠️ Clause matching is STRICT equality on the stored value, in both entry
 * points. That is deliberate and it differs from the Mercado Livre double, which
 * folds an absent field into `null`: real Firestore does not index a document
 * that lacks the field, so a link doc missing its conta ref must NOT match
 * `where('contaVariacaoShopeeOuterRef', '==', …)`. Fixtures therefore set every
 * filtered field explicitly.
 *
 * Added by step 5's WRITE path (#1513 wave 3), also strictly additively:
 *
 *  - {@link FakeDb.runTransaction}, delegating to the SHARED `OccEngine`
 *    (`@delfrance/data/testing`) — the one OCC model every transaction double in
 *    this repo adapts onto, so the retry semantics cannot drift per app. It
 *    models the three properties a hand-rolled fake does not: snapshot reads,
 *    buffered writes with a commit-time version check, and a retry that re-runs
 *    the CALLBACK ONLY, re-applying its closure verbatim. That last one is what
 *    makes a stale-closure bug visible at all;
 *  - {@link FakeDb.occ}, exposed so a test can hold one attempt at
 *    `db.occ.beforeCommit` and read `db.occ.txLog` for the abort;
 *  - `collection().add()`, used by the remaining admin collection writers that
 *    intentionally allocate an auto id outside a transaction;
 *  - {@link FakeDb.opLog}, every read and write in CALL order (`get` from the
 *    doc ref, the writes from the engine at staging time), so a test can assert
 *    that a byte-identical replay wrote NOTHING and that a create used
 *    `tx.create` rather than `tx.set`.
 *
 * Added by step 8 (#1516), again strictly ADDITIVELY — every suite that drives
 * this double is byte-unedited:
 *
 *  - the clause carries its OPERATOR and `where()` stops discarding its second
 *    argument. Matching moves into `corresponde`: `==` is byte-identical to what
 *    this file always did (including "an absent field never matches", the ⚠️
 *    above), `in` is a real membership test, `<` / `<=` / `>` / `>=` compare only
 *    same-typed numbers or strings, `!=` is the negation with the same
 *    absent-field rule — and an operator nobody taught it **throws**. ⚠️ The
 *    throw is the point: while the operator was dropped, an `in` or a `<`
 *    answered "matches nothing" and the suite still read GREEN. A silent
 *    fallback to `===` is that failure, kept;
 *  - {@link FakeDb.collection}'s `orderBy(campo, direction)` SORTS the result
 *    (multi-key, stable — `Array#sort` is — nulls last) before the cursor and
 *    the limit. Recording the call without sorting would let a paging test
 *    assert an order the double never produced;
 *  - `startAfter(doc)` is a DOC-SNAPSHOT cursor: it drops everything up to and
 *    including `doc.id` in the sorted result. Positioning by id rather than by
 *    value is deliberate — Shopee's `create_time` has 1-second resolution, so two
 *    orders created in the same second share one µs `timestamp` and a value
 *    cursor would silently skip the second. A cursor id the query itself did not
 *    return THROWS, for the same reason the unknown operator does;
 *  - `limit(n)` returns the CHAIN with the cap stored, instead of a bare
 *    `{ get }` — the shape `collectionGroup` already had — so `orderBy`,
 *    `startAfter` and `limit` compose in any order while every existing
 *    `.limit(n).get()` caller is unaffected;
 *  - {@link FakeDb.consultasCompletas}, a SECOND query log carrying the WHOLE
 *    query: clauses as `[campo, op, valor]` TRIPLES, the orders, the limit and
 *    the cursor id;
 *  - {@link FakeDb.falhasDeUpdate}, the `update` twin of
 *    {@link FakeDb.falhasDeCriacao}. Without it two arms are unreachable from
 *    any suite: `resolverAviso`'s precondition-lost branch, which answers
 *    `false` — a lookup that closed NOTHING, as against a transition — and a
 *    contained gRPC failure out of an in-line resolve, which is where a sweep
 *    can record a SECOND verdict for one candidate.
 *
 * ⚠️ That second log is where "additively" has teeth, and the reason is three
 * live assertions on the FIRST one: `core/contas.test.ts:35` compares the whole
 * row with `toEqual`, so any new defined key fails it;
 * `pedidos/produtoResolve.test.ts:133` asserts a clause with
 * `toContainEqual(['contaVariacaoShopeeOuterRef', REF_CONTA])` — a PAIR; and
 * `pedidos/importarPedido.test.ts:273-274` destructures `[campo]` / `[, valor]`,
 * which on a triple would read the OPERATOR as the value and then either fail
 * for the wrong reason or pass vacuously. So {@link FakeDb.consultas} keeps its
 * pairs and its three keys. (`core/contaCache.test.ts` asserts the same pair
 * shape on an identically-named double of its OWN, which does not import this
 * file — named here so nobody "reconciles" the two by editing the wrong one.)
 *
 * ⚠️ One divergence from real Firestore that the ordering makes visible: a
 * document LACKING the ordered field is not returned by a real `orderBy` at all,
 * while this double keeps it and sorts it last. Exclude it with the same `where`
 * the production query carries (a range clause already refuses an absent field)
 * rather than relying on the position.
 *
 * Added by step 9 (#1517), again strictly ADDITIVELY — the TWENTY suites that
 * drive this double are byte-unedited, which is the additivity claim's only
 * proof:
 *
 *  - an `{ __arrayUnion: [...] }` sentinel, APPLIED on write exactly like
 *    `__increment` — union by deep equality, order preserved, no duplicates —
 *    and the real `FieldValue.arrayUnion(...)` is applied the same way, because
 *    `putArquivoAdmin` (`@delfrance/storage/admin`) writes the SDK's own
 *    sentinel and a double that stored it verbatim would leave every
 *    `externalIds` / `fotos` assertion reading a sentinel object instead of the
 *    merged array. The patch log still proves which sentinel was written, which
 *    a read-modify-write would not;
 *  - DOTTED-PATH keys on `update` (and only on `update`, which is Firestore's
 *    own rule: a dotted key in `set` is a literal field NAME). `precos.<tabelaId>`
 *    is why — the produto price write names one tabela key so the legacy `precos`
 *    map is never re-validated and a sibling tabela provably cannot be touched.
 *    Intermediate objects are created and CLONED along the path, so a sibling
 *    field of the same parent survives;
 *  - {@link CarimboFake} on every snapshot (`updateTime`) plus the
 *    `update(patch, { lastUpdateTime })` PRECONDITION, which rejects a stale
 *    stamp with a gRPC 9 that `isFailedPrecondition` (`@delfrance/data/admin`)
 *    recognises. ⚠️ The stamp is an OBJECT with `isEqual`, not a number, because
 *    a real `Timestamp` is: a comparison written as `a.updateTime === b.updateTime`
 *    is false for two equal real stamps and TRUE for two equal numeric ones, so
 *    a numeric double would take that bug green. Without this pair, the guarded
 *    price write silently degrades to an unguarded one in every test —
 *    `import.ts`'s own comment says the precondition's fallback "exists only so
 *    an in-memory double may omit it".
 *
 * ⚠️ This file is in `firestore-transaction-inventory`'s scope from here on —
 * that guard greps raw TEXT, so even a doc comment naming the method pulls a
 * file in. Its entry is the "test harness" one, beside `occTransaction.ts`.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  OccEngine,
  type OccOpKind,
  type OccTransaction,
  type OccWriteKind,
} from '@delfrance/data/testing';

export type DocData = Record<string, unknown>;

/**
 * A `Timestamp`-shaped write stamp: monotonically increasing, comparable ONLY
 * through {@link CarimboFake.isEqual}.
 *
 * ⚠️ An object and not a number on purpose. Two reads of one real `Timestamp`
 * are two INSTANCES, so `snapA.updateTime === snapB.updateTime` is false for
 * equal real stamps and true for equal numeric ones — a numeric double would
 * take a `===` comparison green and ship it.
 */
export interface CarimboFake {
  readonly seq: number;
  isEqual(outro: unknown): boolean;
  toMillis(): number;
}

function carimbo(seq: number): CarimboFake {
  return {
    seq,
    isEqual: (outro: unknown) =>
      typeof outro === 'object' && outro !== null && (outro as { seq?: unknown }).seq === seq,
    toMillis: () => seq,
  };
}

function ehCarimbo(v: unknown): v is CarimboFake {
  return typeof v === 'object' && v !== null && typeof (v as { seq?: unknown }).seq === 'number';
}

interface Stored {
  data: DocData;
  updateTime: CarimboFake;
}

interface Filtro {
  campo: string;
  /** The operator as the caller spelled it — `'=='`, `'in'`, `'<'`, … */
  op: string;
  valor: unknown;
}

interface Ordem {
  campo: string;
  direcao: 'asc' | 'desc';
}

/**
 * `-1 | 0 | 1` for two values of the SAME primitive type, `null` for anything
 * else. Real Firestore does not compare across types, and this is also the sort
 * comparator's primitive, so the two can never disagree.
 */
function comparar(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/**
 * One clause against one stored value.
 *
 * ⚠️ An UNKNOWN operator throws instead of falling back to `===`. The fallback
 * is what this double used to do by accident — the operator was dropped — and it
 * answers "matches nothing" for every clause that is not an equality, which no
 * assertion can see.
 */
function corresponde(valorArmazenado: unknown, f: Filtro): boolean {
  switch (f.op) {
    case '==':
      return valorArmazenado === f.valor;
    case '!=':
      // Firestore's rule, not JavaScript's: a document that LACKS the field is
      // not returned by a `!=` either.
      return valorArmazenado !== undefined && valorArmazenado !== f.valor;
    case 'in':
      return Array.isArray(f.valor) && f.valor.includes(valorArmazenado);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const c = comparar(valorArmazenado, f.valor);
      if (c === null) return false;
      if (f.op === '<') return c < 0;
      if (f.op === '<=') return c <= 0;
      if (f.op === '>') return c > 0;
      return c >= 0;
    }
    default:
      throw new Error(
        `FakeDb: operador não suportado em where('${f.campo}', '${f.op}', …) — ensine-o antes de usá-lo`,
      );
  }
}

/** Multi-key sort; absent and `null` values last, whatever the direction. */
function ordenar<T extends { stored: Stored }>(linhas: T[], ordens: Ordem[]): T[] {
  return [...linhas].sort((a, b) => {
    for (const { campo, direcao } of ordens) {
      const va = a.stored.data[campo];
      const vb = b.stored.data[campo];
      const aAusente = va === undefined || va === null;
      const bAusente = vb === undefined || vb === null;
      if (aAusente || bAusente) {
        if (aAusente && bAusente) continue;
        return aAusente ? 1 : -1;
      }
      const c = comparar(va, vb);
      if (c === null || c === 0) continue;
      return direcao === 'desc' ? -c : c;
    }
    return 0;
  });
}

/**
 * The doc-snapshot cursor. A cursor naming a document this very query did not
 * return is a broken walk, so it throws rather than quietly returning the whole
 * page again.
 */
function depoisDe<T extends { id: string }>(linhas: T[], apos: string): T[] {
  const i = linhas.findIndex((l) => l.id === apos);
  if (i < 0) {
    throw new Error(
      `FakeDb: startAfter('${apos}') — o cursor não está no resultado desta consulta`,
    );
  }
  return linhas.slice(i + 1);
}

/** An Admin-SDK-shaped failure: a plain `Error` carrying a numeric gRPC `code`. */
export function grpc(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The increment sentinel these fakes speak — see {@link FakeDb}'s header. */
export function increment(by: number): unknown {
  return { __increment: by };
}

/**
 * The array-union sentinel these fakes speak. A test may write either this or
 * the real `FieldValue.arrayUnion(...)`; both are applied identically.
 */
export function arrayUnion(...elementos: unknown[]): unknown {
  return { __arrayUnion: elementos };
}

function ehIncremento(v: unknown): v is { __increment: number } {
  return typeof v === 'object' && v !== null && '__increment' in v;
}

/**
 * The elements of an array-union sentinel — ours, or the Admin SDK's own
 * (`FieldValue.arrayUnion(...)` carries them on a public `elements` array; the
 * `importMigration.test.ts` double reads the same field). `null` for anything
 * else, INCLUDING a `FieldValue` that is not an array union: an unsupported
 * sentinel stays a plain overwrite rather than being guessed at.
 */
function elementosDeUniao(v: unknown): unknown[] | null {
  if (typeof v !== 'object' || v === null) return null;
  const nosso = (v as { __arrayUnion?: unknown }).__arrayUnion;
  if (Array.isArray(nosso)) return nosso;
  if (v instanceof FieldValue) {
    const elements = (v as unknown as { elements?: unknown }).elements;
    return Array.isArray(elements) ? elements : null;
  }
  return null;
}

/**
 * Structural equality for the union's dedup key.
 *
 * ⚠️ Deliberately NOT named after any shared helper: the
 * `equivalence-fold-inventory` guard keys on a word-bounded list of thirteen
 * helper names, and this file would then owe it an entry.
 *
 * Equal: same primitive value (`null` only to `null`), same array length and
 * element-for-element equality, and same key SET (order-independent) with equal
 * values. Distinct: a number and its stringified form (`1` ≠ `"1"`), `0` ≠
 * `null`, and two arrays of different length — the same distinctions real
 * Firestore's `arrayUnion` draws, which is what keeps a legacy `externalId`
 * stored as a string from silently deduping against a numeric one.
 */
function iguaisEmProfundidade(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => iguaisEmProfundidade(x, b[i]));
  }
  if (typeof a !== 'object' || a === null || b === null || typeof b !== 'object') return false;
  const ca = a as Record<string, unknown>;
  const cb = b as Record<string, unknown>;
  const ka = Object.keys(ca);
  const kb = Object.keys(cb);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in cb && iguaisEmProfundidade(ca[k], cb[k]));
}

/** Real `arrayUnion` semantics: append in order, skip anything already present. */
function unir(base: unknown, elementos: unknown[]): unknown[] {
  const saida = Array.isArray(base) ? [...(base as unknown[])] : [];
  for (const el of elementos) {
    if (!saida.some((existente) => iguaisEmProfundidade(existente, el))) saida.push(el);
  }
  return saida;
}

/**
 * Write one key, resolving the sentinels against the CURRENT value.
 *
 * `caminho` is a field path: one segment for a plain key, several for a dotted
 * one. Intermediate objects are created and CLONED along the way, so a sibling
 * field of the same parent survives the write.
 */
function escreverCaminho(alvo: DocData, caminho: string[], valor: unknown): void {
  const [chave, ...resto] = caminho as [string, ...string[]];
  if (resto.length === 0) {
    const atual = alvo[chave];
    const elementos = elementosDeUniao(valor);
    if (ehIncremento(valor)) {
      alvo[chave] = (typeof atual === 'number' ? atual : 0) + valor.__increment;
    } else if (elementos) {
      alvo[chave] = unir(atual, elementos);
    } else {
      alvo[chave] = valor;
    }
    return;
  }
  const filhoAtual = alvo[chave];
  const filho: DocData =
    typeof filhoAtual === 'object' && filhoAtual !== null && !Array.isArray(filhoAtual)
      ? { ...(filhoAtual as DocData) }
      : {};
  alvo[chave] = filho;
  escreverCaminho(filho, resto, valor);
}

/**
 * Apply a patch over the previous document.
 *
 * `expandirCaminhos` is Firestore's own rule, not a convenience: a dotted key is
 * a FIELD PATH in `update` and a literal field NAME in `set`/`create`, so only
 * the update verbs pass `true`.
 */
function aplicar(anterior: DocData | undefined, patch: DocData, expandirCaminhos = false): DocData {
  const saida: DocData = { ...anterior };
  for (const [chave, valor] of Object.entries(patch)) {
    const caminho = expandirCaminhos && chave.includes('.') ? chave.split('.') : [chave];
    escreverCaminho(saida, caminho, valor);
  }
  return saida;
}

export class FakeDb {
  readonly store: Record<string, Stored> = {};
  /** Every collection and document path this database was asked for. */
  readonly caminhos: string[] = [];
  readonly patches: { path: string; patch: DocData }[] = [];
  /**
   * Every query issued, in order: its source (a collection path, or
   * `group:<leaf>`), its `where` clauses as `[campo, valor]` pairs, and its
   * limit (`null` when uncapped).
   */
  readonly consultas: { fonte: string; clausulas: [string, unknown][]; limite: number | null }[] =
    [];
  /**
   * The same queries, WHOLE: clauses as `[campo, op, valor]` triples, the
   * `orderBy` list as `[campo, direção]` pairs, the limit and the `startAfter`
   * cursor id. A second log rather than a wider {@link FakeDb.consultas} — the
   * header says which three assertions that protects.
   */
  readonly consultasCompletas: {
    fonte: string;
    clausulas: [string, string, unknown][];
    ordens: [string, 'asc' | 'desc'][];
    limite: number | null;
    apos: string | null;
  }[] = [];
  /** Every write, in order, whatever the verb — `create`, `set` and `update`. */
  readonly writes: { path: string; patch: DocData }[] = [];
  /** Injected failures for the `shop_id` query, keyed by the shop it asks for. */
  readonly falhas = new Map<number, Error>();
  /** Injected failures for `create`, keyed by the FULL document path. */
  readonly falhasDeCriacao = new Map<string, Error>();
  /** Injected failures for `update`, keyed by the FULL document path. */
  readonly falhasDeUpdate = new Map<string, Error>();
  /**
   * Every read and write in CALL order — `get` logged by the doc ref, the writes
   * logged by the engine when they are STAGED (not at commit).
   *
   * ⚠️ Staging-time logging is deliberate: `opLog` is a log of what the callback
   * DID, so an aborted attempt's write still appears. Logging at commit would
   * make a `['get', 'create']` assertion vacuous and would hide the staged write
   * a race test is about.
   */
  readonly opLog: { op: OccOpKind; path: string }[] = [];
  /** Exposed so a test can set `db.occ.beforeCommit` / read `db.occ.txLog`. */
  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => this.aplicarEscritaTransacional(kind, path, data),
    logWrite: (op, path) => this.opLog.push({ op, path }),
  });
  private relogio = 100;
  private autoId = 0;

  /**
   * Commit-time write for the transaction engine. Throws the way the Admin SDK
   * does — gRPC 6 on `create` over an existing document, gRPC 5 on `update` of
   * an absent one — because a fake that silently tolerated either would make
   * every `tx.create` assertion vacuous. It never logs: the engine already
   * logged this write at staging time.
   */
  private aplicarEscritaTransacional(kind: OccWriteKind, path: string, data: DocData): void {
    const atual = this.store[path];
    if (kind === 'create' && atual) throw grpc(6, 'ALREADY_EXISTS');
    if (kind === 'update' && !atual) throw grpc(5, 'NOT_FOUND');
    this.relogio += 1;
    if (kind === 'update') this.patches.push({ path, patch: data });
    this.writes.push({ path, patch: data });
    this.store[path] = {
      data: kind === 'update' ? aplicar(atual?.data, data, true) : aplicar(undefined, data),
      updateTime: carimbo(this.relogio),
    };
  }

  /**
   * The Admin-SDK transaction shape, over the SHARED engine.
   *
   * ⚠️ A throw from the callback PROPAGATES — the real SDK only retries its own
   * ABORTED, and a bug in the code under test must not be swallowed by a fake.
   */
  runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }

  seed(path: string, data: DocData): void {
    this.relogio += 1;
    this.store[path] = { data, updateTime: carimbo(this.relogio) };
  }

  /** Document ids under a collection path, in insertion order. */
  idsEm(colPath: string): string[] {
    const prefixo = `${colPath}/`;
    return Object.keys(this.store)
      .filter((p) => p.startsWith(prefixo) && !p.slice(prefixo.length).includes('/'))
      .map((p) => p.slice(prefixo.length));
  }

  private docRef(path: string, id: string) {
    this.caminhos.push(path);
    return {
      path,
      id,
      create: (data: DocData) => {
        const falha = this.falhasDeCriacao.get(path);
        if (falha) return Promise.reject(falha);
        if (this.store[path]) return Promise.reject(grpc(6, 'ALREADY_EXISTS'));
        this.relogio += 1;
        this.writes.push({ path, patch: data });
        this.store[path] = { data: aplicar(undefined, data), updateTime: carimbo(this.relogio) };
        return Promise.resolve();
      },
      get: () => {
        const atual = this.store[path];
        this.opLog.push({ op: 'get', path });
        return Promise.resolve({
          exists: atual !== undefined,
          updateTime: atual?.updateTime,
          data: () => atual?.data,
        });
      },
      // ⚠️ `lastUpdateTime` is compared through the STAMP's own identity (its
      // `seq`), never by object reference: a caller hands back the very object
      // `get()` returned, and a fake that compared references would answer
      // "still fresh" for a document a second writer had already replaced.
      update: (patch: DocData, precond?: { lastUpdateTime?: unknown }) => {
        const falha = this.falhasDeUpdate.get(path);
        if (falha) return Promise.reject(falha);
        const atual = this.store[path];
        if (!atual) return Promise.reject(grpc(5, 'NOT_FOUND'));
        if (precond?.lastUpdateTime !== undefined) {
          const esperado = precond.lastUpdateTime;
          if (!ehCarimbo(esperado) || !atual.updateTime.isEqual(esperado)) {
            return Promise.reject(grpc(9, 'FAILED_PRECONDITION'));
          }
        }
        this.relogio += 1;
        this.patches.push({ path, patch });
        this.writes.push({ path, patch });
        // ⚠️ `true`: a dotted key is a FIELD PATH in `update` (and a literal
        // field NAME in `set` below) — Firestore's rule, not a convenience.
        this.store[path] = {
          data: aplicar(atual.data, patch, true),
          updateTime: carimbo(this.relogio),
        };
        return Promise.resolve();
      },
      set: (data: DocData, opts?: { merge?: boolean }) => {
        const atual = this.store[path];
        this.relogio += 1;
        this.writes.push({ path, patch: data });
        this.store[path] = {
          data: opts?.merge === true ? aplicar(atual?.data, data) : data,
          updateTime: carimbo(this.relogio),
        };
        return Promise.resolve();
      },
      delete: () => {
        delete this.store[path];
        return Promise.resolve();
      },
    };
  }

  collection(colPath: string) {
    this.caminhos.push(colPath);
    const filtros: Filtro[] = [];
    const ordens: Ordem[] = [];
    let limite: number | null = null;
    let apos: string | null = null;

    const buscar = async (): Promise<{
      docs: { id: string; updateTime: CarimboFake; data: () => DocData }[];
    }> => {
      const alvo = filtros.find((f) => f.campo === 'shop_id')?.valor;
      const falha = typeof alvo === 'number' ? this.falhas.get(alvo) : undefined;
      if (falha) throw falha;
      this.consultas.push({
        fonte: colPath,
        clausulas: filtros.map((f) => [f.campo, f.valor]),
        limite,
      });
      this.consultasCompletas.push({
        fonte: colPath,
        clausulas: filtros.map((f) => [f.campo, f.op, f.valor]),
        ordens: ordens.map((o) => [o.campo, o.direcao]),
        limite,
        apos,
      });
      // ⚠️ A query read is logged as a `get` too (step 6, #1514), so a
      // transaction that reads a whole subcollection before writing shows the
      // real `['get', 'get', 'create']` shape. Only the doc ref logged before,
      // which would have made that assertion silently one entry short.
      this.opLog.push({ op: 'get', path: colPath });
      const prefixo = `${colPath}/`;
      const encontrados = Object.entries(this.store)
        .filter(([path]) => path.startsWith(prefixo) && !path.slice(prefixo.length).includes('/'))
        .filter(([, stored]) => filtros.every((f) => corresponde(stored.data[f.campo], f)))
        .map(([path, stored]) => ({ id: path.slice(prefixo.length), stored }));
      // Order, THEN cursor, THEN cap — the three in the order the server applies
      // them: a limit taken before the sort would page a different result set.
      const ordenados = ordens.length > 0 ? ordenar(encontrados, ordens) : encontrados;
      const apartirDe = apos == null ? ordenados : depoisDe(ordenados, apos);
      const limitados = limite == null ? apartirDe : apartirDe.slice(0, limite);
      // ⚠️ `updateTime` rides every row (step 9): a guarded write derives its
      // patch from the doc a QUERY found, and without the stamp here the
      // precondition would have to be dropped in exactly the tests that exist
      // to prove it holds.
      return {
        docs: limitados.map(({ id, stored }) => ({
          id,
          updateTime: stored.updateTime,
          data: () => stored.data,
        })),
      };
    };

    const consulta = {
      /**
       * Added by step 6 (#1514), additively: the SHARED `OccEngine` identifies
       * every readable by its Firestore path and refuses one without it, and a
       * collection path is exactly how it tells a query read from a document
       * read (ODD segment count). Without this `tx.get(X.ref(db, ctx))` — the
       * whole-subcollection read `pagamentoTx.ts` and `pedidoReconcile.ts` both
       * need — cannot be expressed against this double at all.
       */
      path: colPath,
      where: (campo: string, op: string, valor: unknown) => {
        filtros.push({ campo, op, valor });
        return consulta;
      },
      /** Records AND sorts — see the step-8 note in the header. */
      orderBy: (campo: string, direcao: 'asc' | 'desc' = 'asc') => {
        ordens.push({ campo, direcao });
        return consulta;
      },
      /** The doc-snapshot cursor: everything up to and including `doc.id` goes. */
      startAfter: (doc: { id: string }) => {
        apos = doc.id;
        return consulta;
      },
      limit: (n: number) => {
        limite = n;
        return consulta;
      },
      // ⚠️ The UNLIMITED chain, and it is deliberate: the order backfill
      // enumerates every active conta with `where().where().get()` and no cap.
      get: () => buscar(),
      /** A fresh auto id for `defineAdminCollection().add()` writers. */
      add: (data: DocData) => {
        const id = `auto-${String((this.autoId += 1))}`;
        const caminho = `${colPath}/${id}`;
        this.relogio += 1;
        this.writes.push({ path: caminho, patch: data });
        this.store[caminho] = { data: aplicar(undefined, data), updateTime: carimbo(this.relogio) };
        return Promise.resolve({ id, path: caminho });
      },
      // ⚠️ No argument ⇒ an auto id, exactly like `ref.doc().id`: that is how
      // `newDocId` names a document whose derived id `asDocId` refused.
      doc: (id?: string) => {
        const real = id ?? `auto-${String((this.autoId += 1))}`;
        return this.docRef(`${colPath}/${real}`, real);
      },
    };

    return consulta;
  }

  /**
   * The collection-group chain `defineAdminCollection().groupQuery(db)` runs.
   * A row's `ref.parent.parent.id` is the OWNING document's id — for
   * `produtos/{produtoId}/variashopee/{docId}` that is the produto, which is
   * what the Shopee cascade binds the order line to.
   */
  collectionGroup(nome: string) {
    const fonte = `group:${nome}`;
    this.caminhos.push(fonte);
    const filtros: Filtro[] = [];
    let limite: number | null = null;

    const buscar = () => {
      this.consultas.push({
        fonte,
        clausulas: filtros.map((f) => [f.campo, f.valor]),
        limite,
      });
      // The group chain has no `orderBy` and no cursor — nothing in this app runs
      // one — so those two columns are constant here rather than absent: a second
      // log with a different row shape would be two logs to read.
      this.consultasCompletas.push({
        fonte,
        clausulas: filtros.map((f) => [f.campo, f.op, f.valor]),
        ordens: [],
        limite,
        apos: null,
      });
      const linhas = Object.entries(this.store)
        .map(([path, stored]) => ({ segs: path.split('/').filter(Boolean), stored }))
        .filter(({ segs }) => segs.length >= 3 && segs[segs.length - 2] === nome)
        .filter(({ stored }) => filtros.every((f) => corresponde(stored.data[f.campo], f)))
        .map(({ segs, stored }) => ({
          id: segs[segs.length - 1]!,
          exists: true,
          updateTime: stored.updateTime,
          data: () => stored.data,
          ref: { parent: { parent: { id: segs[segs.length - 3]! } } },
        }));
      const achados = limite == null ? linhas : linhas.slice(0, limite);
      return Promise.resolve({ docs: achados, empty: achados.length === 0 });
    };

    const consulta = {
      where: (campo: string, op: string, valor: unknown) => {
        filtros.push({ campo, op, valor });
        return consulta;
      },
      limit: (n: number) => {
        limite = n;
        return consulta;
      },
      get: buscar,
    };
    return consulta;
  }

  doc(path: string) {
    return this.docRef(path, path.slice(path.lastIndexOf('/') + 1));
  }
}

/** The cast every suite needs exactly once. */
export function asDb(db: FakeDb): Firestore {
  return db as unknown as Firestore;
}
