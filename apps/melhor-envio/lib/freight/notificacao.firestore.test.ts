import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  where: vi.fn(),
  limit: vi.fn(),
  get: vi.fn(),
  update: vi.fn(async () => {}),
  docRef: vi.fn(),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  notificacaoMelhorEnvioCollection: {},
  pedidoCollection: {
    ref: () => ({ where: h.where }),
    docRef: (...args: unknown[]) => {
      h.docRef(...args);
      return { update: h.update };
    },
  },
}));

const { processMelhorEnvioNotification } = await import('./notificacao');

describe('default Melhor Envio Firestore adapter', () => {
  it('queries one label and updates against the read updateTime precondition', async () => {
    const updateTime = { seconds: 123 };
    const db = { __db: true } as unknown as Firestore;
    h.where.mockReturnValue({ limit: h.limit });
    h.limit.mockReturnValue({ get: h.get });
    h.get.mockResolvedValue({
      docs: [
        {
          id: 'pedido-1',
          data: () => ({ freteInicial: { estado: 'aguardandoPostagem', codRastreio: null } }),
          updateTime,
        },
      ],
    });

    await processMelhorEnvioNotification(db, {
      labelId: 'label-1',
      event: 'order.posted',
      providerStatus: 'posted',
      tracking: 'ME123BR',
    });

    expect(h.where).toHaveBeenCalledWith('freteInicial.printLabelId', '==', 'label-1');
    expect(h.limit).toHaveBeenCalledWith(1);
    expect(h.docRef).toHaveBeenCalledWith(db, {}, 'pedido-1');
    expect(h.update).toHaveBeenCalledWith(
      {
        'freteInicial.estado': 'postado',
        'freteInicial.codRastreio': 'ME123BR',
      },
      { lastUpdateTime: updateTime },
    );
  });
});
