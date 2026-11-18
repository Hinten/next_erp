/**
 * The ONE global stagger slot (master plan step 12, PR 12-f): the pure reservation — floor, never
 * double-booked, the horizon signal, the schedule limit, advance-only — and its tier-1 writer
 * against the fake Firestore, which models `create` (6 on an existing doc), `update(patch,
 * { lastUpdateTime })` (9 on a stale stamp) and a landed write whose reply was lost. No
 * transaction, no Loja Integrada call (the global `fetch` throws in every test).
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
  LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS,
  LiSlotEstoqueEmConflitoError,
  MAX_TENTATIVAS_SLOT_ESTOQUE_LI,
  ORCAMENTO_POR_CHAMADA_SLOT_ESTOQUE_LI_MS,
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

describe('the interval: a bulk run plus an event run, from the pacer and a per-call budget', () => {
  it('= 2 pacer intervals and 2 calls (a bulk run: GET + PUT, no read-back) + 4 intervals and 3 calls (an event run: GET + PUT + read-back) — a pacer change moves it', () => {
    const loteMs = 2 * RITMO_ESCRITA_LI_MS + 2 * ORCAMENTO_POR_CHAMADA_SLOT_ESTOQUE_LI_MS;
    const eventoMs = 4 * RITMO_ESCRITA_LI_MS + 3 * ORCAMENTO_POR_CHAMADA_SLOT_ESTOQUE_LI_MS;
    expect(I).toBe(loteMs + eventoMs);
    // ÂNCORA: the step plan's own run estimates (6 s for a two-call run, 11 s for a three-call
    // one, margin included), and the value stated in the module header.
    expect([loteMs, eventoMs]).toEqual([6_000, 11_000]);
    expect(I).toBe(17_000);
    // ⚠️ NEAR-MISS: the six pacer sleeps ALONE (12 s) leave no time for the five calls.
    expect(I).toBeGreaterThan(6 * RITMO_ESCRITA_LI_MS);
    // What it means for the largest fan-out the plan sizes (about 2 000 kits): ≈ 9.4 h.
    expect((2_000 * I) / 3_600_000).toBeCloseTo(9.44, 1);
  });

  it('the horizon is 12 h: more than one planned 2 000-kit fan-out, so that fan-out alone never raises the ERROR', () => {
    expect(HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS).toBe(12 * 3_600_000);
    expect(HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS).toBeGreaterThan(2_000 * I);
  });

  it('the schedule limit is 29 days: one day inside Cloud Tasks’ 30-day limit on a schedule', () => {
    expect(LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS).toBe(29 * 24 * 3_600_000);
    expect(LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS).toBeLessThan(30 * 24 * 3_600_000);
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

/** Every instant of several reservations, sorted: the gaps between neighbours. */
function intervalosEntre(reservas: readonly { readonly inicios: readonly number[] }[]): number[] {
  const todos = reservas.flatMap((r) => r.inicios).sort((a, b) => a - b);
  return todos.slice(1).map((t, i) => t - (todos[i] ?? t));
}

describe('reservarSlotsLi (pure)', () => {
  it('no stored slot ⇒ from the floor, one interval apart; the slot ends one interval past the last', () => {
    const r = reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: null, quantidade: 3 });
    expect(r.inicios).toEqual([PISO, PISO + I, PISO + 2 * I]);
    expect(r.proximoMs).toBe(PISO + 3 * I);
    expect(r).toMatchObject({ saturado: false, excedeLimite: false, armazenadoMs: null });
  });

  it('a stored slot 10 min AHEAD ⇒ the run starts AT it: advance-only', () => {
    const armazenado = AGORA_MS + 10 * 60_000;
    const r = reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: armazenado, quantidade: 2 });
    expect(r.inicios).toEqual([armazenado, armazenado + I]);
    expect(r.proximoMs).toBe(armazenado + 2 * I);
    expect(r.saturado).toBe(false);
  });

  it('a stored slot in the PAST ⇒ from the floor (never schedules behind now)', () => {
    const r = reservarSlotsLi({
      agoraMs: AGORA_MS,
      armazenadoMs: AGORA_MS - 3_600_000,
      quantidade: 1,
    });
    expect(r.inicios).toEqual([PISO]);
    expect(r.proximoMs).toBe(PISO + I);
  });

  it('BEYOND the horizon ⇒ saturated (the caller’s ERROR) — and STILL behind the stored slot: never double-booked', () => {
    const armazenado = AGORA_MS + HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS + 1;
    const r = reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: armazenado, quantidade: 5 });
    expect(r.saturado).toBe(true);
    expect(r.excedeLimite).toBe(false);
    expect(r.inicios[0]).toBe(armazenado);
    expect(r.proximoMs).toBe(armazenado + 5 * I);
  });

  it('⚠️ NEAR-MISS: exactly AT the horizon is not saturated — the run queues behind it alike', () => {
    const armazenado = AGORA_MS + HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS;
    const r = reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: armazenado, quantidade: 1 });
    expect(r.saturado).toBe(false);
    expect(r.inicios).toEqual([armazenado]);
  });

  it('two consecutive 2 000-kit fan-outs 10 min apart: no two sends ever within one interval (the second queues behind the first, past the horizon)', () => {
    const primeira = reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: null, quantidade: 2_000 });
    const segunda = reservarSlotsLi({
      agoraMs: AGORA_MS + 10 * 60_000,
      armazenadoMs: primeira.proximoMs,
      quantidade: 2_000,
    });
    expect(segunda.inicios[0]).toBe(primeira.proximoMs);
    expect(Math.min(...intervalosEntre([primeira, segunda]))).toBe(I);
    // The ERROR's threshold is not reached by the first one alone.
    expect(segunda.saturado).toBe(false);
    const terceira = reservarSlotsLi({
      agoraMs: AGORA_MS + 20 * 60_000,
      armazenadoMs: segunda.proximoMs,
      quantidade: 2_000,
    });
    expect(terceira.saturado).toBe(true);
    expect(Math.min(...intervalosEntre([primeira, segunda, terceira]))).toBe(I);
  });

  it('five 1 500-kit fan-outs, one a minute (five sales of one component): still one send per interval, and the slot grows by each', () => {
    let armazenado: number | null = null;
    const reservas: ReturnType<typeof reservarSlotsLi>[] = [];
    for (let k = 0; k < 5; k++) {
      const r = reservarSlotsLi({
        agoraMs: AGORA_MS + k * 60_000,
        armazenadoMs: armazenado,
        quantidade: 1_500,
      });
      reservas.push(r);
      armazenado = r.proximoMs;
    }
    expect(Math.min(...intervalosEntre(reservas))).toBe(I);
    expect(armazenado).toBe(PISO + 5 * 1_500 * I);
  });

  it('a reservation whose LAST instant would pass the schedule limit ⇒ excedeLimite (nothing may be reserved); ⚠️ NEAR-MISS: one that ends at the limit is fine', () => {
    const quantidade = 3;
    const noLimite = AGORA_MS + LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS - quantidade * I;
    expect(
      reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: noLimite, quantidade }).excedeLimite,
    ).toBe(false);
    const alem = reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: noLimite + 1, quantidade });
    expect(alem.excedeLimite).toBe(true);
    // A value past Cloud Tasks' own 30-day limit lands here too.
    expect(
      reservarSlotsLi({
        agoraMs: AGORA_MS,
        armazenadoMs: AGORA_MS + 31 * 24 * 3_600_000,
        quantidade: 1,
      }).excedeLimite,
    ).toBe(true);
  });

  it('the slot NEVER decreases and no instant falls below the stored slot, over a grid of stored values and quantities', () => {
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
        const r = reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: armazenado, quantidade });
        if (armazenado !== null) {
          expect(r.proximoMs).toBeGreaterThan(armazenado);
          expect(r.inicios[0]).toBeGreaterThanOrEqual(armazenado);
        }
        expect(r.inicios).toHaveLength(quantidade);
        expect(r.inicios[0]).toBeGreaterThanOrEqual(PISO);
        expect(r.proximoMs).toBe((r.inicios[quantidade - 1] ?? Infinity) + I);
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
      });
      expect(r.armazenadoMs).toBeNull();
      expect(r.inicios).toEqual([PISO]);
    },
  );

  it.each([0, -1, 1.5])(
    'refuses a quantity of %s (RangeError): nothing to reserve',
    (quantidade) => {
      expect(() => reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: null, quantidade })).toThrow(
        RangeError,
      );
    },
  );

  describe('the horizon cut (PR 12-g: the reconcile’s under-advertising rows)', () => {
    it('keeps only the instants at or before now + the cut; ⚠️ NEAR-MISS: one at now + cut + 1 ms is left out', () => {
      // The third instant lands EXACTLY at now + cut.
      const ate = PISO + 2 * I - AGORA_MS;
      const exato = reservarSlotsLi({
        agoraMs: AGORA_MS,
        armazenadoMs: null,
        quantidade: 5,
        ateHorizonteMs: ate,
      });
      expect(exato.inicios).toEqual([PISO, PISO + I, PISO + 2 * I]);
      expect(exato.proximoMs).toBe(PISO + 3 * I);
      const umMsAntes = reservarSlotsLi({
        agoraMs: AGORA_MS,
        armazenadoMs: null,
        quantidade: 5,
        ateHorizonteMs: ate - 1,
      });
      expect(umMsAntes.inicios).toEqual([PISO, PISO + I]);
    });

    it('a stored slot already past the cut ⇒ NOTHING reserved (empty, and the slot unmoved by the caller)', () => {
      const armazenado = AGORA_MS + 13 * 60 * 60_000;
      const r = reservarSlotsLi({
        agoraMs: AGORA_MS,
        armazenadoMs: armazenado,
        quantidade: 3,
        ateHorizonteMs: HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS,
      });
      expect(r.inicios).toEqual([]);
    });

    it('a cut that admits more than asked reserves exactly what was asked; no cut is the fan-out’s, unchanged', () => {
      const comCorte = reservarSlotsLi({
        agoraMs: AGORA_MS,
        armazenadoMs: null,
        quantidade: 2,
        ateHorizonteMs: HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS,
      });
      const semCorte = reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: null, quantidade: 2 });
      expect(comCorte).toEqual(semCorte);
    });

    it.each([-1, 1.5, Number.NaN])('refuses a cut of %s (RangeError)', (ateHorizonteMs) => {
      expect(() =>
        reservarSlotsLi({ agoraMs: AGORA_MS, armazenadoMs: null, quantidade: 1, ateHorizonteMs }),
      ).toThrow(RangeError);
    });
  });
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
    });

    expect(r.inicios).toEqual([armazenado, armazenado + I, armazenado + 2 * I]);
    expect(db.escritas.map((e) => [e.verbo, e.dados])).toEqual([
      ['update', { proximoSlotMs: armazenado + 3 * I }],
    ]);
    expect(db.ler(SLOT)).toMatchObject({ execucaoId: 'estoque-reconcile-20270115', seq: 4 });
  });
  it('a SATURATED slot is still written: the run queues behind it and advances it', async () => {
    const db = new FakeDb();
    const armazenado = AGORA_MS + HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS + 60_000;
    db.seed(SLOT, { proximoSlotMs: armazenado });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 2,
      agoraMs: () => AGORA_MS,
    });

    expect(r).toMatchObject({ saturado: true, escrito: true, proximoMs: armazenado + 2 * I });
    expect(r.inicios).toEqual([armazenado, armazenado + I]);
    expect(db.ler(SLOT)).toEqual({ proximoSlotMs: armazenado + 2 * I });
  });

  it('the read is MASKED to proximoSlotMs (PR 12-g: the run document may hold 600 KB of candidates) and still writes under its stamp', async () => {
    const db = new FakeDb();
    const armazenado = AGORA_MS + 5 * 60_000;
    db.seed(SLOT, {
      proximoSlotMs: armazenado,
      candidatos: [{ c: 0, i: '5', p: 'p1', d: 3 }],
    });
    const getAll = vi.spyOn(db, 'getAll');

    await reservarSlotGlobalEstoqueLi(asDb(db), { quantidade: 1, agoraMs: () => AGORA_MS });

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0]?.[1]).toEqual({ fieldMask: ['proximoSlotMs'] });
    expect(db.ler(SLOT)).toMatchObject({ proximoSlotMs: armazenado + I });
  });

  it('a horizon cut that leaves NO instant ⇒ NO write (escrito false, inicios empty)', async () => {
    const db = new FakeDb();
    const armazenado = AGORA_MS + HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS + 1;
    db.seed(SLOT, { proximoSlotMs: armazenado });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 4,
      agoraMs: () => AGORA_MS,
      ateHorizonteMs: HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS,
    });

    expect(r).toMatchObject({ escrito: false, excedeLimite: false, inicios: [] });
    expect(db.escritas).toEqual([]);
  });

  it('a reservation past the schedule LIMIT ⇒ NO write (escrito false, excedeLimite): the slot stays where it was', async () => {
    const db = new FakeDb();
    const armazenado = AGORA_MS + LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS;
    db.seed(SLOT, { proximoSlotMs: armazenado });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 1,
      agoraMs: () => AGORA_MS,
    });

    expect(r).toMatchObject({ excedeLimite: true, escrito: false });
    expect(db.escritas).toEqual([]);
    expect(db.ler(SLOT)).toEqual({ proximoSlotMs: armazenado });
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
    });

    expect(r.inicios).toEqual([outro, outro + I]);
    expect(db.ler(SLOT)).toMatchObject({ proximoSlotMs: outro + 2 * I });
    expect(db.leituras).toEqual([SLOT, SLOT]);
  });

  it('RACE: the re-read takes a FRESH clock — the floor and the reservation’s now are the second read’s, never the first’s', async () => {
    const db = new FakeDb();
    db.seed(SLOT, { proximoSlotMs: AGORA_MS - 60_000 });
    let agora = AGORA_MS;
    const relogios: number[] = [];
    // Another writer lands between our read and our update, and the retry runs 2 min later; its
    // stored value is behind both floors, so the floor alone decides where the run starts.
    db.antesDaProximaEscrita(SLOT, async () => {
      await slotRef(db).update({ proximoSlotMs: AGORA_MS });
      agora = AGORA_MS + 2 * 60_000;
    });

    const r = await reservarSlotGlobalEstoqueLi(asDb(db), {
      quantidade: 1,
      agoraMs: () => {
        relogios.push(agora);
        return agora;
      },
    });

    expect(relogios).toEqual([AGORA_MS, AGORA_MS + 2 * 60_000]);
    expect(r.agoraMs).toBe(AGORA_MS + 2 * 60_000);
    // ⚠️ NEAR-MISS: the first read's floor is two windows earlier.
    expect(pisoDoSlotEstoqueLi(AGORA_MS + 2 * 60_000)).toBe(PISO + 2 * 60_000);
    expect(r.inicios).toEqual([PISO + 2 * 60_000]);
    expect(db.ler(SLOT)).toEqual({ proximoSlotMs: PISO + 2 * 60_000 + I });
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
      }),
    ).rejects.toBe(falha);
  });
});
