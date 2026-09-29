/**
 * Unit tests for the bulk-emit dispatcher (`dispatchEmitirNFe`).
 * Pure function — mocks the NFeHttpClient + intercepts Mantine
 * notifications. No DOM, no Firestore: the rejection-context loader is
 * injected (a `vi.fn`), and the hook's Firestore-backed one is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import {
  NFeRejectedError,
  type NFeEmitResult,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';
import { ESTADO_NFE, IE_SENTINELA, TIPO_CLIENTE } from '@delfrance/schemas';
import type { Pedido } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  db: { sentinel: 'firestore' },
  useNFeClient: vi.fn(),
  carregadorContextoRejeicao: vi.fn(),
}));

// The hook's collaborators — the dispatcher itself touches none of them.
vi.mock('./client', () => ({ useNFeClient: h.useNFeClient }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => h.db }));
vi.mock('./contextoRejeicao', () => ({
  carregadorContextoRejeicao: h.carregadorContextoRejeicao,
}));

import { dispatchEmitirNFe, NFeLoteNotImplementedError, useEmitirNFeAction } from './bulkEmit';
import { ID_DEST, IND_IE_DEST } from './destinatarioNFe';
import type { CarregarContextoRejeicao, ContextoRejeicaoNFe } from './errors';

// Mock the @mantine/notifications side-effect surface. The dispatcher
// uses it for the success path; the error path goes through
// showErrorNotification, mocked below.
vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn(), update: vi.fn(), hide: vi.fn() },
}));

vi.mock('../notifications/showErrorNotification', () => ({
  showErrorNotification: vi.fn(),
  showCopyableNotification: vi.fn(),
}));

import { notifications } from '@mantine/notifications';
import {
  showCopyableNotification,
  showErrorNotification,
} from '../notifications/showErrorNotification';

const showSpy = vi.mocked(notifications.show);
const showErrorSpy = vi.mocked(showErrorNotification);
const showCopyableSpy = vi.mocked(showCopyableNotification);

function fakeRow(id: string): { id: string; data: Pedido } {
  return { id, data: {} as unknown as Pedido };
}

const XMOTIVO_805 =
  'Rejeição: A SEFAZ do destinatário não permite Contribuinte Isento de Inscrição Estadual';

/** What the loader finds for an internal (idDest=1) NF-e sent with indIEDest=2. */
const CONTEXTO_805_INTERNA: ContextoRejeicaoNFe = {
  destinatario: { idDest: ID_DEST.interna, indIEDest: IND_IE_DEST.isento, uf: 'SP' },
  cliente: {
    id: 'cli-805',
    cadastro: {
      nome: 'ACME LTDA',
      tipo: TIPO_CLIENTE.pessoaJuridica,
      ie: IE_SENTINELA.isento,
    },
  },
};

function loaderMock(ctx: ContextoRejeicaoNFe = CONTEXTO_805_INTERNA) {
  return vi.fn<CarregarContextoRejeicao>(() => Promise.resolve(ctx));
}

function rejeicao805(pedidoId: string): NFeRejectedError {
  return new NFeRejectedError('805', XMOTIVO_805, {
    pedidoId,
    nfeId: 'nfev4-805',
    estado: ESTADO_NFE.rejeitada,
    cStat: '805',
    xMotivo: XMOTIVO_805,
  });
}

function fakeClient(impl: NFeHttpClient['emitir']): NFeHttpClient {
  return {
    emitir: impl,
    emitirLote: vi.fn(),
    consultar: vi.fn(),
    verificar: vi.fn(),
    consultaCadastro: vi.fn(),
    processarPendentes: vi.fn(),
    cancelar: vi.fn(),
    inutilizar: vi.fn(),
    cartaCorrecao: vi.fn(),
    danfe: vi.fn(),
    cartaCorrecaoDanfe: vi.fn(),
    statusServico: vi.fn(),
    uploadCertificado: vi.fn(),
    deleteCertificado: vi.fn(),
  };
}

function emitResult(over: Partial<NFeEmitResult> = {}): NFeEmitResult {
  return {
    nfeId: 'nfev4-001',
    pedidoId: 'PED-001',
    estado: ESTADO_NFE.aprovada,
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
  showCopyableSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('dispatchEmitirNFe', () => {
  it('no-ops on empty rows (defensive — action is gated by requiresSelection)', async () => {
    const emitir = vi.fn();
    const carregar = loaderMock();
    await dispatchEmitirNFe(fakeClient(emitir), [], carregar);
    expect(emitir).not.toHaveBeenCalled();
    expect(carregar).not.toHaveBeenCalled();
    expect(showSpy).not.toHaveBeenCalled();
    expect(showErrorSpy).not.toHaveBeenCalled();
    expect(showCopyableSpy).not.toHaveBeenCalled();
  });

  it('single row → calls client.emitir(id) + shows a COPYABLE success notification', async () => {
    const emitir = vi.fn().mockResolvedValue(emitResult());
    const carregar = loaderMock();
    await dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-001')], carregar);

    expect(emitir).toHaveBeenCalledOnce();
    expect(emitir).toHaveBeenCalledWith('PED-001');
    // A success never pays for the rejection-context reads.
    expect(carregar).not.toHaveBeenCalled();
    // Results route through the copyable toast (cStat/xMotivo must be
    // copy-pasteable for diagnosis), not a plain notifications.show.
    expect(showSpy).not.toHaveBeenCalled();
    expect(showCopyableSpy).toHaveBeenCalledOnce();
    const arg = showCopyableSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('green');
    expect(arg.title).toBe('NF-e autorizada');
  });

  it("EPEC 468 result → copyable yellow 'não sincronizado' toast (wait-and-retry)", async () => {
    const emitir = vi.fn().mockResolvedValue(
      emitResult({
        estado: ESTADO_NFE.epecAprovado,
        cStat: '468',
        xMotivo: 'Rejeição: EPEC não Sincronizado na Base de Dados da SEFAZ Autorizadora',
        nRec: null,
      }),
    );
    await dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-001')], loaderMock());

    expect(showCopyableSpy).toHaveBeenCalledOnce();
    const arg = showCopyableSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('yellow');
    expect(arg.title).toContain('não sincronizado');
    expect(arg.message).toContain('468');
    expect(arg.message).toContain('Aguarde alguns minutos');
  });

  it('single row, client throws NFeRejectedError → shows error notification with copy support', async () => {
    const emitir = vi.fn().mockRejectedValue(new NFeRejectedError('226', 'UF inválida', {}));
    const carregar = loaderMock();
    await dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-002')], carregar);

    expect(emitir).toHaveBeenCalledWith('PED-002');
    // Errors go through showErrorNotification, not notifications.show directly.
    expect(showSpy).not.toHaveBeenCalled();
    expect(showErrorSpy).toHaveBeenCalledOnce();
    const arg = showErrorSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('red');
    expect(arg.title).toBe('SEFAZ rejeitou a NF-e');
    expect(arg.message).toContain('226');
    // Only a cStat that needs context (805) reads anything.
    expect(carregar).not.toHaveBeenCalled();
    expect(arg.link ?? null).toBeNull();
  });

  it('cStat 805 with {pedidoId, nfeId} → the injected loader runs once; the toast carries the guidance + cadastro link', async () => {
    const emitir = vi.fn().mockRejectedValue(rejeicao805('PED-805'));
    const carregar = loaderMock();
    await dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-805')], carregar);

    expect(carregar).toHaveBeenCalledOnce();
    expect(carregar).toHaveBeenCalledWith({ pedidoId: 'PED-805', nfeId: 'nfev4-805' });
    expect(showErrorSpy).toHaveBeenCalledOnce();
    const arg = showErrorSpy.mock.calls[0]![0]!;
    expect(arg.color).toBe('red');
    expect(arg.title).toBe('Inscrição estadual do cliente recusada pela SEFAZ');
    // The verbatim SEFAZ outcome stays first — copy-pasteable — then the guidance.
    expect(arg.message.startsWith(`cStat=805: ${XMOTIVO_805} — `)).toBe(true);
    expect(arg.message).toContain('o cliente ACME LTDA marcado como Isento');
    expect(arg.message).toContain('SEFAZ-SP não aceita em operação interna');
    expect(arg.link).toEqual({
      href: '/clientes/cli-805',
      label: 'Abrir cadastro de ACME LTDA',
    });
  });

  it('a loader rejection propagates — no toast is shown over a bug', async () => {
    const boom = new TypeError('bug no carregador');
    const emitir = vi.fn().mockRejectedValue(rejeicao805('PED-805'));
    const carregar = vi.fn<CarregarContextoRejeicao>(() => Promise.reject(boom));
    await expect(
      dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-805')], carregar),
    ).rejects.toBe(boom);
    expect(showErrorSpy).not.toHaveBeenCalled();
  });

  it('N > 1 rows → throws NFeLoteNotImplementedError(N), does not call client', async () => {
    const emitir = vi.fn();
    const carregar = loaderMock();
    const rows = [fakeRow('PED-001'), fakeRow('PED-002'), fakeRow('PED-003')];
    const call = dispatchEmitirNFe(fakeClient(emitir), rows, carregar);
    await expect(call).rejects.toBeInstanceOf(NFeLoteNotImplementedError);
    await expect(call).rejects.toMatchObject({ selected: 3 });
    expect(emitir).not.toHaveBeenCalled();
    expect(carregar).not.toHaveBeenCalled();
    expect(showSpy).not.toHaveBeenCalled();
    expect(showErrorSpy).not.toHaveBeenCalled();
  });

  it('re-throws non-Error values from client (programming bugs surface)', async () => {
    const emitir = vi.fn().mockRejectedValue('not an Error');
    const carregar = loaderMock();
    await expect(
      dispatchEmitirNFe(fakeClient(emitir), [fakeRow('PED-001')], carregar),
    ).rejects.toBe('not an Error');
    expect(carregar).not.toHaveBeenCalled();
    expect(showSpy).not.toHaveBeenCalled();
    expect(showErrorSpy).not.toHaveBeenCalled();
  });
});

describe('useEmitirNFeAction — single-row run', () => {
  it('wires the Firestore-backed loader, built from getFirebaseFirestore(), into the dispatcher', async () => {
    const carregar = loaderMock();
    h.carregadorContextoRejeicao.mockReturnValue(carregar);
    h.useNFeClient.mockReturnValue(fakeClient(vi.fn().mockRejectedValue(rejeicao805('PED-805'))));

    const { result } = renderHook(() => useEmitirNFeAction());
    await result.current.action.run([fakeRow('PED-805')] as never);

    expect(h.carregadorContextoRejeicao).toHaveBeenCalledOnce();
    expect(h.carregadorContextoRejeicao.mock.calls[0]![0]).toBe(h.db);
    expect(carregar).toHaveBeenCalledWith({ pedidoId: 'PED-805', nfeId: 'nfev4-805' });
    expect(showErrorSpy).toHaveBeenCalledOnce();
    expect(showErrorSpy.mock.calls[0]![0]!.link?.href).toBe('/clientes/cli-805');
  });
});
