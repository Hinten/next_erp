/**
 * Real Firestore transaction coverage for the claim incidente watermark (#1772).
 *
 * `claimIncidenteTx.test.ts` proves every decision on a plain object. This
 * keeps the two things a fake cannot prove over the emulator: that two REAL
 * transactions racing one incidente serialise on it — the loser re-reads the
 * winner's watermark instead of re-applying its closure — and that the losing
 * side of a `tx.create` race is retried as a re-decision rather than escaping
 * as `ALREADY_EXISTS` and failing the delivery.
 */
import { randomUUID } from 'node:crypto';
import { incidenteCollection } from '@delfrance/data/admin/collections';
import type { MlClaim } from '@delfrance/integrations-mercado-livre';
import { describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { salvarIncidenteClaim } from './claimIncidenteTx';
import { mapearIncidenteClaim } from './claimMapping';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const NOW_US = Date.parse('2026-08-01T00:00:00.000Z') * 1000;
const ANTIGO = '2022-08-24T16:10:26.000-04:00';
const NOVO = '2022-08-24T16:11:00.000-04:00';

/** The same claim as ML saw it at `lastUpdated` — open at first, closed later. */
function claim(status: 'opened' | 'closed', lastUpdated: string): MlClaim {
  return {
    id: 5142940410,
    type: 'mediations',
    stage: status === 'opened' ? 'claim' : 'none',
    status,
    resource_id: 2000004048276990,
    resource: 'order',
    reason_id: null,
    fulfilled: false,
    players: [],
    resolution: null,
    date_created: '2022-08-23T20:09:16.000-04:00',
    last_updated: lastUpdated,
  } as unknown as MlClaim;
}

const aberto = () => mapearIncidenteClaim(claim('opened', ANTIGO), undefined, NOW_US);
const fechado = () => mapearIncidenteClaim(claim('closed', NOVO), undefined, NOW_US);

describe.skipIf(!EMULATED)('salvarIncidenteClaim (Firestore emulator)', () => {
  async function ler(pedidoId: string, incidenteId: string) {
    const db = getAdminFirestore();
    return incidenteCollection.docRef(db, { pedidoId }, incidenteId).get();
  }

  it('two concurrent FIRST deliveries converge on the newer one, whichever commits first', async () => {
    const db = getAdminFirestore();
    // Several rounds, so both commit orders are actually exercised.
    for (let rodada = 0; rodada < 6; rodada++) {
      const pedidoId = `ped-1772-${randomUUID()}`;
      const incidenteId = 'inc';
      const entregas = rodada % 2 === 0 ? [aberto(), fechado()] : [fechado(), aberto()];

      const resultados = await Promise.all(
        entregas.map((mapeado) => salvarIncidenteClaim(db, { pedidoId, incidenteId, mapeado })),
      );

      const snap = await ler(pedidoId, incidenteId);
      expect(snap.data()).toMatchObject({
        claimStatus: 'closed',
        claimStage: 'none',
        relogioProvedorUs: Date.parse(NOVO) * 1000,
      });
      // Exactly one create; the other delivery re-decided against it.
      const acoes = resultados.map((r) => r.acao).sort();
      expect(acoes.filter((a) => a === 'criado')).toHaveLength(1);
      expect(['atualizado', 'ignorado-obsoleto']).toContain(acoes.find((a) => a !== 'criado'));
    }
  });

  it('two concurrent deliveries on a LEGACY row (no watermark) converge on the newer one', async () => {
    const db = getAdminFirestore();
    for (let rodada = 0; rodada < 6; rodada++) {
      const pedidoId = `ped-1772-${randomUUID()}`;
      const incidenteId = 'inc';
      const ref = incidenteCollection.docRef(db, { pedidoId }, incidenteId);
      // What the Flutter app left behind: an incidente with no `relogioProvedorUs`.
      await ref.set({ origem: 2, tipo: 'mediations', claimStatus: 'opened', timestamp: 1 });
      const entregas = rodada % 2 === 0 ? [aberto(), fechado()] : [fechado(), aberto()];

      await Promise.all(
        entregas.map((mapeado) => salvarIncidenteClaim(db, { pedidoId, incidenteId, mapeado })),
      );

      expect((await ler(pedidoId, incidenteId)).data()).toMatchObject({
        claimStatus: 'closed',
        relogioProvedorUs: Date.parse(NOVO) * 1000,
        timestamp: 1, // operator turf never rewritten after the create
      });
    }
  });

  it('a stale snapshot landing AFTER the newer one writes nothing — not even a no-op', async () => {
    const db = getAdminFirestore();
    const pedidoId = `ped-1772-${randomUUID()}`;
    const incidenteId = 'inc';
    await salvarIncidenteClaim(db, { pedidoId, incidenteId, mapeado: fechado() });
    const antes = await ler(pedidoId, incidenteId);

    const previsao = await salvarIncidenteClaim(db, { pedidoId, incidenteId, mapeado: aberto() });

    expect(previsao.acao).toBe('ignorado-obsoleto');
    const depois = await ler(pedidoId, incidenteId);
    expect(depois.data()?.claimStatus).toBe('closed');
    // The document's own server clock did not move: zero writes, not a rewrite.
    expect(depois.updateTime?.isEqual(antes.updateTime!)).toBe(true);
  });
});
