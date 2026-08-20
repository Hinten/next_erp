/**
 * Tests for WhatsApp status processor. Verifies that incoming webhook statuses
 * map correctly to mensagem `estadoEnvio` values.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { ESTADO_ENVIO, type EstadoEnvioMensagem } from '@delfrance/schemas';
import { processStatuses } from './processStatus';

// Mock the collection handles
vi.mock('@delfrance/data/admin/collections', () => ({
  mensagemCollection: {
    docRef: vi.fn((db, { conversaId }, msgId) => ({
      get: vi.fn(),
    })),
    parseRead: vi.fn((data) => data),
    merge: vi.fn(),
  },
}));

describe('processStatuses', () => {
  let mockDb: Firestore;
  let mockRef: any;
  let mockSnap: any;

  beforeEach(() => {
    mockDb = {} as Firestore;
    mockRef = {
      get: vi.fn(),
    };
    mockSnap = {
      exists: true,
      data: vi.fn(),
    };
  });

  it('maps deleted status to ESTADO_ENVIO.excluido', async () => {
    const mockData = {
      estadoEnvio: ESTADO_ENVIO.enviando,
      lastExternalUpdateDateTime: 1000,
      errors: null,
    };

    mockSnap.data.mockReturnValue(mockData);
    mockRef.get.mockResolvedValue(mockSnap);

    // Re-import with mocked collection
    const { processStatuses: processStatusesMocked } = await import('./processStatus');
    const { mensagemCollection } = await import('@delfrance/data/admin/collections');

    vi.mocked(mensagemCollection.docRef).mockReturnValue(mockRef);

    const value = {
      metadata: { display_phone_number: '555123456789' },
      statuses: [
        {
          id: 'msg-123',
          recipient_id: '555987654321',
          status: 'deleted' as const,
          timestamp: '2000',
          errors: null,
        },
      ],
      errors: null,
    };

    await processStatusesMocked(mockDb, 'conta-123', value as any);

    // Verify merge was called with excluido
    const mergeCall = vi.mocked(mensagemCollection.merge).mock.calls[0];
    expect(mergeCall).toBeDefined();
    const patch = mergeCall[3];
    expect(patch.estadoEnvio).toBe(ESTADO_ENVIO.excluido);
  });

  it('maps sent status to ESTADO_ENVIO.enviando', async () => {
    const mockData = {
      estadoEnvio: ESTADO_ENVIO.salva,
      lastExternalUpdateDateTime: null,
      errors: null,
    };

    mockSnap.data.mockReturnValue(mockData);
    mockRef.get.mockResolvedValue(mockSnap);

    const { processStatuses: processStatusesMocked } = await import('./processStatus');
    const { mensagemCollection } = await import('@delfrance/data/admin/collections');

    vi.mocked(mensagemCollection.docRef).mockReturnValue(mockRef);

    const value = {
      metadata: { display_phone_number: '555123456789' },
      statuses: [
        {
          id: 'msg-456',
          recipient_id: '555987654321',
          status: 'sent' as const,
          timestamp: '2000',
          errors: null,
        },
      ],
      errors: null,
    };

    await processStatusesMocked(mockDb, 'conta-123', value as any);

    const mergeCall = vi.mocked(mensagemCollection.merge).mock.calls[0];
    const patch = mergeCall[3];
    expect(patch.estadoEnvio).toBe(ESTADO_ENVIO.enviando);
  });
});
