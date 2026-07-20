import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EtiquetaProviderUi } from './etiqueta/types';

// Hoisted mocks (vi.mock factories can't close over normal consts).
const h = vi.hoisted(() => ({
  getDoc: vi.fn(),
  docRef: vi.fn((_db: unknown, _ctx: unknown, id: string) => ({ __pedidoRef: id })),
  dereferenceOuterRef: vi.fn(),
  emitirOuImprimirEtiqueta: vi.fn(),
  ensureNfeAprovada: vi.fn(),
  printDanfeForCheckout: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({ getDoc: h.getDoc }));
vi.mock('../data/pedidoCollection', () => ({ pedidoCollection: { docRef: h.docRef } }));
vi.mock('../data/dereferenceOuterRef', () => ({ dereferenceOuterRef: h.dereferenceOuterRef }));
vi.mock('./etiqueta/registry', () => ({ emitirOuImprimirEtiqueta: h.emitirOuImprimirEtiqueta }));
vi.mock('./nfeFlow', () => ({
  ensureNfeAprovada: h.ensureNfeAprovada,
  printDanfeForCheckout: h.printDanfeForCheckout,
}));

import { reprintCheckoutDanfe, reprintCheckoutEtiqueta } from './reprintCheckout';

const db = { __db: true } as never;
const ui: EtiquetaProviderUi = {
  confirmRisk: vi.fn(),
  notify: vi.fn(),
  openUrl: vi.fn(),
  comprarEtiqueta: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  h.docRef.mockImplementation((_db: unknown, _ctx: unknown, id: string) => ({ __pedidoRef: id }));
});

describe('reprintCheckoutEtiqueta — targets the row.pedidoId, its OWN live frete', () => {
  it('fetches the given pedido and dispatches the registry with that pedido + live frete', async () => {
    const freteA = {
      printLabelId: 'LBL-A',
      integracaoFreteOuterRef: 'documents/int_frete/INT1',
      modalidade: '0',
      estado: 'checkFinalizado',
    };
    h.getDoc
      .mockResolvedValueOnce({ exists: () => true, data: () => ({ freteInicial: freteA }) }) // pedido
      .mockResolvedValueOnce({
        exists: () => true,
        id: 'INT1',
        data: () => ({ tipo: 'melhorEnvios' }),
      }); // int_frete
    h.dereferenceOuterRef.mockReturnValue({ __intRef: 'INT1' });
    h.emitirOuImprimirEtiqueta.mockResolvedValue({ status: 'opened' });

    const res = await reprintCheckoutEtiqueta({
      db,
      pedidoId: 'PEDA',
      freightClient: {} as never,
      nfeClient: null,
      formato: 'pdf',
      ui,
    });

    // The pedido fetched is the one we asked for — never a shared "current pedido".
    expect(h.docRef).toHaveBeenCalledWith(db, {}, 'PEDA');
    const input = h.emitirOuImprimirEtiqueta.mock.calls[0]![0] as {
      pedidoId: string;
      frete: typeof freteA;
      intFrete: unknown;
      formato: string;
    };
    expect(input.pedidoId).toBe('PEDA');
    expect(input.frete).toBe(freteA); // the fetched pedido's OWN live frete block
    expect(input.intFrete).toEqual({
      id: 'INT1',
      tipo: 'melhorEnvios',
      data: { tipo: 'melhorEnvios' },
    });
    expect(input.formato).toBe('pdf');
    expect(res).toEqual({ status: 'opened' });
  });

  it('returns no-pedido when the pedido is gone (registry never runs)', async () => {
    h.getDoc.mockResolvedValueOnce({ exists: () => false });
    const res = await reprintCheckoutEtiqueta({
      db,
      pedidoId: 'GONE',
      freightClient: {} as never,
      nfeClient: null,
      formato: 'pdf',
      ui,
    });
    expect(res).toEqual({ status: 'no-pedido' });
    expect(h.emitirOuImprimirEtiqueta).not.toHaveBeenCalled();
  });

  it('returns no-frete / no-integration on the respective gaps', async () => {
    h.getDoc.mockResolvedValueOnce({ exists: () => true, data: () => ({ freteInicial: null }) });
    expect(
      await reprintCheckoutEtiqueta({
        db,
        pedidoId: 'P',
        freightClient: {} as never,
        nfeClient: null,
        formato: 'pdf',
        ui,
      }),
    ).toEqual({ status: 'no-frete' });

    h.getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({
        freteInicial: { integracaoFreteOuterRef: null, modalidade: '0', estado: 'iniciado' },
      }),
    });
    h.dereferenceOuterRef.mockReturnValue(null);
    expect(
      await reprintCheckoutEtiqueta({
        db,
        pedidoId: 'P',
        freightClient: {} as never,
        nfeClient: null,
        formato: 'pdf',
        ui,
      }),
    ).toEqual({ status: 'no-integration' });
  });
});

describe('reprintCheckoutDanfe', () => {
  it('ensures the NF-e then prints, keyed to the given pedidoId', async () => {
    h.ensureNfeAprovada.mockResolvedValue({ ok: true, nfeId: 'N1', chave: 'c', reused: true });
    h.printDanfeForCheckout.mockResolvedValue('printed');

    const res = await reprintCheckoutDanfe({
      db,
      nfeClient: {} as never,
      pedidoId: 'PEDA',
      formato: 'simplificadoPdf',
    });

    expect(h.ensureNfeAprovada).toHaveBeenCalledWith(db, expect.anything(), 'PEDA');
    expect(h.printDanfeForCheckout).toHaveBeenCalledWith(
      expect.anything(),
      'PEDA',
      'N1',
      'simplificadoPdf',
      undefined,
    );
    expect(res).toEqual({ status: 'printed' });
  });

  it('surfaces a pending NF-e distinctly and never prints it', async () => {
    h.ensureNfeAprovada.mockResolvedValue({ ok: false, pending: true });
    const res = await reprintCheckoutDanfe({
      db,
      nfeClient: {} as never,
      pedidoId: 'PEDA',
      formato: 'simplificadoPdf',
    });
    expect(res).toEqual({ status: 'pending' });
    expect(h.printDanfeForCheckout).not.toHaveBeenCalled();
  });

  it('returns no-nfe without emitting when the NF-e client is unavailable', async () => {
    const res = await reprintCheckoutDanfe({
      db,
      nfeClient: null,
      pedidoId: 'PEDA',
      formato: 'simplificadoPdf',
    });
    expect(res.status).toBe('no-nfe');
    expect(h.ensureNfeAprovada).not.toHaveBeenCalled();
  });
});
