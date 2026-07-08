import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pedido } from '@delfrance/schemas';

const { ensureNfeMock, printDanfeMock, emitirEtiquetaMock, getDocMock, derefMock } = vi.hoisted(
  () => ({
    ensureNfeMock: vi.fn(),
    printDanfeMock: vi.fn(),
    emitirEtiquetaMock: vi.fn(),
    getDocMock: vi.fn(),
    derefMock: vi.fn(),
  }),
);

vi.mock('./nfeFlow', () => ({
  ensureNfeAprovada: ensureNfeMock,
  printDanfeForCheckout: printDanfeMock,
}));
vi.mock('./etiqueta/registry', () => ({ emitirOuImprimirEtiqueta: emitirEtiquetaMock }));
vi.mock('firebase/firestore', () => ({ getDoc: getDocMock }));
vi.mock('../data/dereferenceOuterRef', () => ({ dereferenceOuterRef: derefMock }));
vi.mock('../print-agent/printJob', () => ({ printJob: vi.fn() }));

import { runCheckoutPostSave } from './postSave';

const db = {} as never;
const nfeClient = {} as never;
const ui = { confirmRisk: vi.fn(), notify: vi.fn(), openUrl: vi.fn(), comprarEtiqueta: vi.fn() };
const pedidoWith = (frete: unknown) => ({ freteInicial: frete }) as unknown as Pedido;

beforeEach(() => {
  ensureNfeMock.mockReset();
  printDanfeMock.mockReset();
  emitirEtiquetaMock.mockReset();
  getDocMock.mockReset();
  derefMock.mockReset();
  ui.notify.mockReset();
});

describe('runCheckoutPostSave', () => {
  it('emits NF-e, prints the DANFE, and dispatches the etiqueta with the resolved integration', async () => {
    ensureNfeMock.mockResolvedValue({ ok: true, nfeId: 'n1', chave: 'CHV', reused: false });
    printDanfeMock.mockResolvedValue('printed');
    derefMock.mockReturnValue({});
    getDocMock.mockResolvedValue({
      exists: () => true,
      id: 'if-1',
      data: () => ({ tipo: 'melhorEnvios' }),
    });
    emitirEtiquetaMock.mockResolvedValue({ status: 'opened' });

    const r = await runCheckoutPostSave({
      db,
      nfeClient,
      freightClient: null,
      pedido: pedidoWith({ integracaoFreteOuterRef: 'documents/int_frete/if-1', modalidade: '0' }),
      pedidoId: 'p1',
      formatoDanfe: 'simplificadoPdf',
      formatoEtiqueta: 'pdf',
      ui,
    });

    expect(r.nfe).toMatchObject({ ok: true });
    expect(r.danfe).toBe('printed');
    expect(r.etiqueta).toEqual({ status: 'opened' });
    expect(printDanfeMock).toHaveBeenCalledWith(
      nfeClient,
      'p1',
      'n1',
      'simplificadoPdf',
      undefined,
    );
    expect(emitirEtiquetaMock.mock.calls[0]![0].intFrete).toEqual({
      id: 'if-1',
      tipo: 'melhorEnvios',
      data: { tipo: 'melhorEnvios' },
    });
  });

  it('notifies + returns no-integration when the frete has no transportadora', async () => {
    ensureNfeMock.mockResolvedValue({ ok: false, pending: true });
    derefMock.mockReturnValue(null);
    const r = await runCheckoutPostSave({
      db,
      nfeClient,
      freightClient: null,
      pedido: pedidoWith({ integracaoFreteOuterRef: null, modalidade: '0' }),
      pedidoId: 'p1',
      formatoDanfe: 'retrato',
      formatoEtiqueta: 'pdf',
      ui,
    });
    expect(r.danfe).toBeNull(); // NF-e pending → no DANFE
    expect(r.etiqueta).toEqual({ status: 'no-integration' });
    expect(ui.notify).toHaveBeenCalledOnce();
    expect(emitirEtiquetaMock).not.toHaveBeenCalled();
  });

  it('skips NF-e when no client is present and skips etiqueta when frete is null', async () => {
    const r = await runCheckoutPostSave({
      db,
      nfeClient: null,
      freightClient: null,
      pedido: pedidoWith(null),
      pedidoId: 'p1',
      formatoDanfe: 'retrato',
      formatoEtiqueta: 'pdf',
      ui,
    });
    expect(r.nfe).toMatchObject({ ok: false });
    expect(ensureNfeMock).not.toHaveBeenCalled();
    expect(r.danfe).toBeNull();
    expect(r.etiqueta).toBeNull();
  });
});
