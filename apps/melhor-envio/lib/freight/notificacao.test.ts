import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import {
  MelhorEnvioHttpError,
  MelhorEnvioNetworkError,
  MelhorEnvioReauthRequiredError,
  MelhorEnvioSchemaError,
  type Order,
} from '@delfrance/integrations-freight-br';

import {
  meStatusToEstadoFrete,
  normalizeMelhorEnvioNotification,
  notificationDocId,
  parseNotificationBody,
  processMelhorEnvioNotification,
  requireMelhorEnvioNotificationRuntimeConfig,
  type MelhorEnvioNotificationPayload,
  type MelhorEnvioProcessDeps,
  type PedidoMatch,
} from './notificacao';
import { MelhorEnvioContaNotConfiguredError, MelhorEnvioConfigError } from './melhorEnvio';

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

function pedido(
  estado: string,
  codRastreio: string | null = null,
  integracaoFreteOuterRef: string | null = 'documents/int_frete/int-1',
): PedidoMatch {
  return {
    id: 'ped-1',
    updateTime,
    data: {
      freteInicial: { estado, codRastreio, printLabelId: 'lbl-1', integracaoFreteOuterRef },
    },
  };
}

function order(over: Partial<Order> = {}): Order {
  return { id: 'lbl-1', status: 'posted', tracking: null, ...over };
}

function deps(match: PedidoMatch | null = pedido('aguardandoPostagem'), current: Order = order()) {
  const findPedidoByLabel = vi.fn(async () => match);
  const loadCurrentLabel = vi.fn(async () => current);
  const updatePedido = vi.fn(async () => {});
  return {
    value: { findPedidoByLabel, loadCurrentLabel, updatePedido } satisfies MelhorEnvioProcessDeps,
    findPedidoByLabel,
    loadCurrentLabel,
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

  it('prefers data.status over the event suffix', () => {
    expect(
      parseNotificationBody({
        event: 'order.delivered',
        data: { id: 'lbl-1', status: 'posted' },
      })?.providerStatus,
    ).toBe('posted');
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

  it('uses the authoritative API state instead of an older webhook state', async () => {
    const preferred = deps(pedido('postado'), order({ status: 'suspended' }));
    await processMelhorEnvioNotification(
      db,
      payload({ providerStatus: 'posted', event: 'order.posted' }),
      preferred.value,
    );
    expect(preferred.updatePedido).toHaveBeenCalledWith(db, expect.anything(), {
      'freteInicial.estado': 'suspenso',
    });

    const d = deps(pedido('suspenso'), order({ status: 'posted' }));
    await processMelhorEnvioNotification(
      db,
      payload({ providerStatus: 'suspended', event: 'order.suspended' }),
      d.value,
    );
    expect(d.updatePedido).toHaveBeenCalledWith(db, expect.objectContaining({ id: 'ped-1' }), {
      'freteInicial.estado': 'postado',
    });
  });

  it('applies a legitimate recovery from delivery failure when the API confirms posted', async () => {
    const d = deps(pedido('falhaNaEntrega'), order({ status: 'posted' }));
    await expect(processMelhorEnvioNotification(db, payload(), d.value)).resolves.toMatchObject({
      kind: 'applied',
      estado: 'postado',
      providerStatusEfetivo: 'posted',
    });
  });

  it('writes only the two fields that actually changed', async () => {
    const both = deps(undefined, order({ tracking: 'REMOTE123BR' }));
    await expect(
      processMelhorEnvioNotification(db, payload({ tracking: 'SIGNED123BR' }), both.value),
    ).resolves.toMatchObject({
      kind: 'applied',
      detail: 'estado-e-rastreio-atualizados',
      estado: 'postado',
    });
    expect(both.updatePedido).toHaveBeenCalledWith(db, expect.anything(), {
      'freteInicial.estado': 'postado',
      'freteInicial.codRastreio': 'REMOTE123BR',
    });

    const trackingOnly = deps(pedido('postado'), order({ tracking: null }));
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

    const tracking = deps(pedido('cancelado'), order({ status: 'delivered', tracking: null }));
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

  it('refetches Firestore and Melhor Envio after a precondition conflict', async () => {
    const d = deps();
    d.updatePedido.mockRejectedValueOnce(new Error('FAILED_PRECONDITION'));
    await expect(processMelhorEnvioNotification(db, payload(), d.value)).rejects.toThrow(
      'FAILED_PRECONDITION',
    );
    d.findPedidoByLabel.mockResolvedValueOnce(pedido('postado'));
    await expect(processMelhorEnvioNotification(db, payload(), d.value)).resolves.toMatchObject({
      kind: 'noop',
    });
    expect(d.findPedidoByLabel).toHaveBeenCalledTimes(2);
    expect(d.loadCurrentLabel).toHaveBeenCalledTimes(2);
  });

  it('defers missing integration references and account/OAuth action requirements', async () => {
    const missing = deps(pedido('postado', null, null));
    await expect(
      processMelhorEnvioNotification(db, payload(), missing.value),
    ).resolves.toMatchObject({ kind: 'deferred', detail: 'integracao-ausente-ou-invalida' });
    expect(missing.loadCurrentLabel).not.toHaveBeenCalled();

    const invalid = deps(pedido('postado', null, 'documents/int_frete/int-1/tokens/token-1'));
    await expect(
      processMelhorEnvioNotification(db, payload(), invalid.value),
    ).resolves.toMatchObject({ kind: 'deferred', detail: 'integracao-ausente-ou-invalida' });
    expect(invalid.loadCurrentLabel).not.toHaveBeenCalled();

    const wrongCollection = deps(pedido('postado', null, 'documents/integracoes/int-1'));
    await expect(
      processMelhorEnvioNotification(db, payload(), wrongCollection.value),
    ).resolves.toMatchObject({ kind: 'deferred', detail: 'integracao-ausente-ou-invalida' });
    expect(wrongCollection.loadCurrentLabel).not.toHaveBeenCalled();

    for (const error of [
      new MelhorEnvioContaNotConfiguredError('missing'),
      new MelhorEnvioReauthRequiredError('no_token', 'reconnect'),
      new MelhorEnvioHttpError('unauthorized', 401, { token: 'must-not-leak' }),
      new MelhorEnvioHttpError('forbidden', 403, {}),
      new MelhorEnvioHttpError('not found', 404, {}),
    ]) {
      const d = deps();
      d.loadCurrentLabel.mockRejectedValueOnce(error);
      await expect(processMelhorEnvioNotification(db, payload(), d.value)).resolves.toMatchObject({
        kind: 'deferred',
      });
    }
  });

  it('normalizes a tolerated bare integration outerRef before loading the label', async () => {
    const d = deps(pedido('postado', null, 'int_frete/int-legacy'));

    await expect(processMelhorEnvioNotification(db, payload(), d.value)).resolves.toMatchObject({
      kind: 'noop',
      detail: 'sem-alteracao',
    });
    expect(d.loadCurrentLabel).toHaveBeenCalledWith(db, 'int-legacy', 'lbl-1');
  });

  it('keeps network, throttling, server, schema, config and remote-state failures hot', async () => {
    const errors = [
      new MelhorEnvioNetworkError('offline'),
      new MelhorEnvioHttpError('throttled', 429, {}),
      new MelhorEnvioHttpError('server', 503, {}),
      new MelhorEnvioSchemaError('invalid 200', []),
      new MelhorEnvioConfigError('missing deployment config'),
    ];
    for (const error of errors) {
      const d = deps();
      d.loadCurrentLabel.mockRejectedValueOnce(error);
      await expect(processMelhorEnvioNotification(db, payload(), d.value)).rejects.toBe(error);
    }

    const unavailable = deps(undefined, order({ status: 'created' }));
    await expect(processMelhorEnvioNotification(db, payload(), unavailable.value)).rejects.toThrow(
      'ainda não acionável',
    );
  });
});

describe('notification Functions runtime configuration', () => {
  it('requires explicit sandbox mode and an absolute HTTP(S) public URL', () => {
    const sandbox = process.env.MELHOR_ENVIO_SANDBOX;
    const publicUrl = process.env.MELHOR_ENVIO_PUBLIC_URL;
    try {
      delete process.env.MELHOR_ENVIO_SANDBOX;
      process.env.MELHOR_ENVIO_PUBLIC_URL = 'https://me.example.com';
      expect(() => requireMelhorEnvioNotificationRuntimeConfig()).toThrow('MELHOR_ENVIO_SANDBOX');

      process.env.MELHOR_ENVIO_SANDBOX = ' false ';
      expect(() => requireMelhorEnvioNotificationRuntimeConfig()).toThrow('MELHOR_ENVIO_SANDBOX');

      process.env.MELHOR_ENVIO_SANDBOX = 'false';
      process.env.MELHOR_ENVIO_PUBLIC_URL = 'relative/path';
      expect(() => requireMelhorEnvioNotificationRuntimeConfig()).toThrow(
        'MELHOR_ENVIO_PUBLIC_URL',
      );

      process.env.MELHOR_ENVIO_PUBLIC_URL = 'https://me.example.com';
      expect(() => requireMelhorEnvioNotificationRuntimeConfig()).not.toThrow();
    } finally {
      if (sandbox === undefined) delete process.env.MELHOR_ENVIO_SANDBOX;
      else process.env.MELHOR_ENVIO_SANDBOX = sandbox;
      if (publicUrl === undefined) delete process.env.MELHOR_ENVIO_PUBLIC_URL;
      else process.env.MELHOR_ENVIO_PUBLIC_URL = publicUrl;
    }
  });
});
