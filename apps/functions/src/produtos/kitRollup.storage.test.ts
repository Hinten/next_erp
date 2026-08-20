import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { processarKitRollup } from './kitRollup';
import { lerValoresRollup, type KitRollupPayload, type ValoresRollup } from './kitRollupPayload';
import type { KitRollupScheduler } from './kitRollupTasks';

// Integration test — requires the firestore emulator. Drives the exported job
// core directly, the `processarBalanco` / `onProdutoChanged` idiom: the
// `onTaskDispatched` wrapper only Zod-parses and forwards.
//
// The self-continuation and the nested-kit cascade are asserted through a
// RECORDER scheduler rather than a real dispatch. firebase-tools does boot a
// Cloud Tasks emulator alongside the functions one, but driving the queue would
// make each assertion wait on an async delivery for no extra coverage — the
// payload the worker hands the scheduler is the whole contract.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

const freshId = (prefix = 'p') => `${prefix}${randomUUID().replace(/-/g, '')}`;

/** Records enqueues instead of reaching Cloud Tasks. */
function recorder(): KitRollupScheduler & { enfileirados: KitRollupPayload[] } {
  const enfileirados: KitRollupPayload[] = [];
  return {
    enfileirados,
    async enqueue(payload) {
      enfileirados.push(payload);
    },
  };
}

interface ComponenteInput {
  pesoBrutoKg?: number | null;
  pesoLiquidoKg?: number | null;
  alturaCm?: number | null;
  larguraCm?: number | null;
  profundidadeCm?: number | null;
  paiId?: string | null;
}

async function criarProduto(
  db: Firestore,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db
    .collection('produtos')
    .doc(id)
    .set({
      nome: id,
      ehKit: false,
      paiId: null,
      pesoBrutoKg: null,
      pesoLiquidoKg: null,
      alturaCm: null,
      larguraCm: null,
      profundidadeCm: null,
      componentesKit: null,
      componentesKitKeys: null,
      ...data,
    });
}

async function criarComponente(
  db: Firestore,
  id: string,
  over: ComponenteInput = {},
): Promise<void> {
  await criarProduto(db, id, {
    pesoBrutoKg: 1,
    pesoLiquidoKg: 0.9,
    alturaCm: 2,
    larguraCm: 20,
    profundidadeCm: 30,
    ...over,
  });
}

async function criarKit(
  db: Firestore,
  id: string,
  componentes: Record<string, number>,
  over: Record<string, unknown> = {},
): Promise<void> {
  const componentesKit = Object.fromEntries(
    Object.entries(componentes).map(([cid, q]) => [
      cid,
      { quantidade: q, limitarEstoque: true, timestamp: null },
    ]),
  );
  await criarProduto(db, id, {
    ehKit: true,
    componentesKit,
    componentesKitKeys: Object.keys(componentesKit).sort(),
    ...over,
  });
}

async function lerRollup(db: Firestore, id: string): Promise<ValoresRollup> {
  return lerValoresRollup((await db.collection('produtos').doc(id).get()).data());
}

function payloadDe(rootId: string, valores: ValoresRollup): KitRollupPayload {
  return {
    rootId,
    rootValores: valores,
    seedIds: null,
    seedOffset: 0,
    cursor: null,
    depth: 0,
    visitados: [],
  };
}

describe.skipIf(!EMULATED)('recalcularDimensoesKit core (emulator)', () => {
  it('updates every kit containing the changed component, and leaves others alone', async () => {
    const db = getDb();
    const comp = freshId('c');
    const outro = freshId('c');
    const kitA = freshId('k');
    const kitB = freshId('k');
    const kitAlheio = freshId('k');

    await criarComponente(db, comp, { pesoBrutoKg: 3, pesoLiquidoKg: 2.5 });
    await criarComponente(db, outro, { pesoBrutoKg: 7, pesoLiquidoKg: 6 });
    await criarKit(db, kitA, { [comp]: 2 });
    await criarKit(db, kitB, { [comp]: 1 });
    await criarKit(db, kitAlheio, { [outro]: 1 });
    const antesAlheio = await lerRollup(db, kitAlheio);

    const sched = recorder();
    const resultado = await processarKitRollup(
      { db, scheduler: sched },
      payloadDe(comp, await lerRollup(db, comp)),
    );

    expect(resultado).toBe('concluido');
    expect((await lerRollup(db, kitA)).pesoBrutoKg).toBe(6);
    expect((await lerRollup(db, kitB)).pesoBrutoKg).toBe(3);
    // A kit that does not list this component must not be touched at all.
    expect(await lerRollup(db, kitAlheio)).toEqual(antesAlheio);
    // No nested kits exist, so the probe enqueues nothing.
    expect(sched.enfileirados).toHaveLength(0);
  });

  it('derives the box from the components and stores it on the kit', async () => {
    const db = getDb();
    const comp = freshId('c');
    const kitId = freshId('k');
    await criarComponente(db, comp, { alturaCm: 2, larguraCm: 20, profundidadeCm: 30 });
    await criarKit(db, kitId, { [comp]: 1 });

    await processarKitRollup(
      { db, scheduler: recorder() },
      payloadDe(comp, await lerRollup(db, comp)),
    );

    const rollup = await lerRollup(db, kitId);
    for (const eixo of ['alturaCm', 'larguraCm', 'profundidadeCm'] as const) {
      expect(rollup[eixo], eixo).not.toBeNull();
      expect(rollup[eixo]!, eixo).toBeGreaterThan(0);
    }
  });

  it('leaves the box untouched when no component resolves one', async () => {
    const db = getDb();
    const comp = freshId('c');
    const kitId = freshId('k');
    await criarComponente(db, comp, { alturaCm: null, larguraCm: null, profundidadeCm: null });
    // A kit with a hand-entered box and a dimensionless component: the rollup
    // must NOT overwrite it with the estimator's fabricated 10x10x11 default.
    await criarKit(db, kitId, { [comp]: 1 }, { alturaCm: 4, larguraCm: 4, profundidadeCm: 4 });

    await processarKitRollup(
      { db, scheduler: recorder() },
      payloadDe(comp, await lerRollup(db, comp)),
    );

    const rollup = await lerRollup(db, kitId);
    expect([rollup.alturaCm, rollup.larguraCm, rollup.profundidadeCm]).toEqual([4, 4, 4]);
    // The weight half still computes, via its own per-component fallbacks.
    expect(rollup.pesoBrutoKg).toBe(1);
  });

  it('is idempotent — a rerun writes nothing', async () => {
    const db = getDb();
    const comp = freshId('c');
    const kitId = freshId('k');
    await criarComponente(db, comp, { pesoBrutoKg: 4 });
    await criarKit(db, kitId, { [comp]: 1 });
    const deps = { db, scheduler: recorder() };
    const payload = payloadDe(comp, await lerRollup(db, comp));

    await processarKitRollup(deps, payload);
    const primeiro = await db.collection('produtos').doc(kitId).get();
    await processarKitRollup(deps, payload);
    const segundo = await db.collection('produtos').doc(kitId).get();

    // `updateTime` is the honest assertion: equal means the second run issued no
    // write at all, not merely that it wrote the same values.
    expect(segundo.updateTime!.isEqual(primeiro.updateTime!)).toBe(true);
  });

  it('DROPS a superseded task instead of writing a stale value', async () => {
    const db = getDb();
    const comp = freshId('c');
    const kitId = freshId('k');
    await criarComponente(db, comp, { pesoBrutoKg: 1 });
    await criarKit(db, kitId, { [comp]: 1 });
    const antes = await lerRollup(db, kitId);
    const payloadAntigo = payloadDe(comp, await lerRollup(db, comp));

    // The operator edits the component again before the task runs.
    await db.collection('produtos').doc(comp).update({ pesoBrutoKg: 9 });

    const sched = recorder();
    const resultado = await processarKitRollup({ db, scheduler: sched }, payloadAntigo);

    expect(resultado).toBe('superseded');
    expect(await lerRollup(db, kitId)).toEqual(antes);
    expect(sched.enfileirados).toHaveLength(0);
  });

  it('drops the task when the root produto is gone', async () => {
    const db = getDb();
    const comp = freshId('c');
    expect(
      await processarKitRollup(
        { db, scheduler: recorder() },
        payloadDe(comp, {
          pesoBrutoKg: 1,
          pesoLiquidoKg: null,
          alturaCm: null,
          larguraCm: null,
          profundidadeCm: null,
        }),
      ),
    ).toBe('raizAusente');
  });

  it('reaches kits that list a variation CHILD of the changed parent', async () => {
    const db = getDb();
    const pai = freshId('p');
    const filho = freshId('f');
    const kitId = freshId('k');
    // The child inherits: no own weight, no own box. `componentesKitKeys` lists
    // the CHILD, so an array-contains on the parent id alone finds nothing.
    await criarComponente(db, pai, { pesoBrutoKg: 5, pesoLiquidoKg: 4 });
    await criarComponente(db, filho, {
      pesoBrutoKg: null,
      pesoLiquidoKg: null,
      alturaCm: null,
      larguraCm: null,
      profundidadeCm: null,
      paiId: pai,
    });
    await criarKit(db, kitId, { [filho]: 2 });

    await processarKitRollup(
      { db, scheduler: recorder() },
      payloadDe(pai, await lerRollup(db, pai)),
    );

    expect((await lerRollup(db, kitId)).pesoBrutoKg).toBe(10);
  });

  it('ignores a matched document that is not a kit with components', async () => {
    const db = getDb();
    const comp = freshId('c');
    const impostor = freshId('x');
    // A stale `componentesKitKeys` denorm on a produto that is no longer a kit.
    await criarComponente(db, comp, { pesoBrutoKg: 2 });
    await criarProduto(db, impostor, {
      ehKit: false,
      componentesKit: null,
      componentesKitKeys: [comp],
      pesoBrutoKg: 123,
    });

    const resultado = await processarKitRollup(
      { db, scheduler: recorder() },
      payloadDe(comp, await lerRollup(db, comp)),
    );

    expect(resultado).toBe('concluido');
    expect((await lerRollup(db, impostor)).pesoBrutoKg).toBe(123);
  });

  it('cascades into a nested kit and stops on a cycle', async () => {
    const db = getDb();
    const comp = freshId('c');
    const interno = freshId('k');
    const externo = freshId('k');
    await criarComponente(db, comp, { pesoBrutoKg: 2, pesoLiquidoKg: 1.5 });
    await criarKit(db, interno, { [comp]: 1 });
    // #239 forbids this shape; the migrated corpus and the agent/MCP path can
    // still produce it, so the probe must find it.
    await criarKit(db, externo, { [interno]: 1 });

    const sched = recorder();
    await processarKitRollup({ db, scheduler: sched }, payloadDe(comp, await lerRollup(db, comp)));

    expect(sched.enfileirados).toHaveLength(1);
    const cascata = sched.enfileirados[0]!;
    expect(cascata).toMatchObject({ rootId: comp, depth: 1, seedIds: [interno] });

    // Running the cascade updates the outer kit from the inner one's new weight.
    const sched2 = recorder();
    await processarKitRollup({ db, scheduler: sched2 }, cascata);
    expect((await lerRollup(db, externo)).pesoBrutoKg).toBe(2);
    // `visitados` carries `interno`, so a cycle cannot re-enqueue it forever.
    for (const p of sched2.enfileirados) expect(p.visitados).toContain(interno);
  });
});
