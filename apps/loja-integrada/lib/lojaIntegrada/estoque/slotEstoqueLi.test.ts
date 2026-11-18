/**
 * The ONE global stagger slot (master plan step 12, PR 12-f): the pure reservation — floor,
 * horizon, retry, advance-only — and its tier-1 writer against the fake Firestore, which models
 * `create` (6 on an existing doc), `update(patch, { lastUpdateTime })` (9 on a stale stamp) and a
 * landed write whose reply was lost. No transaction, no Loja Integrada call (the global `fetch`
 * throws in every test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileEstoqueLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import { ID_RECONCILE_ESTOQUE_LI } from '@delfrance/schemas';

import { RITMO_ESCRITA_LI_MS } from '../core/ritmo';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { DISPERSAO_ESTOQUE_LI_MS, agendamentoEstoqueLi, janelaEstoqueLi } from './agendadorEstoque';
import {
  HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS,
  INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS,
  LiSlotEstoqueEmConflitoError,
  MAX_TENTATIVAS_SLOT_ESTOQUE_LI,
  pisoDoSlotEstoqueLi,
  reservarSlotGlobalEstoqueLi,
  reservarSlotsLi,
} from './slotEstoqueLi';

const SLOT = 'reconcileEstoqueLojaIntegrada/atual';
const I = INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS;
const PISO = pisoDoSlotEstoqueLi(AGORA_MS);

/** Another writer's handle on the slot document (no precondition). */
const slotRef = (db: FakeDb) =>
  reconcileEstoqueLojaIntegradaCollection.docRef(asDb(db), {}, ID_RECONCILE_ESTOQUE_LI);

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('slotEstoqueLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the interval: a bulk run’s floor plus an event run’s, from the pacer', () => {
  it('= 2 pacer intervals (a bulk run: before its deciding read; no read-back) + 4 (an event run: before its deciding read and before its read-back) — a pacer change moves it', () => {
    const pisoDoLote = 2 * RITMO_ESCRITA_LI_MS;
    const pisoDoEvento = 4 * RITMO_ESCRITA_LI_MS;
    expect(I).toBe(pisoDoLote + pisoDoEvento);
    // ÂNCORA: the values stated in the module header.
    expect(I).toBe(12_000);
    // What it means for the largest fan-out the plan sizes (about 2 000 kits): ≈ 6.7 h.
    expect((2_000 * I) / 3_600_000).toBeCloseTo(6.67, 1);
  });

  it('the horizon is 4 h, inside the nightly reconcile’s 24 h', () => {
    expect(HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS).toBe(4 * 3_600_000);
    expect(HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS).toBeLessThan(24 * 3_600_000);
  });
});

describe('the floor', () => {
  it('= (⌊now / 60 s⌋ + 3) · 60 s + 30 s', () => {
    expect(PISO).toBe((janelaEstoqueLi(AGORA_MS) + 3) * 60_000 + DISPERSAO_ESTOQUE_LI_MS);
  });

  it('beats the window schedule of ANY task of the current window, whatever its spread — so a reserved instant is always the schedule', () => {
    for (const agora of [AGORA_MS, AGORA_MS + 59_999, AGORA_MS - (AGORA_MS % 60_000)]) {
      const janela = janelaEstoqueLi(agora);
      for (const produto of ['k-1', 'k-2', 'k-3', 'kit-zz', 'p ó~0']) {
        expect(pisoDoSlotEstoqueLi(agora)).toBeGreaterThan(agendamentoEstoqueLi(janela, produto));
      }
    }
  });
});

describe('reservarSlotsLi (pure)', () => {
  it('no stored slot ⇒ from the floor, one interval apart; the slot ends one interval past the last', () => {
    const r = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: null,
      quantidade: 3,
      doPiso: false,
    });
    expect(r.inicios).toEqual([PISO, PISO + I, PISO + 2 * I]);
    expect(r.proximoMs).toBe(PISO + 3 * I);
    expect(r.saturado).toBe(false);
    expect(r.armazenadoMs).toBeNull();
  });

  it('a stored slot 10 min AHEAD (within the horizon) ⇒ the run starts AT it: advance-only', () => {
    const armazenado = AGORA_MS + 10 * 60_000;
    const r = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: armazenado,
      quantidade: 2,
      doPiso: false,
    });
    expect(r.inicios).toEqual([armazenado, armazenado + I]);
    expect(r.proximoMs).toBe(armazenado + 2 * I);
    expect(r.saturado).toBe(false);
  });

  it('a stored slot in the PAST ⇒ from the floor (never schedules behind now)', () => {
    const r = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: AGORA_MS - 3_600_000,
      quantidade: 1,
      doPiso: false,
    });
    expect(r.inicios).toEqual([PISO]);
    expect(r.proximoMs).toBe(PISO + I);
  });

  it('BEYOND the horizon ⇒ saturated: from the floor, and the slot never moves back', () => {
    const armazenado = AGORA_MS + HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS + 1;
    const r = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: armazenado,
      quantidade: 5,
      doPiso: false,
    });
    expect(r.saturado).toBe(true);
    expect(r.inicios[0]).toBe(PISO);
    expect(r.proximoMs).toBe(armazenado);
    expect(r.proximoMs).toBeGreaterThanOrEqual(armazenado);
  });

  it('⚠️ NEAR-MISS: exactly AT the horizon is not saturated — the run queues behind it', () => {
    const armazenado = AGORA_MS + HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS;
    const r = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: armazenado,
      quantidade: 1,
      doPiso: false,
    });
    expect(r.saturado).toBe(false);
    expect(r.inicios).toEqual([armazenado]);
  });

  it('a value past Cloud Tasks’ 30-day schedule limit is saturated too, never queued behind', () => {
    const armazenado = AGORA_MS + 31 * 24 * 3_600_000;
    const r = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: armazenado,
      quantidade: 1,
      doPiso: false,
    });
    expect(r.saturado).toBe(true);
    expect(r.inicios).toEqual([PISO]);
  });

  it('a RETRIED attempt (doPiso) ⇒ from the floor even within the horizon; the slot is max(stored, floor + n·I)', () => {
    const armazenado = AGORA_MS + 30 * 60_000;
    const r = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: armazenado,
      quantidade: 2,
      doPiso: true,
    });
    expect(r.inicios).toEqual([PISO, PISO + I]);
    expect(r.proximoMs).toBe(armazenado);
    const curto = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: PISO + I,
      quantidade: 3,
      doPiso: true,
    });
    expect(curto.proximoMs).toBe(PISO + 3 * I);
  });

  it('the slot NEVER decreases, over a grid of stored values, quantities and both modes', () => {
    for (const armazenado of [
      null,
      0,
      AGORA_MS - 1,
      PISO,
      PISO + 7,
      AGORA_MS + 9e6,
      AGORA_MS + 9e10,
    ]) {
      for (const quantidade of [1, 2, 30, 2_000]) {
        for (const doPiso of [false, true]) {
          const r = reservarSlotsLi({
            agoraMs: AGORA_MS,
            armazenadoMs: armazenado,
            quantidade,
            doPiso,
          });
          if (armazenado !== null) expect(r.proximoMs).toBeGreaterThanOrEqual(armazenado);
          expect(r.inicios).toHaveLength(quantidade);
          expect(r.inicios[0]).toBeGreaterThanOrEqual(PISO);
          expect(r.proximoMs).toBeGreaterThan(r.inicios[quantidade - 1] ?? Infinity);
        }
      }
    }
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 60, '5'])(
    'a stored value that is not a non-negative safe integer (%s) reads as none: fail open',
    (armazenado) => {
      const r = reservarSlotsLi({
        agoraMs: AGORA_MS,
        armazenadoMs: armazenado as number,
        quantidade: 1,
        doPiso: false,
      });
      expect(r.armazenadoMs).toBeNull();
      expect(r.inicios).toEqual([PISO]);
    },
  );

  it.each([0, -1, 1.5])(
    'refuses a quantity of %s (RangeError): nothing to reserve',
    (quantidade) => {
      expect(() =>
        reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: null, quantidade, doPiso: false }),
      ).toThrow(RangeError);
    },
  );
});

describe('reservarSlotGlobalEstoqueLi: the tier-1 writer of proximoSlotMs alone', () => {
  it('absent ⇒ create({ proximoSlotMs }) and NOTHING else; the clock is read after the read', async () => {
    const db = new FakeDb();
    const eventos: string[] = [];
    const agora = () => {
      eventos.push(`relogio:${String(db.leituras.length)}`);
      return AGORA_MS;
    };

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 2,
      agoraMs: agora,
      doPiso: false,
    });

    expect(eventos).toEqual(['relogio:1']);
    expect(db.leituras).toEqual([SLOT]);
    expect(db.escritas.map((e) => [e.verbo, e.caminho, e.dados])).toEqual([
      ['create', SLOT, { proximoSlotMs: PISO + 2 * I }],
    ]);
    expect(r).toMatchObject({ inicios: [PISO, PISO + I], proximoMs: PISO + 2 * I, escrito: true });
  });

  it('present ⇒ update({ proximoSlotMs }) alone (the race below proves its lastUpdateTime); the reconcile’s fields stay', async () => {
    const db = new FakeDb();
    const armazenado = AGORA_MS + 5 * 60_000;
    db.seed(SLOT, {
      execucaoId: 'estoque-reconcile-20270115',
      seq: 4,
      contas: ['conta-li-a'],
      proximoSlotMs: armazenado,
    });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 3,
      agoraMs: () => AGORA_MS,
      doPiso: false,
    });

    expect(r.inicios).toEqual([armazenado, armazenado + I, armazenado + 2 * I]);
    expect(db.escritas.map((e) => [e.verbo, e.dados])).toEqual([
      ['update', { proximoSlotMs: armazenado + 3 * I }],
    ]);
    expect(db.ler(SLOT)).toMatchObject({ execucaoId: 'estoque-reconcile-20270115', seq: 4 });
  });
  it('a stored slot that already covers a saturated run ⇒ NO write (nothing to advance)', async () => {
    const db = new FakeDb();
    const armazenado = AGORA_MS + HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS + 60_000;
    db.seed(SLOT, { proximoSlotMs: armazenado });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 2,
      agoraMs: () => AGORA_MS,
      doPiso: false,
    });

    expect(r).toMatchObject({ saturado: true, escrito: false, proximoMs: armazenado });
    expect(r.inicios).toEqual([PISO, PISO + I]);
    expect(db.escritas).toEqual([]);
  });

  it('RACE: a NEWER slot lands between our read and our update ⇒ 9 ⇒ re-read ⇒ our run starts after IT', async () => {
    const db = new FakeDb();
    db.seed(SLOT, { proximoSlotMs: AGORA_MS + 60_000 });
    const outro = AGORA_MS + 20 * 60_000;
    db.antesDaProximaEscrita(SLOT, async () => {
      await slotRef(db).update({ proximoSlotMs: outro });
    });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 2,
      agoraMs: () => AGORA_MS,
      doPiso: false,
    });

    expect(r.inicios).toEqual([outro, outro + I]);
    expect(db.ler(SLOT)).toMatchObject({ proximoSlotMs: outro + 2 * I });
    expect(db.leituras).toEqual([SLOT, SLOT]);
  });

  it('RACE: a doc CREATED between our absent read and our create ⇒ 6 ⇒ re-read ⇒ the update path', async () => {
    const db = new FakeDb();
    const outro = AGORA_MS + 15 * 60_000;
    db.antesDaProximaEscrita(SLOT, () => {
      db.seed(SLOT, { proximoSlotMs: outro });
    });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 1,
      agoraMs: () => AGORA_MS,
      doPiso: false,
    });

    expect(r.inicios).toEqual([outro]);
    expect(db.escritas.map((e) => e.verbo)).toEqual(['update']);
    expect(db.ler(SLOT)).toEqual({ proximoSlotMs: outro + I });
  });

  it('a LOST REPLY (the update landed, the SDK’s retry met its own stamp: 9) ⇒ counted as written — never a second advance', async () => {
    const db = new FakeDb();
    const armazenado = AGORA_MS + 60_000;
    db.seed(SLOT, { proximoSlotMs: armazenado });
    db.respostaPerdidaNaProximaEscrita(SLOT);

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 4,
      agoraMs: () => AGORA_MS,
      doPiso: false,
    });

    expect(r).toMatchObject({ escrito: true, proximoMs: Math.max(PISO, armazenado) + 4 * I });
    expect(db.escritas).toHaveLength(1);
    expect(db.ler(SLOT)).toEqual({ proximoSlotMs: Math.max(PISO, armazenado) + 4 * I });
  });

  it('a create whose reply was lost (the SDK retried it: 6, our own value stored) ⇒ written once', async () => {
    const db = new FakeDb();
    db.antesDaProximaEscrita(SLOT, () => {
      db.seed(SLOT, { proximoSlotMs: PISO + I });
    });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 1,
      agoraMs: () => AGORA_MS,
      doPiso: false,
    });

    expect(r).toMatchObject({ inicios: [PISO], proximoMs: PISO + I });
    expect(db.escritas).toEqual([]);
    expect(db.ler(SLOT)).toEqual({ proximoSlotMs: PISO + I });
  });

  it(`${String(MAX_TENTATIVAS_SLOT_ESTOQUE_LI)} losses in a row ⇒ LiSlotEstoqueEmConflitoError (the task retries) — after one last read`, async () => {
    const db = new FakeDb();
    db.seed(SLOT, { proximoSlotMs: AGORA_MS });
    // One hook at a time, the next queued only after the hook's own write: a hook queued ahead
    // would intercept the running hook's write instead of ours.
    const outroEscritor = (k: number): void => {
      db.antesDaProximaEscrita(SLOT, async () => {
        await slotRef(db).update({ proximoSlotMs: AGORA_MS + k * 3_600_000 });
        if (k < MAX_TENTATIVAS_SLOT_ESTOQUE_LI) outroEscritor(k + 1);
      });
    };
    outroEscritor(1);
    await expect(
      reservarSlotGlobalEstoqueLi(asDb(db), {
        quantidade: 1,
        agoraMs: () => AGORA_MS,
        doPiso: false,
      }),
    ).rejects.toBeInstanceOf(LiSlotEstoqueEmConflitoError);
    expect(db.leituras).toHaveLength(MAX_TENTATIVAS_SLOT_ESTOQUE_LI + 1);
  });

  it('any other failure is rethrown AS THROWN', async () => {
    const db = new FakeDb();
    const falha = grpc(14, 'UNAVAILABLE');
    db.falharEscrita(SLOT, falha);

    await expect(
      reservarSlotGlobalEstoqueLi(asDb(db), {
        quantidade: 1,
        agoraMs: () => AGORA_MS,
        doPiso: false,
      }),
    ).rejects.toBe(falha);
  });
});
