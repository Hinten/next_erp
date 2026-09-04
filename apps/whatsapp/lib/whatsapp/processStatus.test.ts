/**
 * `processStatuses` — the `statuses[]` → `estadoEnvio` mapping and the
 * forward-only stale guard.
 *
 * The payload is built through `valuePayloadSchema.parse` rather than cast, so
 * a fixture that drifts from the real webhook shape fails here instead of
 * type-asserting its way past the thing under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { ESTADO_ENVIO } from '@delfrance/schemas';
import { valuePayloadSchema } from '@delfrance/integrations-whatsapp-cloud-api';

// Firestore seam: one mensagem doc whose stored data each test sets, plus a
// `merge` that captures the patch the processor writes.
const h = vi.hoisted(() => ({
  get: vi.fn<() => Promise<{ exists: boolean; data: () => Record<string, unknown> }>>(),
  merge: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  mensagemCollection: {
    docRef: () => ({ get: h.get }),
    docPath: () => 'chat/c1/mensagem/m1',
    parseRead: (data: Record<string, unknown>) => data,
    merge: h.merge,
  },
}));

const { processStatuses } = await import('./processStatus');

const db = {} as Firestore;

/** The stored outbound mensagem this status lands on. */
function stored(estadoEnvio: number, lastExternalUpdateDateTime: number | null) {
  h.get.mockResolvedValue({
    exists: true,
    data: () => ({ estadoEnvio, lastExternalUpdateDateTime, errors: null }),
  });
}

/**
 * WhatsApp sends `timestamp` in SECONDS; `waTimestampToMs` scales it by 1000
 * before it meets `lastExternalUpdateDateTime`, which is stored in ms. Keeping
 * the two units apart in the fixtures is the whole point of these constants —
 * comparing 2000 against 2000 would make the stale guard fire for the wrong
 * reason and pass vacuously.
 */
const STATUS_SEC = 2_000;
const STATUS_MS = STATUS_SEC * 1000;
/** A last-update stamp AFTER the incoming status → the stale matrix decides. */
const LAST_STALE = STATUS_MS + 1_000;
/** A last-update stamp BEFORE it → the status always applies. */
const LAST_FRESH = STATUS_MS - 1_000;

/** A one-status webhook `value`, parsed by the real schema. */
function payload(status: string, timestampSeconds: number) {
  return valuePayloadSchema.parse({
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5511999999999', phone_number_id: 'pn-1' },
    statuses: [
      {
        id: 'wamid.TEST',
        recipient_id: '5511888888888',
        status,
        timestamp: String(timestampSeconds),
      },
    ],
  });
}

/** A multi-status webhook `value` — one entry per id, parsed by the real schema. */
function batch(ids: string[], status = 'delivered', timestampSeconds = STATUS_SEC) {
  return valuePayloadSchema.parse({
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5511999999999', phone_number_id: 'pn-1' },
    statuses: ids.map((id) => ({
      id,
      recipient_id: '5511888888888',
      status,
      timestamp: String(timestampSeconds),
    })),
  });
}

/** No mensagem at the deterministic id — the S1 soft miss. */
function missing() {
  h.get.mockResolvedValue({ exists: false, data: () => ({}) });
}

/** The patch `processStatuses` wrote, or undefined if it wrote nothing. */
function writtenPatch(): Record<string, unknown> | undefined {
  const call = h.merge.mock.calls[0];
  return call ? (call[3] as Record<string, unknown>) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processStatuses — estadoEnvio mapping', () => {
  it('persists `excluido` for a deleted status', async () => {
    stored(ESTADO_ENVIO.enviado, null);

    await processStatuses(db, 'conta-1', payload('deleted', STATUS_SEC));

    // The regression this pins: `deleted` used to fall into the `default` arm
    // and persist `desconhecido`, which no part of the UI renders as a deletion.
    expect(writtenPatch()?.estadoEnvio).toBe(ESTADO_ENVIO.excluido);
    expect(writtenPatch()?.estadoEnvio).not.toBe(ESTADO_ENVIO.desconhecido);
  });

  it.each([
    ['sent', ESTADO_ENVIO.enviando],
    ['delivered', ESTADO_ENVIO.enviado],
    ['read', ESTADO_ENVIO.recebido],
    ['failed', ESTADO_ENVIO.erro],
  ])('keeps the existing mapping for %s', async (status, esperado) => {
    stored(ESTADO_ENVIO.salva, null);

    await processStatuses(db, 'conta-1', payload(status, STATUS_SEC));

    expect(writtenPatch()?.estadoEnvio).toBe(esperado);
  });
});

describe('processStatuses — stale guard', () => {
  it('skips a stale deleted status instead of overwriting a later state', async () => {
    // The stored last-update is NEWER than the incoming status,
    // so the forward-only matrix decides — and a stale `deleted` is
    // always ignored, exactly as the old `default` arm did.
    stored(ESTADO_ENVIO.recebido, LAST_STALE);

    await processStatuses(db, 'conta-1', payload('deleted', STATUS_SEC));

    expect(h.merge).not.toHaveBeenCalled();
  });

  it('still applies a deleted status that is newer than the last update', async () => {
    stored(ESTADO_ENVIO.recebido, LAST_FRESH);

    await processStatuses(db, 'conta-1', payload('deleted', STATUS_SEC));

    expect(writtenPatch()?.estadoEnvio).toBe(ESTADO_ENVIO.excluido);
  });

  it('applies a stale failed status over a non-erro state', async () => {
    stored(ESTADO_ENVIO.enviado, LAST_STALE);

    await processStatuses(db, 'conta-1', payload('failed', STATUS_SEC));

    expect(writtenPatch()?.estadoEnvio).toBe(ESTADO_ENVIO.erro);
  });
});

/* ------------------------- what the batch actually did -------------------- */

/**
 * ⚠️ These pin the #1478 residual: `processStatuses` used to return `void`, so a
 * batch whose every status was a soft miss reported exactly like one that
 * advanced every mensagem. `detail: 'statuses'` said "a batch ran", never
 * "anything landed".
 *
 * The property is not "a report is returned" — it is that batches which DID
 * different things REPORT differently, including a MIXED batch, which no single
 * `MessagesFieldOutcome` member could ever have expressed.
 */
describe('processStatuses — reports what the batch did', () => {
  it('an applied status counts as `aplicados`', async () => {
    stored(ESTADO_ENVIO.salva, null);
    const r = await processStatuses(db, 'conta-1', payload('delivered', STATUS_SEC));
    expect(r).toEqual({ aplicados: 1, naoEncontrados: 0, staleIgnorados: 0 });
    expect(h.merge).toHaveBeenCalledTimes(1);
  });

  it('a missing mensagem counts as `naoEncontrados`, NOT as a stale skip', async () => {
    missing();
    const r = await processStatuses(db, 'conta-1', payload('delivered', STATUS_SEC));
    expect(r).toEqual({ aplicados: 0, naoEncontrados: 1, staleIgnorados: 0 });
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('a stale-refused status counts as `staleIgnorados`, NOT as a soft miss', async () => {
    // The two skips are kept apart deliberately: a stale skip is working as
    // designed and structurally common, a soft miss may be a real derivation bug.
    stored(ESTADO_ENVIO.recebido, LAST_STALE);
    const r = await processStatuses(db, 'conta-1', payload('deleted', STATUS_SEC));
    expect(r).toEqual({ aplicados: 0, naoEncontrados: 0, staleIgnorados: 1 });
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('THE PROPERTY: a MIXED batch reports each fate, and the three sum to the batch size', async () => {
    // One of each, in order — the case a single `detail` member cannot express.
    h.get
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({ estadoEnvio: ESTADO_ENVIO.salva, lastExternalUpdateDateTime: null }),
      })
      .mockResolvedValueOnce({ exists: false, data: () => ({}) })
      .mockResolvedValueOnce({
        exists: true,
        data: () => ({
          estadoEnvio: ESTADO_ENVIO.recebido,
          lastExternalUpdateDateTime: LAST_STALE,
        }),
      });

    const value = batch(['wamid.A', 'wamid.B', 'wamid.C'], 'deleted', STATUS_SEC);
    const r = await processStatuses(db, 'conta-1', value);

    expect(r).toEqual({ aplicados: 1, naoEncontrados: 1, staleIgnorados: 1 });
    // ⚠️ The sum invariant is the only thing that catches a FUTURE fourth exit
    // added to the loop without a counter — the type system cannot.
    expect(r.aplicados + r.naoEncontrados + r.staleIgnorados).toBe(3);
    expect(h.merge).toHaveBeenCalledTimes(1);
  });

  it('an EMPTY statuses[] reports all zeros — `[]` is truthy, so this function still runs', async () => {
    const r = await processStatuses(db, 'conta-1', batch([]));
    expect(r).toEqual({ aplicados: 0, naoEncontrados: 0, staleIgnorados: 0 });
    expect(h.get).not.toHaveBeenCalled();
  });
});
