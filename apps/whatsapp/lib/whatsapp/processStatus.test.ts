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
