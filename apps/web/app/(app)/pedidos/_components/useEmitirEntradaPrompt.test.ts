/**
 * The post-save "Emitir NF-e?" prompt of an entrada — and its #1683 gate: a
 * DEVOLUÇÃO (finNFe 4) whose saved items still lack their reference to the
 * origin NF-e line is never offered the emission SEFAZ would refuse (VC02-14,
 * cStat 321); a warning points to the Fiscal tab instead. Every other
 * finalidade ignores the count.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  operacao: null as Record<string, unknown> | null,
  confirm: vi.fn(async () => true),
  emitir: vi.fn(async () => undefined),
  notificar: vi.fn(),
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/pedidos/clientPort', () => ({
  createClientPedidoPort: () => ({
    hasNFe: async () => false,
    getOperacao: async () => mocks.operacao,
  }),
}));
vi.mock('@/lib/nfe/client', () => ({ useNFeClient: () => ({}) }));
vi.mock('./emitirNFeComNotificacao', () => ({ emitirNFeComNotificacao: mocks.emitir }));
vi.mock('./ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm, element: null }),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: mocks.notificar } }));

import { useEmitirEntradaPrompt } from './useEmitirEntradaPrompt';

const BASE = {
  pedidoId: 'e1',
  estado: 'pago',
  operacaoOuterRef: 'documents/operacao/op1',
};

function prompt() {
  return renderHook(() => useEmitirEntradaPrompt()).result.current.promptEmitirEntrada;
}

afterEach(() => {
  mocks.operacao = null;
  vi.clearAllMocks();
});

describe('useEmitirEntradaPrompt — devolução references (VC02-14, #1683)', () => {
  it('a devolução with items still unreferenced: warns, never asks, never emits', async () => {
    mocks.operacao = { ehFiscal: true, finNFe: 4 };
    await prompt()({ ...BASE, referenciasPendentes: 2 });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.emitir).not.toHaveBeenCalled();
    expect(mocks.notificar).toHaveBeenCalledTimes(1);
    expect(mocks.notificar.mock.calls[0]?.[0]).toMatchObject({
      color: 'yellow',
      message: expect.stringContaining('2 itens estão sem a referência'),
    });
  });

  it('a devolução with every item referenced is offered the emission as before', async () => {
    mocks.operacao = { ehFiscal: true, finNFe: 4 };
    await prompt()({ ...BASE, referenciasPendentes: 0 });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.emitir).toHaveBeenCalledWith(expect.anything(), 'e1');
    expect(mocks.notificar).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: a compra entrada (finNFe 1) ignores the count — nothing references there', async () => {
    mocks.operacao = { ehFiscal: true, finNFe: 1 };
    await prompt()({ ...BASE, referenciasPendentes: 3 });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.notificar).not.toHaveBeenCalled();
  });

  it('the integral path (pre-resolved fiscal-capable operação) is gated the same way', async () => {
    await prompt()({
      ...BASE,
      operacao: {
        outerRef: 'documents/operacao/opDev',
        id: 'opDev',
        nome: 'Dev',
        fiscalCapable: true,
      },
      referenciasPendentes: 1,
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.notificar.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining('1 item está sem a referência'),
    });
  });

  it('a non-fiscal operação never prompts, pending or not', async () => {
    mocks.operacao = { ehFiscal: false, finNFe: 4 };
    await prompt()({ ...BASE, referenciasPendentes: 2 });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.notificar).not.toHaveBeenCalled();
  });
});
