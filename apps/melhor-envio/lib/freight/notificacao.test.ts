import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import {
  meStatusToEstadoFrete,
  normalizeMelhorEnvioNotification,
  notificationDocId,
  parseNotificationBody,
  processMelhorEnvioNotification,
  type MelhorEnvioNotificationPayload,
  type MelhorEnvioProcessDeps,
  type PedidoMatch,
} from './notificacao';

const db = {} as Firestore;
const updateTime = {} as Timestamp;

function payload(
  over: Partial<MelhorEnvioNotificationPayload> = {},
): MelhorEnvioNotificationPayload {
  return {
    labelId: 'lbl-1',
    event: 'order.posted',
    providerStatus: 'posted',
    tracking: null,
    ...over,
  };
}

function pedido(estado: string, codRastreio: string | null = null): PedidoMatch {
  return {
    id: 'ped-1',
    updateTime,
    data: { freteInicial: { estado, codRastreio, printLabelId: 'lbl-1' } },
  };
}

function deps(match: PedidoMatch | null = pedido('aguardandoPostagem')) {
  const findPedidoByLabel = vi.fn(async () => match);
  const updatePedido = vi.fn(async () => {});
  return {
    value: { findPedidoByLabel, updatePedido } satisfies MelhorEnvioProcessDeps,
    findPedidoByLabel,
    updatePedido,
  };
}

describe('Melhor Envio notification parsing', () => {
  it('normalizes the nested wire fields and keeps bounded extra evidence', () => {
    const parsed = parseNotificationBody({
      event: 'order.delivered',
      data: { id: 'lbl-1', status: 'delivered', tracking: 'ME123BR', carrier: 'x' },
      account: { id: 1 },
    });

    expect(parsed).toMatchObject({
      labelId: 'lbl-1',
      event: 'order.delivered',
      providerStatus: 'delivered',
      tracking: 'ME123BR',
      account: '{"id":1}',
    });
    expect(parsed?.data).toBe(
      '{"id":"lbl-1","status":"delivered","tracking":"ME123BR","carrier":"x"}',
    );
  });

  it('bounds unknown field names, values and count', () => {
    const parsed = parseNotificationBody({
      event: 'order.posted',
      data: { id: 'lbl-1', status: 'posted' },
      aHugeValue: 'x'.repeat(1_000),
      ['x'.repeat(129)]: 'discarded',
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`extra${index}`, index])),
    });

    expect(parsed?.aHugeValue).toHaveLength(513);
    expect(parsed).not.toHaveProperty('x'.repeat(129));
    expect(Object.keys(parsed ?? {}).length).toBeLessThanOrEqual(36);
  });

  it('is total for objects, rejects non-objects, and normalizes idempotently', () => {
    expect(parseNotificationBody(null)).toBeNull();
    expect(parseNotificationBody([])).toBeNull();
    expect(parseNotificationBody({ ping: true })).toBeNull();
    const once = normalizeMelhorEnvioNotification({
      event: 'order.posted',
      data: { id: 'lbl-1', status: 'posted' },
    });
    expect(normalizeMelhorEnvioNotification(once)).toEqual(once);
  });

  it('uses a deterministic Firestore-safe id for the full event identity', () => {
    const first = notificationDocId(payload());
    expect(first).toMatch(/^me-[a-f0-9]{64}$/);
    expect(notificationDocId(payload())).toBe(first);
    expect(notificationDocId(payload({ tracking: 'ME123BR' }))).not.toBe(first);
    expect(first).not.toContain('/');
  });
});

describe('meStatusToEstadoFrete', () => {
  it('preserves the complete legacy status map', () => {
    expect(meStatusToEstadoFrete('delivered')).toBe('entregue');
    expect(meStatusToEstadoFrete('posted')).toBe('postado');
    expect(meStatusToEstadoFrete('received')).toBe('postado');
    expect(meStatusToEstadoFrete('released')).toBeNull();
    expect(meStatusToEstadoFrete('canceled')).toBe('cancelado');
    expect(meStatusToEstadoFrete('cancelled')).toBe('cancelado');
    expect(meStatusToEstadoFrete('suspended')).toBe('suspenso');
    expect(meStatusToEstadoFrete('paused')).toBe('suspenso');
    expect(meStatusToEstadoFrete('undelivered')).toBe('falhaNaEntrega');
    expect(meStatusToEstadoFrete('created')).toBeNull();
    expect(meStatusToEstadoFrete(null)).toBeNull();
  });
});

describe('processMelhorEnvioNotification', () => {
  it('drops missing labels, unknown statuses and unknown labels without writing', async () => {
    const d = deps(null);
    await expect(
      processMelhorEnvioNotification(db, payload({ labelId: null }), d.value),
    ).resolves.toMatchObject({ kind: 'dropped', detail: 'label-ausente' });
    await expect(
      processMelhorEnvioNotification(db, payload({ providerStatus: 'created' }), d.value),
    ).resolves.toMatchObject({ kind: 'dropped', detail: 'status-nao-mapeado' });
    await expect(processMelhorEnvioNotification(db, payload(), d.value)).resolves.toMatchObject({
      kind: 'dropped',
      detail: 'label-desconhecida',
    });
    expect(d.updatePedido).not.toHaveBeenCalled();
  });

  it('treats released as an intentional no-op without querying', async () => {
    const d = deps();
    await expect(
      processMelhorEnvioNotification(db, payload({ providerStatus: 'released' }), d.value),
    ).resolves.toEqual({ kind: 'noop', detail: 'released' });
    expect(d.findPedidoByLabel).not.toHaveBeenCalled();
  });

  it('prefers data.status over the event suffix and falls back when absent', async () => {
    const preferred = deps(pedido('aguardandoPostagem'));
    await processMelhorEnvioNotification(
      db,
      payload({ providerStatus: 'posted', event: 'order.delivered' }),
      preferred.value,
    );
    expect(preferred.updatePedido).toHaveBeenCalledWith(db, expect.anything(), {
      'freteInicial.estado': 'postado',
    });

    const d = deps(pedido('postado'));
    await processMelhorEnvioNotification(
      db,
      payload({ providerStatus: null, event: 'order.delivered' }),
      d.value,
    );
    expect(d.updatePedido).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'ped-1' }), {
      'freteInicial.estado': 'entregue',
    });
  });

  it('writes only the two fields that actually changed', async () => {
    const both = deps();
    await expect(
      processMelhorEnvioNotification(db, payload({ tracking: 'ME123BR' }), both.value),
    ).resolves.toMatchObject({
      kind: 'applied',
      detail: 'estado-e-rastreio-atualizados',
      estado: 'postado',
    });
    expect(both.updatePedido).toHaveBeenCalledWith(db, expect.anything(), {
      'freteInicial.estado': 'postado',
      'freteInicial.codRastreio': 'ME123BR',
    });

    const trackingOnly = deps(pedido('postado'));
    await processMelhorEnvioNotification(db, payload({ tracking: 'ME123BR' }), trackingOnly.value);
    expect(trackingOnly.updatePedido).toHaveBeenCalledWith(db, expect.anything(), {
      'freteInicial.codRastreio': 'ME123BR',
    });
  });

  it('is idempotent when both fields already match', async () => {
    const d = deps(pedido('postado', 'ME123BR'));
    await expect(
      processMelhorEnvioNotification(db, payload({ tracking: 'ME123BR' }), d.value),
    ).resolves.toMatchObject({ kind: 'noop', detail: 'sem-alteracao' });
    expect(d.updatePedido).not.toHaveBeenCalled();
  });

  it('never reopens terminal estados but still records new tracking', async () => {
    const noChange = deps(pedido('entregue', 'ME123BR'));
    await expect(
      processMelhorEnvioNotification(
        db,
        payload({ providerStatus: 'posted', tracking: 'ME123BR' }),
        noChange.value,
      ),
    ).resolves.toMatchObject({ kind: 'noop', detail: 'estado-terminal' });

    const tracking = deps(pedido('cancelado'));
    await processMelhorEnvioNotification(
      db,
      payload({ providerStatus: 'delivered', tracking: 'ME999BR' }),
      tracking.value,
    );
    expect(tracking.updatePedido).toHaveBeenCalledWith(db, expect.anything(), {
      'freteInicial.codRastreio': 'ME999BR',
    });
  });

  it('propagates a concurrent precondition failure for the task retry', async () => {
    const d = deps();
    d.updatePedido.mockRejectedValueOnce(new Error('FAILED_PRECONDITION'));
    await expect(processMelhorEnvioNotification(db, payload(), d.value)).rejects.toThrow(
      'FAILED_PRECONDITION',
    );
  });
});
