/**
 * B9 (master plan step 15) — checkout phase 2 decides the pickup hand-off with
 * the SHARED `avancaParaRetirada` (`@delfrance/schemas`) and nothing else: both
 * the decision to open its transaction at all, and the re-check inside it on
 * the `tx.get` estado. The Loja Integrada routing route applies the same rule
 * when it re-points a checked-out pedido at a pickup target, so a local copy of
 * either half would let the two drift — the rule changes in the shared file,
 * the outer gate keeps the old predicate, and phase 2 silently never runs.
 *
 * The phase-2 behaviour itself is pinned, unedited, by
 * `saveCheckout.race.test.ts`. This file pins only WHERE the decision comes
 * from: the shared rule is replaced by a stand-in that disagrees with today's
 * predicate (it hands off a `motoboy` target), and phase 2 must follow it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import { ESTADO_FRETE, ESTADO_PEDIDO } from '@delfrance/schemas';

const PEDIDO_PATH = 'pedidos/ped-1';

type Doc = Record<string, unknown>;

class FakeDb {
  private readonly docs = new Map<string, Doc>();

  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      const prev = this.docs.get(path) ?? {};
      if (kind !== 'update') {
        this.docs.set(path, { ...data });
        return;
      }
      const next: Doc = { ...prev };
      for (const [k, v] of Object.entries(data)) {
        const cut = k.indexOf('.');
        if (cut < 0) {
          next[k] = v;
          continue;
        }
        const head = k.slice(0, cut);
        next[head] = { ...((next[head] as Doc | undefined) ?? {}), [k.slice(cut + 1)]: v };
      }
      this.docs.set(path, next);
    },
  });

  seed(path: string, doc: Doc): void {
    this.docs.set(path, doc);
  }
  read(path: string): Doc | undefined {
    return this.docs.get(path);
  }
  docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => ({ exists: () => this.docs.has(path), data: () => this.docs.get(path) }),
    };
  }
}

const h = vi.hoisted(() => ({
  runTransaction: vi.fn(),
  pedidoDocRef: vi.fn(),
  checkoutDocRef: vi.fn(),
  getDoc: vi.fn(),
  regra: null as null | ((estado: unknown, tipoAlvo: unknown) => boolean),
}));

vi.mock('@delfrance/schemas', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/schemas')>('@delfrance/schemas');
  return {
    ...actual,
    avancaParaRetirada: (estado: unknown, tipoAlvo: unknown) =>
      (h.regra ?? actual.avancaParaRetirada)(estado, tipoAlvo),
  };
});
vi.mock('firebase/firestore', () => ({
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.runTransaction(fn),
  getDoc: (...args: unknown[]) => h.getDoc(...args),
}));
vi.mock('../data/pedidoCollection', () => ({
  pedidoCollection: { docRef: (...a: unknown[]) => h.pedidoDocRef(...a) },
}));
vi.mock('../data/checkoutCollection', () => ({
  checkoutCollection: { docRef: (...a: unknown[]) => h.checkoutDocRef(...a) },
}));
vi.mock('../data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: () => ({ path: 'int_frete/if-1' }),
}));
vi.mock('../data/newDocId', () => ({ newDocId: () => 'chk-1' }));

const { salvarCheckoutTransacao } = await import('./saveCheckout');

let db: FakeDb;

function arrange(tipo: string): void {
  db.seed(PEDIDO_PATH, {
    ehSaida: true,
    numero: '100',
    estado: ESTADO_PEDIDO.pago,
    freteInicial: { estado: ESTADO_FRETE.despachoAutorizado, ehReverso: false },
  });
  h.getDoc.mockImplementation(async (ref: { path?: string }) => {
    if (ref?.path === 'int_frete/if-1') return { exists: () => true, data: () => ({ tipo }) };
    const doc = db.read(PEDIDO_PATH);
    return {
      exists: () => doc !== undefined,
      data: () => ({
        ...doc,
        freteInicial: { integracaoFreteOuterRef: 'documents/int_frete/if-1' },
      }),
    };
  });
}

const input = {
  pedidoId: 'ped-1',
  uid: 'u1',
  log: [],
  estadoContinuar: null,
  nowMs: 1_700_000_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.regra = null;
  db = new FakeDb();
  h.runTransaction.mockImplementation((fn: (tx: OccTransaction) => Promise<unknown>) =>
    db.occ.runTransaction(fn),
  );
  h.pedidoDocRef.mockImplementation(() => db.docRef(PEDIDO_PATH));
  h.checkoutDocRef.mockImplementation(() => db.docRef(`${PEDIDO_PATH}/checkout/chk-1`));
});

describe('salvarCheckoutTransacao — phase 2 decides through the SHARED rule (B9)', () => {
  it('⭐ a shared rule that hands off another target is followed — the outer gate holds no copy of its own', async () => {
    h.regra = (estado, tipoAlvo) =>
      tipoAlvo === 'motoboy' && estado === ESTADO_FRETE.checkFinalizado;
    arrange('motoboy');

    const out = await salvarCheckoutTransacao({} as never, input);

    expect(out.retirada).toBe(true);
    expect((db.read(PEDIDO_PATH)?.freteInicial as Doc).estado).toBe(
      ESTADO_FRETE.aguardandoRetirada,
    );
    // Phase 1, then phase 2: the second transaction opened.
    expect(h.runTransaction).toHaveBeenCalledTimes(2);
  });

  it('⚠️ NEAR-MISS: a shared rule that hands off NOTHING keeps even a pickup at checkFinalizado — and opens no second transaction', async () => {
    h.regra = () => false;
    arrange('retiradaNaLoja');

    const out = await salvarCheckoutTransacao({} as never, input);

    expect(out.retirada).toBe(false);
    expect((db.read(PEDIDO_PATH)?.freteInicial as Doc).estado).toBe(ESTADO_FRETE.checkFinalizado);
    expect(h.runTransaction).toHaveBeenCalledTimes(1);
  });
});
