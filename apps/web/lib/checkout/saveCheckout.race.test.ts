/**
 * #824 / ADR 0011 — `salvarCheckoutTransacao`'s two phases must apply the SAME
 * discipline.
 *
 * Phase 1 is the reference: every gate is re-checked against `snap.data()`, the
 * transaction snapshot (that re-check was itself a legacy bug fix). Phase 2 was
 * not: `retirada` is decided by two NON-transactional `getDoc` round-trips, and
 * the write was unconditional — the `tx.get` fed nothing but `snap.exists()`.
 * So anything that advanced `freteInicial.estado` in the gap between the phases
 * was dragged back to `aguardandoRetirada`.
 *
 * The FakeDb is a client-SDK adapter (`runTransaction(db, cb)`,
 * `snap.exists()` as a METHOD) over the shared `OccEngine`
 * (`@delfrance/data/testing`) — five lines of shape, not a second engine.
 *
 * The second block pins phase 1's own loser rule: it never writes the goods-in
 * `checkFinalizado` over a freight whose goods already left the warehouse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  ESTADOS_FRETE_MERCADORIA_FORA,
  estadoFreteSchema,
} from '@delfrance/schemas';

const PEDIDO_PATH = 'pedidos/ped-1';

type Doc = Record<string, unknown>;

class FakeDb {
  private readonly docs = new Map<string, Doc>();

  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      const prev = this.docs.get(path) ?? {};
      if (kind === 'update') {
        // Dotted-path update, the spelling saveCheckout uses so the write's
        // affectedKeys stay narrow.
        const next: Doc = { ...prev };
        for (const [k, v] of Object.entries(data)) {
          if (!k.includes('.')) {
            next[k] = v;
            continue;
          }
          const cut = k.indexOf('.');
          const head = k.slice(0, cut);
          const tail = k.slice(cut + 1);
          next[head] = { ...((next[head] as Doc | undefined) ?? {}), [tail]: v };
        }
        this.docs.set(path, next);
      } else {
        this.docs.set(path, { ...data });
      }
    },
  });

  seed(path: string, doc: Doc): void {
    this.docs.set(path, doc);
  }
  remove(path: string): void {
    this.docs.delete(path);
  }
  read(path: string): Doc | undefined {
    return this.docs.get(path);
  }

  docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      // The BROWSER SDK shape: `exists` is a method, not a property.
      get: async () => ({
        exists: () => this.docs.has(path),
        data: () => this.docs.get(path),
      }),
    };
  }
}

const h = vi.hoisted(() => ({
  db: null as unknown,
  runTransaction: vi.fn(),
  pedidoDocRef: vi.fn(),
  checkoutDocRef: vi.fn(),
  getDoc: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  // The browser SDK takes `db` FIRST — the ML/whatsapp fakes take the callback
  // only. That difference is the whole reason for this adapter.
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

function seedPedido(freteEstado: string): void {
  db.seed(PEDIDO_PATH, {
    ehSaida: true,
    numero: '100',
    estado: ESTADO_PEDIDO.pago,
    freteInicial: { estado: freteEstado, ehReverso: false },
  });
}

/**
 * `isRetiradaNaLoja` does two plain `getDoc`s — the pedido, then the int_frete —
 * and it runs strictly BETWEEN the two transactions. That makes it the exact
 * seam a competing writer occupies, so `betweenPhases` fires from the int_frete
 * read: after phase 1 has committed, before phase 2 opens.
 *
 * (`beforeCommit` is the wrong hook here. It fires before phase 1's commit, so
 * phase 1's own dotted `freteInicial.estado` write would simply clobber the
 * competitor and the test would prove nothing.)
 */
function arrangeRetiradaNaLoja(tipo = 'retiradaNaLoja', betweenPhases?: () => void): void {
  h.getDoc.mockImplementation(async (ref: { path?: string }) => {
    if (ref?.path === 'int_frete/if-1') {
      betweenPhases?.();
      return { exists: () => true, data: () => ({ tipo }) };
    }
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

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.runTransaction.mockImplementation((fn: (tx: OccTransaction) => Promise<unknown>) =>
    db.occ.runTransaction(fn),
  );
  h.pedidoDocRef.mockImplementation(() => db.docRef(PEDIDO_PATH));
  h.checkoutDocRef.mockImplementation(() => db.docRef(`${PEDIDO_PATH}/checkout/chk-1`));
});

const input = {
  pedidoId: 'ped-1',
  uid: 'u1',
  log: [],
  estadoContinuar: null,
  nowMs: 1_700_000_000_000,
};

describe('salvarCheckoutTransacao — phase 2 (retiradaNaLoja)', () => {
  it('advances to aguardandoRetirada when the frete is still where phase 1 left it', async () => {
    seedPedido(ESTADO_FRETE.despachoAutorizado);
    arrangeRetiradaNaLoja();

    const out = await salvarCheckoutTransacao(h.db as never, input);

    expect(out.retirada).toBe(true);
    expect((db.read(PEDIDO_PATH)?.freteInicial as Doc).estado).toBe(
      ESTADO_FRETE.aguardandoRetirada,
    );
  });

  it('does NOT drag the frete back when someone advanced it between the phases', async () => {
    seedPedido(ESTADO_FRETE.despachoAutorizado);
    // A second writer moves the frete on once phase 1 has committed — an
    // operator marking it collected, or a marketplace shipment handler.
    arrangeRetiradaNaLoja('retiradaNaLoja', () => {
      db.seed(PEDIDO_PATH, {
        ...db.read(PEDIDO_PATH),
        freteInicial: { estado: ESTADO_FRETE.entregue, ehReverso: false },
      });
    });

    const out = await salvarCheckoutTransacao(h.db as never, input);

    expect(out.retirada).toBe(true);
    // Before #824 this read `aguardandoRetirada` — a delivered order silently
    // reverted to "waiting for pickup".
    expect((db.read(PEDIDO_PATH)?.freteInicial as Doc).estado).toBe(ESTADO_FRETE.entregue);
  });

  it('skips phase 2 entirely when the pedido vanished between the phases', async () => {
    seedPedido(ESTADO_FRETE.despachoAutorizado);
    arrangeRetiradaNaLoja('retiradaNaLoja', () => db.remove(PEDIDO_PATH));

    await expect(salvarCheckoutTransacao(h.db as never, input)).resolves.toMatchObject({
      retirada: true,
    });
    expect(db.read(PEDIDO_PATH)).toBeUndefined();
  });

  it('leaves the frete at checkFinalizado when the integração is not retiradaNaLoja', async () => {
    seedPedido(ESTADO_FRETE.despachoAutorizado);
    arrangeRetiradaNaLoja('melhorEnvios');

    const out = await salvarCheckoutTransacao(h.db as never, input);

    expect(out.retirada).toBe(false);
    expect((db.read(PEDIDO_PATH)?.freteInicial as Doc).estado).toBe(ESTADO_FRETE.checkFinalizado);
  });
});

/**
 * Phase 1 must never move a freight whose goods already LEFT the warehouse back
 * to a goods-in estado. The operator reaches this write from such an estado by
 * confirming gate 9 ("not in Despacho autorizado"), and `checkFinalizado` is
 * goods IN: a marketplace importer that reads the stored estado — the Amazon
 * CANCELLED read decides restock from it — would then put back on the shelf
 * units the carrier holds.
 */
describe('salvarCheckoutTransacao — phase 1 keeps a goods-out freight estado', () => {
  const freteEstado = (): unknown => (db.read(PEDIDO_PATH)?.freteInicial as Doc).estado;

  it('⭐ keeps a posted freight at postado — and still writes the checkout', async () => {
    seedPedido(ESTADO_FRETE.postado);
    arrangeRetiradaNaLoja('melhorEnvios');

    const out = await salvarCheckoutTransacao(h.db as never, {
      ...input,
      estadoContinuar: ESTADO_FRETE.postado,
    });

    expect(freteEstado()).toBe(ESTADO_FRETE.postado);
    expect(out).toEqual({ checkoutId: 'chk-1', retirada: false });
    expect(db.read(`${PEDIDO_PATH}/checkout/chk-1`)).toMatchObject({
      title: '100',
      usuarioCheckoutFretePedidoOuterRef: 'documents/usuarios/u1',
      timestamp: input.nowMs,
    });
  });

  it.each([
    ESTADO_FRETE.aCaminho,
    ESTADO_FRETE.entregue,
    ESTADO_FRETE.falhaNaEntrega,
    ESTADO_FRETE.objetoExtraviado,
  ])('keeps %s (goods out, a delivery failure included)', async (estado) => {
    seedPedido(estado);
    arrangeRetiradaNaLoja('melhorEnvios');

    await salvarCheckoutTransacao(h.db as never, { ...input, estadoContinuar: estado });

    expect(freteEstado()).toBe(estado);
    expect(db.read(`${PEDIDO_PATH}/checkout/chk-1`)).toBeDefined();
  });

  // The two sides iterate the SHARED set, so a checkout-local copy that drifted
  // from it reds one of them. The set's own members are pinned as literals in
  // `packages/schemas/src/shared/frete.test.ts`.
  it('keeps EVERY estado of the shared goods-out set', async () => {
    expect(ESTADOS_FRETE_MERCADORIA_FORA.size).toBe(12);
    for (const estado of ESTADOS_FRETE_MERCADORIA_FORA) {
      db = new FakeDb();
      seedPedido(estado);
      arrangeRetiradaNaLoja('melhorEnvios');

      await salvarCheckoutTransacao(h.db as never, { ...input, estadoContinuar: estado });

      expect(freteEstado(), estado).toBe(estado);
      expect(db.read(`${PEDIDO_PATH}/checkout/chk-1`), estado).toBeDefined();
    }
  });

  it('⚠️ NEAR-MISS: every goods-IN estado still moves to checkFinalizado', async () => {
    const dentro = estadoFreteSchema.options.filter((e) => !ESTADOS_FRETE_MERCADORIA_FORA.has(e));
    // Packed and still on the shelf is goods in — the ladder index is not the rule.
    expect(dentro).toEqual(
      expect.arrayContaining([
        ESTADO_FRETE.despachoAutorizado,
        ESTADO_FRETE.emSeparacao,
        ESTADO_FRETE.empacotado,
        ESTADO_FRETE.aguardandoPostagem,
        ESTADO_FRETE.checkFinalizado,
      ]),
    );
    for (const estado of dentro) {
      db = new FakeDb();
      seedPedido(estado);
      arrangeRetiradaNaLoja('melhorEnvios');

      // `estadoContinuar` = the estado itself: the confirm gate-9 path (for the
      // allowed four, the plain one — the tx accepts either).
      await salvarCheckoutTransacao(h.db as never, { ...input, estadoContinuar: estado });

      expect(freteEstado(), estado).toBe(ESTADO_FRETE.checkFinalizado);
    }
  });

  it('a kept estado opens no phase 2 — even for a pickup integração', async () => {
    seedPedido(ESTADO_FRETE.aguardandoRetirada);
    arrangeRetiradaNaLoja('retiradaNaLoja');

    const out = await salvarCheckoutTransacao(h.db as never, {
      ...input,
      estadoContinuar: ESTADO_FRETE.aguardandoRetirada,
    });

    expect(out.retirada).toBe(false);
    expect(freteEstado()).toBe(ESTADO_FRETE.aguardandoRetirada);
    expect(h.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('re-derives from the TX snapshot: a carrier posting the freight after the read is kept', async () => {
    // The operator confirmed an out-of-set goods-in estado; the carrier sync
    // posts it before phase 1 commits. The OCC retry re-reads `postado` — which
    // is not the confirmed estado, so the tx refuses rather than overwrite it.
    seedPedido(ESTADO_FRETE.checkFinalizado);
    arrangeRetiradaNaLoja('melhorEnvios');
    db.occ.beforeCommit = async () => {
      db.occ.beforeCommit = null;
      // A committed competitor (it bumps the version phase 1 read), not a seed.
      await db.occ.runTransaction(async (tx) => {
        tx.update(db.docRef(PEDIDO_PATH), { 'freteInicial.estado': ESTADO_FRETE.postado });
      });
    };

    await expect(
      salvarCheckoutTransacao(h.db as never, {
        ...input,
        estadoContinuar: ESTADO_FRETE.checkFinalizado,
      }),
    ).rejects.toMatchObject({ kind: 'frete-estado' });
    expect(freteEstado()).toBe(ESTADO_FRETE.postado);
  });
});
