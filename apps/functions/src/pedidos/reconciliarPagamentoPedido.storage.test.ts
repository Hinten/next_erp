import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { PedidoReconcileNotFoundError, reconcilePedidoEstado } from '@delfrance/data/admin';
import { ESTADO_FRETE, STATUS_PAGAMENTO } from '@delfrance/schemas';

// Integration test — requires the firestore emulator. Drives the exported
// `reconcilePedidoEstado` core directly (the `reconciliarPagamentoPedido`
// onCall wrapper only adds auth + Zod validation, both covered elsewhere).
// This is the ONE place the load-bearing claim of #308 is actually proven:
// the REAL Admin SDK reads the pagamentos QUERY inside `runTransaction`, in
// the same snapshot as the pedido. Every other test of this core runs against
// a hand-rolled fake whose `tx.get(collectionRef)` is an `Object.entries()`
// filter, which proves nothing about the SDK. Skipped bare.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function pedidoRef(db: Firestore, pedidoId: string) {
  return db.collection('pedidos').doc(pedidoId);
}

/*
 * ─── The two audit trails ────────────────────────────────────────────────────
 *
 * Neither trail is written by the reconcile any more: the
 * `onPedidoChanged` trigger observes the pedido write and appends to BOTH
 * — `historicoEstadoPedido` for the pedido's `estado`, `historicoFtIni` for the
 * embedded `freteInicial.estado` — asynchronously, so the rows land AFTER
 * `reconcilePedidoEstado` resolves. Hence the pollers below.
 *
 * ⚠️ BOTH trails carry an OPENING row for whatever `seedPedido` created the
 * pedido with — the trigger records creates too, and every pedido seeded here
 * carries a `freteInicial`. So assertions must count rows of a GIVEN estado,
 * never the whole trail: `toHaveLength(1)` on the trail would pass or fail for
 * reasons that have nothing to do with the reconcile.
 */

async function historicos(db: Firestore, pedidoId: string) {
  const snap = await pedidoRef(db, pedidoId).collection('historicoEstadoPedido').get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

async function freteHistoricos(db: Firestore, pedidoId: string) {
  const snap = await pedidoRef(db, pedidoId).collection('historicoFtIni').get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/**
 * Neither trail is written by the reconcile: the `onPedidoChanged` trigger
 * observes the pedido write and appends asynchronously, so the rows land AFTER
 * `reconcilePedidoEstado` resolves.
 *
 * Wait for `minRows`, then hold still for a quiet window and re-read. The quiet
 * window is what makes an exact-count assertion able to FAIL: returning on the
 * first poll that satisfies the minimum would read a snapshot that can predate a
 * later row, so "the trail is exactly these rows" would pass by arriving early.
 *
 * `seedPedido` creates the pedido, and the trigger records creates too — so the
 * trail always opens with a row for the estado the pedido was seeded with, and
 * a single transition means TWO rows, not one.
 */
async function waitForTrail(
  db: Firestore,
  pedidoId: string,
  minRows: number,
  { timeoutMs = 20_000, quietMs = 2_000 } = {},
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const trail = await historicos(db, pedidoId);
    if (trail.length >= minRows) {
      await new Promise((r) => setTimeout(r, quietMs));
      return historicos(db, pedidoId);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${minRows} historicoEstadoPedido row(s); saw ${trail.length}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForFreteRow(
  db: Firestore,
  pedidoId: string,
  estado: string,
  timeoutMs = 20_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const trail = await freteHistoricos(db, pedidoId);
    if (trail.some((r) => r.estado === estado)) return trail;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a '${estado}' historicoFtIni row`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Bounded negative: assert a trail never gains a row carrying `eventId`,
 * re-reading across `windowMs`.
 *
 * Why not a single read. The trigger launches both trails' writes concurrently
 * (`Promise.all` in `registrarHistoricoPedido.ts`), so seeing the `pago` row proves
 * the trigger RAN for that CloudEvent — it does NOT prove that a (wrongly
 * emitted) frete row for the same event has finished landing. A one-shot read
 * could slip between the two `set()`s and pass in exactly the regressed case
 * this exists to catch. Re-reading across a window closes that while staying
 * event-id-keyed, so it can never be satisfied by an unrelated row, and it
 * fails on the first tick that sees one instead of after the whole window.
 */
async function expectNoRowForEvent(
  readTrail: () => Promise<Array<Record<string, unknown>>>,
  eventId: string,
  windowMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const trail = await readTrail();
    expect(trail.some((r) => r.eventId === eventId)).toBe(false);
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Seed one pedido + its pagamentos with plain Admin-SDK writes (deliberately
 * NOT through the collection handles the code under test uses). The pedido id
 * is unique per call so tests never interfere.
 */
async function seedPedido(
  db: Firestore,
  pedido: Record<string, unknown>,
  pagamentos: ReadonlyArray<Record<string, unknown>> = [],
): Promise<string> {
  const pedidoId = `ped${randomUUID().replace(/-/g, '')}`;
  const ref = pedidoRef(db, pedidoId);
  await ref.set(pedido);
  for (const [i, pagamento] of pagamentos.entries()) {
    const pagamentoId = `pay${i + 1}`;
    await ref.collection('pagamentos').doc(pagamentoId).set(pagamento);
  }
  return pedidoId;
}

describe.skipIf(!EMULATED)('reconcilePedidoEstado core (emulator)', () => {
  it('sums a real multi-doc pagamentos query in-transaction and transitions to pago', async () => {
    const db = getDb();
    const pedidoId = await seedPedido(
      db,
      {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: ESTADO_FRETE.iniciado, codRastreio: null },
      },
      [
        { valor: 60, status_pagamento: STATUS_PAGAMENTO.aprovado },
        { valor: 40, status_pagamento: STATUS_PAGAMENTO.aprovado },
        // `isPagamentoPagante` is null-or-aprovado, so this 1000 must NOT
        // cover the total — the filter runs over what the real query returned.
        { valor: 1000, status_pagamento: STATUS_PAGAMENTO.recusado },
      ],
    );

    const result = await reconcilePedidoEstado(db, { pedidoId });

    expect(result).toEqual({ transition: 'pago' });

    const pedido = (await pedidoRef(db, pedidoId).get()).data()!;
    expect(pedido.estado).toBe('pago');
    expect(pedido.freteInicial).toEqual({
      estado: ESTADO_FRETE.despachoAutorizado,
      codRastreio: null,
    });

    // The trigger records the transition: the opening row for the estado the
    // pedido was seeded with, plus the transition. Nothing more.
    const trail = await waitForTrail(db, pedidoId, 2);
    expect(trail.map((r) => r.estado as string).sort()).toEqual(
      ['aguardandoConfirmacaoDePagamento', 'pago'].sort(),
    );
    // Its usuário is null — this reconcile runs on the Admin SDK, so there is no
    // end user behind the write for the trigger's auth context to resolve.
    //
    // ⚠️ In the emulator this assertion cannot tell a working resolver from a
    // broken one: `authId` is hardcoded to 'fake-auth-id@gmail.com'
    // (firebase-tools#7609), which is not uid-shaped and resolves to null no
    // matter what. A REAL actor is asserted against staging, in
    // `apps/web/e2e/pedidos-estado.vendas.e2e.spec.ts`.
    expect(trail.find((r) => r.estado === 'pago')).toMatchObject({
      usuarioHistoricoEstadosPedidoOuterRef: null,
    });

    // …and the frete trail records the despatch authorization the same write
    // performed — exactly once, on top of the seed's opening `iniciado` row.
    const freteTrail = await waitForFreteRow(db, pedidoId, ESTADO_FRETE.despachoAutorizado);
    expect(freteTrail.filter((r) => r.estado === ESTADO_FRETE.despachoAutorizado)).toHaveLength(1);
    expect(freteTrail.find((r) => r.estado === ESTADO_FRETE.despachoAutorizado)).toMatchObject({
      usuarioHistoricoFreteInicialOuterRef: null,
      obs: null,
    });
  }, 60_000);

  // The contrast to the happy path above. The unit suite next door covers the
  // rule exhaustively against a fake; this one is the end-to-end proof, on the
  // real Admin SDK and a real document: the guard reads `freteInicial` off the
  // same in-transaction snapshot it then patches, and only here is that a
  // genuine Firestore read-modify-write rather than an object literal the test
  // itself supplied. The blast radius is also wider than a cosmetic estado —
  // `empacotado` is in `ESTADOS_FRETE_REMOVE_ESTOQUE` and `despachoAutorizado`
  // is not, so the #702 regression flips `efeitoEstoquePedido` and un-removes
  // the pedido's stock: it reaches the pedido→estoque sync, not just the Frete tab.
  it('does not regress a packed frete when the pedido becomes pago (#702)', async () => {
    const db = getDb();
    const pedidoId = await seedPedido(
      db,
      {
        estado: 'iniciado',
        valorCobrado: 100,
        // Already past authorization — the warehouse packed this shipment. The
        // old `!isFreteJaPostado(estado)` test is true for `empacotado`, which
        // is exactly how a full payment used to drag it back to
        // `despachoAutorizado`.
        freteInicial: { estado: ESTADO_FRETE.empacotado, codRastreio: null },
      },
      [{ valor: 100, status_pagamento: STATUS_PAGAMENTO.aprovado }],
    );

    // Settle the SEED's own opening frete row first and remember which event
    // produced it — everything below distinguishes "the seed wrote this" from
    // "the reconcile wrote this" by event id, never by counting after a sleep.
    const seedFreteTrail = await waitForFreteRow(db, pedidoId, ESTADO_FRETE.empacotado);
    expect(seedFreteTrail).toHaveLength(1);
    const seedEventId = seedFreteTrail[0]!.eventId as string;

    const result = await reconcilePedidoEstado(db, { pedidoId });

    // The estado transition still happens — only the frete write is suppressed.
    expect(result).toEqual({ transition: 'pago' });

    const pedido = (await pedidoRef(db, pedidoId).get()).data()!;
    expect(pedido.estado).toBe('pago');
    expect(pedido.freteInicial).toEqual({ estado: ESTADO_FRETE.empacotado, codRastreio: null });

    // The pedido write still fires the trigger, so the trail records the estado
    // transition — same shape as the happy path: the opening row for the seeded
    // estado plus the transition. The suppressed frete write leaves no trace
    // here; this trail records `estado`, not `freteInicial`.
    const trail = await waitForTrail(db, pedidoId, 2);
    expect(trail.map((r) => r.estado as string).sort()).toEqual(['iniciado', 'pago'].sort());

    // ── the actual #702 assertion ──
    // "no new frete row" is a negative, and a sleep-then-count would pass
    // vacuously whenever the trigger simply hadn't run yet. The `pago` row above
    // is the proof it DID run for THAT write, so the claim is scoped to the
    // reconcile's own CloudEvent id — and re-checked across a short window,
    // because the trigger issues both trails' writes concurrently and a single
    // read could land between them. See `expectNoRowForEvent`.
    const reconcileEventId = trail.find((r) => r.estado === 'pago')!.eventId as string;
    expect(reconcileEventId).not.toBe(seedEventId);
    await expectNoRowForEvent(() => freteHistoricos(db, pedidoId), reconcileEventId);

    const freteTrail = await freteHistoricos(db, pedidoId);
    expect(freteTrail).toHaveLength(1);
    expect(freteTrail[0]!.estado).toBe(ESTADO_FRETE.empacotado);
    expect(freteTrail[0]!.eventId).toBe(seedEventId);
    // Longer than its siblings: this one waits on TWO successive trigger
    // deliveries (the seed's create, then the reconcile's update) rather than
    // two rows from the same event.
  }, 90_000);

  it('two concurrent reconciles settle on one consistent estado (#308)', async () => {
    const db = getDb();
    const pedidoId = await seedPedido(
      db,
      {
        estado: 'iniciado',
        valorCobrado: 100,
        freteInicial: { estado: ESTADO_FRETE.iniciado, codRastreio: null },
      },
      [{ valor: 100, status_pagamento: STATUS_PAGAMENTO.aprovado }],
    );

    // THE #308 regression. The client path sums the pagamentos with a `getDocs`
    // BEFORE `runTransaction` (the JS SDK can't query inside one), so two
    // callers can both read the pre-transition estado and both write. Here both
    // transactions read the pedido doc inside the tx, so they serialize on it:
    // the winner writes `pago`, the loser re-reads the already-settled `pago`,
    // `nextPedidoEstado` returns null for an already-`pago` fully-paid pedido,
    // and `applyEstadoTransition` returns before its `tx.update` — it commits
    // nothing at all.
    const resultados = await Promise.all([
      reconcilePedidoEstado(db, { pedidoId }),
      reconcilePedidoEstado(db, { pedidoId }),
    ]);

    // THIS is the #308 guard. Exactly one transitioned; the other was a clean
    // no-op. It fails with ['pago', 'pago'] the moment the race returns, because
    // `applyEstadoTransition` returns its estado on the SAME code path that runs
    // the `tx.update` — a committing loser cannot report null.
    expect(resultados.map((r) => r.transition).filter((t) => t !== null)).toEqual(['pago']);
    expect((await pedidoRef(db, pedidoId).get()).data()!.estado).toBe('pago');

    // The trail corroborates the settled state: the opening `iniciado` row plus
    // ONE transition.
    //
    // ⚠️ It does NOT witness the race, and must not be read as if it did. The
    // trigger records estado CHANGES, not writes — `buildEstadoHistoryEntry`
    // returns null when `before.estado === after.estado` — so a losing reconcile
    // that DID commit a redundant `pago` write would produce no second row
    // either way, and this count would look identical. Before #697 the reconcile
    // appended the row inside its own transaction at a random doc id, so two
    // commits genuinely meant two rows; that discriminating power is gone. The
    // assertion above is what carries #308.
    const trail = await waitForTrail(db, pedidoId, 2);
    expect(trail.map((r) => r.estado as string).sort()).toEqual(['iniciado', 'pago'].sort());

    // The frete trail corroborates the same settled state — the winner's write
    // authorized despatch, so there is exactly one `despachoAutorizado` row on
    // top of the seed's opening `iniciado`. The caveat above transfers verbatim:
    // `buildFreteHistoryEntry` also returns null on an unchanged estado, so this
    // cannot witness the race either. It is here to catch the frete arm emitting
    // a DUPLICATE row for one transition, not to prove the loser wrote nothing.
    const freteTrail = await waitForFreteRow(db, pedidoId, ESTADO_FRETE.despachoAutorizado);
    expect(freteTrail.map((r) => r.estado as string).sort()).toEqual(
      [ESTADO_FRETE.despachoAutorizado, ESTADO_FRETE.iniciado].sort(),
    );
  }, 60_000);

  it('throws PedidoReconcileNotFoundError against a real missing pedido', async () => {
    const db = getDb();
    const pedidoId = `ped${randomUUID().replace(/-/g, '')}`; // never seeded

    await expect(reconcilePedidoEstado(db, { pedidoId })).rejects.toBeInstanceOf(
      PedidoReconcileNotFoundError,
    );

    // The transaction aborted before any write: no phantom pedido, and neither
    // trail was opened — there was no pedido write for the trigger to observe.
    expect((await pedidoRef(db, pedidoId).get()).exists).toBe(false);
    expect(await historicos(db, pedidoId)).toHaveLength(0);
    expect(await freteHistoricos(db, pedidoId)).toHaveLength(0);
  });
});
