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
 * ⚠️ The write path (#1513 wave 3) adds a transaction runner over the real
 * `OccEngine` here — which is also when this file first joins the
 * `firestore-transaction-inventory` guard's scope, since that guard greps raw
 * TEXT and a doc comment naming the method is enough to pull a file in. Keep
 * every addition additive, for the same reason this file exists at all.
 */
import type { Firestore } from 'firebase-admin/firestore';

export type DocData = Record<string, unknown>;

interface Stored {
  data: DocData;
  updateTime: number;
}

interface Filtro {
  campo: string;
  valor: unknown;
}

/** An Admin-SDK-shaped failure: a plain `Error` carrying a numeric gRPC `code`. */
export function grpc(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The increment sentinel these fakes speak — see {@link FakeDb}'s header. */
export function increment(by: number): unknown {
  return { __increment: by };
}

function ehIncremento(v: unknown): v is { __increment: number } {
  return typeof v === 'object' && v !== null && '__increment' in v;
}

function aplicar(anterior: DocData | undefined, patch: DocData): DocData {
  const saida: DocData = { ...anterior };
  for (const [chave, valor] of Object.entries(patch)) {
    if (ehIncremento(valor)) {
      const base = saida[chave];
      saida[chave] = (typeof base === 'number' ? base : 0) + valor.__increment;
    } else {
      saida[chave] = valor;
    }
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
  /** Every write, in order, whatever the verb — `create`, `set` and `update`. */
  readonly writes: { path: string; patch: DocData }[] = [];
  /** Injected failures for the `shop_id` query, keyed by the shop it asks for. */
  readonly falhas = new Map<number, Error>();
  /** Injected failures for `create`, keyed by the FULL document path. */
  readonly falhasDeCriacao = new Map<string, Error>();
  private relogio = 100;
  private autoId = 0;

  seed(path: string, data: DocData): void {
    this.relogio += 1;
    this.store[path] = { data, updateTime: this.relogio };
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
        this.store[path] = { data: aplicar(undefined, data), updateTime: this.relogio };
        return Promise.resolve();
      },
      get: () => {
        const atual = this.store[path];
        return Promise.resolve({
          exists: atual !== undefined,
          updateTime: atual?.updateTime,
          data: () => atual?.data,
        });
      },
      update: (patch: DocData, precond?: { lastUpdateTime?: number }) => {
        const atual = this.store[path];
        if (!atual) return Promise.reject(grpc(5, 'NOT_FOUND'));
        if (precond?.lastUpdateTime !== undefined && precond.lastUpdateTime !== atual.updateTime) {
          return Promise.reject(grpc(9, 'FAILED_PRECONDITION'));
        }
        this.relogio += 1;
        this.patches.push({ path, patch });
        this.writes.push({ path, patch });
        this.store[path] = { data: aplicar(atual.data, patch), updateTime: this.relogio };
        return Promise.resolve();
      },
      set: (data: DocData, opts?: { merge?: boolean }) => {
        const atual = this.store[path];
        this.relogio += 1;
        this.writes.push({ path, patch: data });
        this.store[path] = {
          data: opts?.merge === true ? aplicar(atual?.data, data) : data,
          updateTime: this.relogio,
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

    const buscar = async (
      n: number | null,
    ): Promise<{ docs: { id: string; data: () => DocData }[] }> => {
      const alvo = filtros.find((f) => f.campo === 'shop_id')?.valor;
      const falha = typeof alvo === 'number' ? this.falhas.get(alvo) : undefined;
      if (falha) throw falha;
      this.consultas.push({
        fonte: colPath,
        clausulas: filtros.map((f) => [f.campo, f.valor]),
        limite: n,
      });
      const prefixo = `${colPath}/`;
      const encontrados = Object.entries(this.store)
        .filter(([path]) => path.startsWith(prefixo) && !path.slice(prefixo.length).includes('/'))
        .filter(([, stored]) => filtros.every((f) => stored.data[f.campo] === f.valor))
        .map(([path, stored]) => ({ id: path.slice(prefixo.length), data: () => stored.data }));
      return { docs: n == null ? encontrados : encontrados.slice(0, n) };
    };

    const consulta = {
      where: (campo: string, _op: string, valor: unknown) => {
        filtros.push({ campo, valor });
        return consulta;
      },
      limit: (n: number) => ({ get: () => buscar(n) }),
      // ⚠️ The UNLIMITED chain, and it is deliberate: the order backfill
      // enumerates every active conta with `where().where().get()` and no cap.
      get: () => buscar(null),
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
      const linhas = Object.entries(this.store)
        .map(([path, stored]) => ({ segs: path.split('/').filter(Boolean), stored }))
        .filter(({ segs }) => segs.length >= 3 && segs[segs.length - 2] === nome)
        .filter(({ stored }) => filtros.every((f) => stored.data[f.campo] === f.valor))
        .map(({ segs, stored }) => ({
          id: segs[segs.length - 1]!,
          exists: true,
          data: () => stored.data,
          ref: { parent: { parent: { id: segs[segs.length - 3]! } } },
        }));
      const achados = limite == null ? linhas : linhas.slice(0, limite);
      return Promise.resolve({ docs: achados, empty: achados.length === 0 });
    };

    const consulta = {
      where: (campo: string, _op: string, valor: unknown) => {
        filtros.push({ campo, valor });
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
