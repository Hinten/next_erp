import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { MlClaim, MlClaimReason } from '@delfrance/integrations-mercado-livre';
import { ORIGEM_INCIDENTE, TIPO_RESOLUCAO } from '@delfrance/schemas';

import { preverIncidenteClaim, salvarIncidenteClaim } from './claimIncidenteTx';
import { mapearIncidenteClaim, relogioDaClaimUs } from './claimMapping';

/* --------------------------------- fixture -------------------------------- */
// The canonical claim sample (models.dart:3762-3825) — same transcription as
// claimMapping.test.ts. `closed` with a resolution: the state a stale `opened`
// snapshot must never overwrite (#1772).

const LAST_UPDATED_ISO = '2022-08-24T16:10:26.000-04:00';
const DATE_CREATED_ISO = '2022-08-23T20:09:16.000-04:00';
const LAST_UPDATED_US = Date.parse(LAST_UPDATED_ISO) * 1000;
const DATE_CREATED_US = Date.parse(DATE_CREATED_ISO) * 1000;
const NOW_US = Date.parse('2026-08-01T00:00:00.000Z') * 1000;
const UM_SEGUNDO_US = 1_000_000;

const CLAIM_SAMPLE = {
  id: 5142940410,
  type: 'returns',
  stage: 'none',
  status: 'closed',
  resource_id: 2000004048276990,
  resource: 'order',
  reason_id: 'PDD9545',
  fulfilled: true,
  players: [],
  resolution: {
    reason: 'item_returned',
    date_created: '2022-08-24T16:10:18.000-04:00',
    decision: null,
    closed_by: 'mediator',
  },
  date_created: DATE_CREATED_ISO,
  last_updated: LAST_UPDATED_ISO,
} as unknown as MlClaim;

const REASON = {
  id: 'PDD9545',
  detail: 'O produto chegou danificado',
  name: 'Produto danificado',
} as unknown as MlClaimReason;

function claim(over: Record<string, unknown> = {}): MlClaim {
  return { ...(CLAIM_SAMPLE as unknown as Record<string, unknown>), ...over } as unknown as MlClaim;
}

function mapear(over: Record<string, unknown> = {}) {
  return mapearIncidenteClaim(claim(over), REASON, NOW_US);
}

/** The document a CREATE of `over` writes — i.e. a stored incidente in step with it. */
function armazenado(over: Record<string, unknown> = {}): Record<string, unknown> {
  const previsao = preverIncidenteClaim(undefined, mapear(over));
  return { ...previsao.patch! };
}

/* ---------------------------------- unit ---------------------------------- */

describe('relogioDaClaimUs — the ONE conversion, in MICROSECONDS', () => {
  it('is the ISO `last_updated` at full precision, offset applied', () => {
    expect(relogioDaClaimUs(claim())).toBe(LAST_UPDATED_US);
    // Not milliseconds: the conversa's watermark is the same instant ×1000
    // smaller, on another document, and the two are never compared.
    expect(relogioDaClaimUs(claim())).not.toBe(Date.parse(LAST_UPDATED_ISO));
  });

  it('falls back to `date_created` — never to a wall clock', () => {
    expect(relogioDaClaimUs(claim({ last_updated: null }))).toBe(DATE_CREATED_US);
    expect(relogioDaClaimUs(claim({ last_updated: null, date_created: 'not-a-date' }))).toBeNull();
  });

  it('a PRESENT but malformed `last_updated` is no clock — `date_created` is not consulted', () => {
    // `last_updated ?? date_created` falls back only on null/absent, matching
    // the conversa's expression; the delivery is then dropped against any
    // stored watermark, the conservative reading.
    expect(relogioDaClaimUs(claim({ last_updated: 'not-a-date' }))).toBeNull();
    expect(
      preverIncidenteClaim(armazenado({ status: 'opened' }), mapear({ last_updated: 'not-a-date' }))
        .acao,
    ).toBe('ignorado-obsoleto');
  });
});

/* -------------------------------- create ---------------------------------- */

describe('preverIncidenteClaim — absent incidente', () => {
  it('creates the full document and stamps the watermark', () => {
    const previsao = preverIncidenteClaim(undefined, mapear());
    expect(previsao.acao).toBe('criado');
    expect(previsao.patch).toMatchObject({
      origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
      motivoDoIncidente: 'O produto chegou danificado',
      externalId: '5142940410',
      timestamp: DATE_CREATED_US,
      ultimaModificacao: LAST_UPDATED_US,
      relogioProvedorUs: LAST_UPDATED_US,
      claimStatus: 'closed',
      claimStage: 'none',
      entregue: true,
    });
  });

  it('an unreadable clock still creates, but stamps NO watermark', () => {
    const previsao = preverIncidenteClaim(
      undefined,
      mapear({ last_updated: null, date_created: 'not-a-date' }),
    );
    expect(previsao.acao).toBe('criado');
    expect(previsao.patch).not.toHaveProperty('relogioProvedorUs');
  });
});

/* -------------------------------- the guard ------------------------------- */

describe('preverIncidenteClaim — the provider-clock guard (#1772)', () => {
  it('⚠️ an OLDER `opened` snapshot cannot reopen a `closed` claim — zero writes', () => {
    const fechado = armazenado({ last_updated: '2022-08-25T09:00:00.000-04:00' });
    const previsao = preverIncidenteClaim(
      fechado,
      mapear({ status: 'opened', stage: 'claim', resolution: null }),
    );
    expect(previsao).toEqual({
      acao: 'ignorado-obsoleto',
      patch: null,
      relogioArmazenadoUs: Date.parse('2022-08-25T09:00:00.000-04:00') * 1000,
    });
  });

  it('a stored row with NO watermark (the imported corpus) reads as OLDER — the delivery writes', () => {
    const legado = { ...armazenado({ status: 'opened' }) };
    delete legado.relogioProvedorUs;
    const previsao = preverIncidenteClaim(legado, mapear());
    expect(previsao.acao).toBe('atualizado');
    expect(previsao.patch).toMatchObject({
      claimStatus: 'closed',
      relogioProvedorUs: LAST_UPDATED_US,
    });
  });

  it.each([['123'], [Number.NaN], [Number.POSITIVE_INFINITY], [null]])(
    'a stored watermark of %s is no watermark — it reads as OLDER',
    (lixo) => {
      const stored = { ...armazenado({ status: 'opened' }), relogioProvedorUs: lixo };
      expect(preverIncidenteClaim(stored, mapear()).acao).toBe('atualizado');
    },
  );

  it('EQUAL clock + same content ⇒ nothing to write', () => {
    expect(preverIncidenteClaim(armazenado(), mapear())).toEqual({
      acao: 'ignorado-sem-mudanca',
      patch: null,
      relogioArmazenadoUs: LAST_UPDATED_US,
    });
  });

  it('EQUAL clock + different content ⇒ writes — ML does not always move `last_updated`', () => {
    const aberto = armazenado({ status: 'opened', stage: 'claim', resolution: null });
    const previsao = preverIncidenteClaim(aberto, mapear());
    expect(previsao.acao).toBe('atualizado');
    // The importer-owned keys and NOTHING else — operator turf never rides.
    expect(Object.keys(previsao.patch!).sort()).toEqual([
      'claimStage',
      'claimStatus',
      'entregue',
      'relogioProvedorUs',
      'resolucao',
      'ultimaModificacao',
    ]);
    expect(previsao.patch).toMatchObject({ claimStatus: 'closed', claimStage: 'none' });
  });

  it('NEWER clock + same content ⇒ advances ONLY the watermark (and the display stamp)', () => {
    const stored = armazenado({ last_updated: '2022-08-24T16:10:25.000-04:00' });
    const previsao = preverIncidenteClaim(stored, mapear());
    expect(previsao).toEqual({
      acao: 'relogio-avancado',
      patch: { relogioProvedorUs: LAST_UPDATED_US, ultimaModificacao: LAST_UPDATED_US },
      relogioArmazenadoUs: LAST_UPDATED_US - UM_SEGUNDO_US,
    });
  });

  it('NEWER clock + different content ⇒ writes the content and advances the watermark', () => {
    const stored = armazenado({
      status: 'opened',
      last_updated: '2022-08-24T16:10:25.000-04:00',
    });
    const previsao = preverIncidenteClaim(stored, mapear());
    expect(previsao.acao).toBe('atualizado');
    expect(previsao.patch).toMatchObject({
      claimStatus: 'closed',
      relogioProvedorUs: LAST_UPDATED_US,
    });
  });

  it('is NOT gated on `ultimaModificacao` — an operator save stamps wall-clock µs there', () => {
    // The near-miss that proves which field the guard reads: an operator edit
    // far in the future must not block the importer.
    const stored = {
      ...armazenado({ status: 'opened', last_updated: '2022-08-24T16:10:25.000-04:00' }),
      ultimaModificacao: NOW_US + 10 ** 12,
    };
    expect(preverIncidenteClaim(stored, mapear()).acao).toBe('atualizado');
  });
});

/* ------------------------- clockless deliveries --------------------------- */

describe('preverIncidenteClaim — a null `last_updated`', () => {
  it('orders on `date_created`, so it LOSES to a stored real stamp', () => {
    const previsao = preverIncidenteClaim(
      armazenado(),
      mapear({ last_updated: null, status: 'opened' }),
    );
    expect(previsao.acao).toBe('ignorado-obsoleto');
  });

  it('applies against a row with no watermark, but never regresses `ultimaModificacao`', () => {
    const legado: Record<string, unknown> = {
      ...armazenado({ status: 'opened' }),
      ultimaModificacao: 999,
    };
    delete legado.relogioProvedorUs;
    const previsao = preverIncidenteClaim(legado, mapear({ last_updated: null }));
    expect(previsao.acao).toBe('atualizado');
    expect(previsao.patch).not.toHaveProperty('ultimaModificacao');
    expect(previsao.patch).toMatchObject({ relogioProvedorUs: DATE_CREATED_US });
  });

  it('an UNREADABLE clock loses to any stored watermark…', () => {
    const previsao = preverIncidenteClaim(
      armazenado({ status: 'opened' }),
      mapear({ last_updated: null, date_created: 'not-a-date' }),
    );
    expect(previsao.acao).toBe('ignorado-obsoleto');
  });

  it('…and applies, without stamping one, when none is stored', () => {
    const legado = { ...armazenado({ status: 'opened' }) };
    delete legado.relogioProvedorUs;
    const previsao = preverIncidenteClaim(
      legado,
      mapear({ last_updated: null, date_created: 'not-a-date' }),
    );
    expect(previsao.acao).toBe('atualizado');
    expect(previsao.patch).not.toHaveProperty('relogioProvedorUs');
  });
});

/* --------------------------- the content fold ----------------------------- */
// "Same content" decides whether an EQUAL clock writes. Folding too much drops
// a real change behind an equal stamp (#1372's shape), so both halves are
// pinned: what must read as the same, and the near-misses that must not.

describe('preverIncidenteClaim — what counts as the SAME content', () => {
  it('a re-derived resolução equal field by field (a fresh object) is the same', () => {
    const stored = armazenado();
    stored.resolucao = { ...(stored.resolucao as Record<string, unknown>) };
    expect(preverIncidenteClaim(stored, mapear()).acao).toBe('ignorado-sem-mudanca');
  });

  it('a stored resolução key the importer never emits does not count', () => {
    const stored = armazenado();
    stored.resolucao = { ...(stored.resolucao as Record<string, unknown>), extra: 'x' };
    expect(preverIncidenteClaim(stored, mapear()).acao).toBe('ignorado-sem-mudanca');
  });

  it.each([
    ['a null resolution keeps an operator resolução', { resolution: null }],
    ['an unparseable status keeps the stored one', { status: 'algo_novo' }],
    ['an unparseable stage keeps the stored one', { stage: 'outra_coisa' }],
    ['a null `fulfilled` keeps the stored `entregue`', { fulfilled: null }],
  ])('%s — a null-coalesced key is not written, so it cannot differ', (_rotulo, over) => {
    const previsao = preverIncidenteClaim(armazenado(), mapear(over));
    expect(previsao.acao).toBe('ignorado-sem-mudanca');
  });
});

describe('preverIncidenteClaim — near-misses that must stay DIFFERENT on an equal clock', () => {
  function comResolucao(over: Record<string, unknown>): Record<string, unknown> {
    const stored = armazenado();
    stored.resolucao = { ...(stored.resolucao as Record<string, unknown>), ...over };
    return stored;
  }

  it.each([
    ['resolucao.comentarios', comResolucao({ comentarios: 'mediator: item_returned x' })],
    ['resolucao.tipo', comResolucao({ tipo: TIPO_RESOLUCAO.outro })],
    ['resolucao.data', comResolucao({ data: LAST_UPDATED_US + 1 })],
    ['resolucao.valor (an operator amount)', comResolucao({ valor: 10 })],
    ['resolucao.frete (a stored object)', comResolucao({ frete: { estado: 'x' } })],
    ['a stored null resolução', { ...armazenado(), resolucao: null }],
    ['claimStatus', { ...armazenado(), claimStatus: 'opened' }],
    ['claimStage', { ...armazenado(), claimStage: 'dispute' }],
    ['entregue false vs true', { ...armazenado(), entregue: false }],
    ['an absent claimStatus (a pre-#1322 row)', { ...armazenado(), claimStatus: undefined }],
  ])('%s', (_campo, stored) => {
    expect(preverIncidenteClaim(stored, mapear()).acao).toBe('atualizado');
  });
});

/* ----------------------------- the transaction ---------------------------- */

function fakeDb(stored: Record<string, unknown> | undefined) {
  const ops: Array<{ op: 'create' | 'set'; data: unknown; opts?: unknown }> = [];
  const ref = { id: 'inc-1' };
  const db = {
    collection: () => ({ doc: () => ref }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        get: async () => ({ exists: stored !== undefined, data: () => stored }),
        create: (_ref: unknown, data: unknown) => ops.push({ op: 'create', data }),
        set: (_ref: unknown, data: unknown, opts: unknown) => ops.push({ op: 'set', data, opts }),
      }),
  };
  return { db: db as unknown as Firestore, ops };
}

describe('salvarIncidenteClaim — the write verbs', () => {
  const args = { pedidoId: 'ped-1', incidenteId: 'inc-1' };

  it('an absent incidente is `tx.create` — never a set that could overwrite a concurrent create', async () => {
    const { db, ops } = fakeDb(undefined);
    const previsao = await salvarIncidenteClaim(db, { ...args, mapeado: mapear() });
    expect(previsao.acao).toBe('criado');
    expect(ops).toEqual([{ op: 'create', data: previsao.patch }]);
  });

  it('an update is a MERGE-set — the deep merge `incidenteCollection.merge` always did', async () => {
    const { db, ops } = fakeDb(armazenado({ status: 'opened' }));
    const previsao = await salvarIncidenteClaim(db, { ...args, mapeado: mapear() });
    expect(previsao.acao).toBe('atualizado');
    expect(ops).toEqual([{ op: 'set', data: previsao.patch, opts: { merge: true } }]);
  });

  it('a stale snapshot writes nothing at all', async () => {
    const { db, ops } = fakeDb(armazenado({ last_updated: '2022-08-25T09:00:00.000-04:00' }));
    const previsao = await salvarIncidenteClaim(db, {
      ...args,
      mapeado: mapear({ status: 'opened' }),
    });
    expect(previsao.acao).toBe('ignorado-obsoleto');
    expect(ops).toEqual([]);
  });
});
