import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  READ_CACHE_DISABLED_ENV,
  READ_CACHE_TTL,
  __resetAllReadCaches,
} from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import {
  __setShopeeCacheClockForTests,
  findIntegracaoByShopId,
  invalidateShopeeConta,
  readConta,
} from './contaCache';

/**
 * Minimal Firestore double: `collection(path).doc(id).get()` for the cached
 * reader, plus the `where/where/where/limit/get` chain the `shop_id` resolver
 * runs. Modelled on `apps/mercado-livre/lib/marketplace/core/contaCache.test.ts`.
 *
 * ⚠️ It records EVERY path it is asked for, which is what lets the last test
 * assert that this module never reaches for a credential.
 */
type DocData = Record<string, unknown>;

interface Filtro {
  campo: string;
  valor: unknown;
}

class FakeDb {
  /** Every collection and document path touched, in order. */
  readonly caminhos: string[] = [];
  /** Document `get()`s only — the read counter the cache tests assert on. */
  readonly leituras: string[] = [];
  /** Collection queries actually executed. */
  readonly consultas: Filtro[][] = [];
  private readonly store = new Map<string, DocData>();

  seed(path: string, data: DocData): void {
    this.store.set(path, data);
  }

  remove(path: string): void {
    this.store.delete(path);
  }

  collection(colPath: string) {
    this.caminhos.push(colPath);
    const filtros: Filtro[] = [];

    const consulta = {
      where: (campo: string, _op: string, valor: unknown) => {
        filtros.push({ campo, valor });
        return consulta;
      },
      limit: (n: number) => ({
        get: async (): Promise<{ docs: { id: string; data: () => DocData }[] }> => {
          this.consultas.push([...filtros]);
          const prefixo = `${colPath}/`;
          const encontrados = [...this.store.entries()]
            .filter(
              ([path]) => path.startsWith(prefixo) && !path.slice(prefixo.length).includes('/'),
            )
            .filter(([, data]) => filtros.every((f) => data[f.campo] === f.valor))
            .slice(0, n)
            .map(([path, data]) => ({ id: path.slice(prefixo.length), data: () => data }));
          return { docs: encontrados };
        },
      }),
      doc: (id: string) => {
        const full = `${colPath}/${id}`;
        this.caminhos.push(full);
        return {
          path: full,
          get: async (): Promise<{ exists: boolean; data: () => DocData | undefined }> => {
            this.leituras.push(full);
            const data = this.store.get(full);
            return { exists: data !== undefined, data: () => data };
          },
        };
      },
    };

    return consulta;
  }
}

const asDb = (db: FakeDb): Firestore => db as unknown as Firestore;

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const CONTA_PATH = `${INTEGRACAO_PATH}/int-1`;

function contaDoc(over: DocData = {}): DocData {
  return {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja BR',
    shop_id: 987654,
    ...over,
  };
}

let agora = 1_700_000_000_000;

beforeEach(() => {
  __resetAllReadCaches();
  agora = 1_700_000_000_000;
  __setShopeeCacheClockForTests(() => agora);
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeCacheClockForTests();
  vi.unstubAllEnvs();
});

describe('readConta', () => {
  it('serves a repeated read from cache', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await readConta(asDb(db), 'int-1');
    await readConta(asDb(db), 'int-1');

    expect(db.leituras).toEqual([CONTA_PATH]);
  });

  it('re-reads after ttlMs — the staleness bound, not just the hit', async () => {
    // The near-miss half of the pair above: a test that the cache HITS cannot
    // show where the hit stops being served.
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await readConta(asDb(db), 'int-1');
    agora += READ_CACHE_TTL.config - 1;
    await readConta(asDb(db), 'int-1');
    expect(db.leituras).toHaveLength(1);

    // The boundary is EXCLUSIVE: at exactly `ttlMs` the entry is expired.
    agora += 1;
    await readConta(asDb(db), 'int-1');
    expect(db.leituras).toHaveLength(2);
  });

  it('re-reads after invalidateShopeeConta', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await readConta(asDb(db), 'int-1');
    invalidateShopeeConta('int-1');
    await readConta(asDb(db), 'int-1');

    expect(db.leituras).toHaveLength(2);
  });

  it('refuses a cached conta that has not completed the consent (isFresh)', async () => {
    // `exchangeAndPersist` back-fills `shop_id` on a DIFFERENT instance from the
    // ones reading it, so a hit on a consent-less document must not be served.
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc({ shop_id: null }));

    await readConta(asDb(db), 'int-1');
    await readConta(asDb(db), 'int-1');

    expect(db.leituras).toHaveLength(2);
  });

  it('does not cache an absent document (negativeTtlMs: 0)', async () => {
    const db = new FakeDb();

    await expect(readConta(asDb(db), 'int-1')).resolves.toBeNull();
    await expect(readConta(asDb(db), 'int-1')).resolves.toBeNull();

    expect(db.leituras).toHaveLength(2);
  });
});

describe('findIntegracaoByShopId', () => {
  it('queries on tipo + shop_id + ativo and returns the document id', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await expect(findIntegracaoByShopId(asDb(db), 987654)).resolves.toBe('int-1');
    expect(db.consultas).toEqual([
      [
        { campo: 'tipo', valor: INTEGRACAO_TIPO.shopee },
        { campo: 'shop_id', valor: 987654 },
        { campo: 'ativo', valor: true },
      ],
    ]);
  });

  it('never claims a shop for an INACTIVE integração', async () => {
    // The near-miss to the query test: `ativo` is a predicate, not decoration.
    // A deactivated conta must not swallow its shop's pushes.
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc({ ativo: false }));

    await expect(findIntegracaoByShopId(asDb(db), 987654)).resolves.toBeNull();
  });

  it('serves the second lookup from cache and PRE-WARMS the conta read', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await findIntegracaoByShopId(asDb(db), 987654);
    await findIntegracaoByShopId(asDb(db), 987654);
    expect(db.consultas).toHaveLength(1);

    // The cross-check already read the conta, so the caller's own read is free.
    const antes = db.leituras.length;
    await readConta(asDb(db), 'int-1');
    expect(db.leituras).toHaveLength(antes);
  });

  it('does NOT cache an unmapped shop — the operator may connect it next second', async () => {
    const db = new FakeDb();

    await expect(findIntegracaoByShopId(asDb(db), 987654)).resolves.toBeNull();
    await expect(findIntegracaoByShopId(asDb(db), 987654)).resolves.toBeNull();
    expect(db.consultas).toHaveLength(2);

    // …and the conta connected a moment later is found by the very next call.
    db.seed(CONTA_PATH, contaDoc());
    await expect(findIntegracaoByShopId(asDb(db), 987654)).resolves.toBe('int-1');
  });

  it('self-heals a mapping whose conta now names a DIFFERENT shop', async () => {
    // Another instance ran the OAuth callback and the conta moved to shop 222,
    // while this instance still has 987654 → int-1 cached. `isFresh` cannot see
    // it (a stale copy still has `shop_id != null`), so without the cross-check
    // this app would act on one shop's event under another shop's conta.
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());
    await findIntegracaoByShopId(asDb(db), 987654);

    db.seed(CONTA_PATH, contaDoc({ shop_id: 222 }));
    await expect(findIntegracaoByShopId(asDb(db), 222)).resolves.toBe('int-1');
    // …and the conta every reader sees next is the FRESH one.
    expect((await readConta(asDb(db), 'int-1'))?.shop_id).toBe(222);
  });

  it('bounds the self-heal at ONE eviction and ONE retry', async () => {
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());
    await findIntegracaoByShopId(asDb(db), 987654);
    const consultasAntes = db.consultas.length;

    db.seed(CONTA_PATH, contaDoc({ shop_id: 222 }));
    await findIntegracaoByShopId(asDb(db), 222);

    expect(db.consultas.length - consultasAntes).toBe(2);
  });

  it('re-resolves rather than returning an id whose conta is gone', async () => {
    // A cached mapping can outlive its document: the conta entry is dropped (by
    // the LRU, or by an evict from this very process) while the id entry
    // survives, and the document was meanwhile deleted from apps/web's BROWSER
    // client — which no server instance can be told about. Returning that id
    // would make the context loader throw `ShopeeContaNotConfiguredError`, which
    // the pipeline reads as retryable and eventually persists as a failure;
    // the uncached query answers `null` and the delivery is DEFERRED, which is
    // recoverable.
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());
    await findIntegracaoByShopId(asDb(db), 987654);

    db.remove(CONTA_PATH);
    invalidateShopeeConta('int-1');

    await expect(findIntegracaoByShopId(asDb(db), 987654)).resolves.toBeNull();
  });
});

describe('token-free by construction', () => {
  it('never touches a credential path', async () => {
    // The first case `@delfrance/data/admin/cache` forbids is an OAuth token, and
    // Shopee's refresh token is single-use and rotating — a cached copy turns a
    // survivable race into a burnt pair. This module must only ever read the
    // `integracao` document itself.
    const db = new FakeDb();
    db.seed(CONTA_PATH, contaDoc());

    await findIntegracaoByShopId(asDb(db), 987654);
    await readConta(asDb(db), 'int-1');
    invalidateShopeeConta('int-1');
    await readConta(asDb(db), 'int-1');

    expect(db.caminhos.length).toBeGreaterThan(0);
    expect(db.caminhos.filter((p) => p.includes('/credenciais'))).toEqual([]);
    expect(
      db.caminhos.every((p) => p === INTEGRACAO_PATH || p.startsWith(`${INTEGRACAO_PATH}/`)),
    ).toBe(true);
  });
});
