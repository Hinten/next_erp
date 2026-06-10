/**
 * Unit tests for the bulk-emit dispatcher (`dispatchEmitirNFe`).
 * Pure function — mocks the NFeHttpClient + intercepts Mantine
 * notifications. No DOM, no Firestore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NFeRejectedError,
  type NFeEmitResult,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import type { Pedido } from '@delfrance/schemas';

import { dispatchEmitirNFe, NFeLoteNotImplementedError } from './bulkEmit';

// Mock the @mantine/notifications side-effect surface. The dispatcher
// uses it for the success path; the error path goes through
// showErrorNotification, mocked below.
vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn(), update: vi.fn(), hide: vi.fn() },
}));

vi.mock('../notifications/showErrorNotification', () => ({
  showErrorNotification: vi.fn(),
}));

import { notifications } from '@mantine/notifications';
import { showErrorNotification } from '../notifications/showErrorNotification';

const showSpy = vi.mocked(notifications.show);
const showErrorSpy = vi.mocked(showErrorNotification);

function fakeRow(id: string): { id: string; data: Pedido } {
  return { id, data: {} as unknown as Pedido };
}

function fakeClient(impl: NFeHttpClient['emitir']): NFeHttpClient {
  return {
    emitir: impl,
    emitirLote: vi.fn(),
    consultar: vi.fn(),
    processarPendentes: vi.fn(),
    cancelar: vi.fn(),
    inutilizar: vi.fn(),
    cartaCorrecao: vi.fn(),
    danfe: vi.fn(),
    cartaCorrecaoDanfe: vi.fn(),
    statusServico: vi.fn(),
  };
}

function emitResult(over: Partial<NFeEmitResult> = {}): NFeEmitResult {
  return {
    nfeId: 'nfev4-001',
    pedidoId: 'PED-001',
    estado: 'a',
    chave: '35260514200166000187550010000000071000000018',
    nRec: '12345',
    cStat: '100',
    xMotivo: 'Autorizado o uso da NF-e',
    ...over,
  };
}

beforeEach(() => {
  showSpy.mockClear();
  showErrorSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('dispatchEmitirNFe', () => {
  it('no-ops on empty rows (defensive — action is gated by requiresSelection)', async () => {
    const emitir = vi.fn();
    await dispatchEmitirNFe(fakeClient(emitir), []);
    expect(emitir).not.toHaveBeenCalled();
    expect(showSpy).not.toHaveBeenCalled();
    expect(showErrorSpy).not.toHaveBeenCalled();
  });

  it('single row → calls client.emitir(id) + shows success notification', async () => {
    const emitir = vi.fn().mockResolvedValue(emitResult());
    await dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-001')]);

    expect(emitir).toHaveBeenCalledOnce();
    expect(emitir).toHaveBeenCalledWith('PED-001');
    expect(showSpy).toHaveBeenCalledOnce();
    const arg = showSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('green');
    expect(arg.title).toBe('NF-e autorizada');
  });

  it('single row, client throws NFeRejectedError → shows error notification with copy support', async () => {
    const emitir = vi.fn().mockRejectedValue(new NFeRejectedError('226', 'UF inválida', {}));
    await dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-002')]);

    expect(emitir).toHaveBeenCalledWith('PED-002');
    // Errors go through showErrorNotification, not notifications.show directly.
    expect(showSpy).not.toHaveBeenCalled();
    expect(showErrorSpy).toHaveBeenCalledOnce();
    const arg = showErrorSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('red');
    expect(arg.title).toBe('SEFAZ rejeitou a NF-e');
    expect(arg.message).toContain('226');
  });

  it('N > 1 rows → throws NFeLoteNotImplementedError(N), does not call client', async () => {
    const emitir = vi.fn();
    const rows = [fakeRow('PED-001'), fakeRow('PED-002'), fakeRow('PED-003')];
    const call = dispatchEmitirNFe(fakeClient(emitir), rows);
    await expect(call).rejects.toBeInstanceOf(NFeLoteNotImplementedError);
    await expect(call).rejects.toMatchObject({ selected: 3 });
    expect(emitir).not.toHaveBeenCalled();
    expect(showSpy).not.toHaveBeenCalled();
    expect(showErrorSpy).not.toHaveBeenCalled();
  });

  it('re-throws non-Error values from client (programming bugs surface)', async () => {
    const emitir = vi.fn().mockRejectedValue('not an Error');
    await expect(dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-001')])).rejects.toBe(
      'not an Error',
    );
    expect(showSpy).not.toHaveBeenCalled();
    expect(showErrorSpy).not.toHaveBeenCalled();
  });
});
