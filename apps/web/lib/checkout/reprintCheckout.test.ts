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

    const mlClient = { __ml: true } as never;
    const res = await reprintCheckoutEtiqueta({
      db,
      pedidoId: 'PEDA',
      freightClient: {} as never,
      nfeClient: null,
      mercadoLivreClient: mlClient,
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
      deps: { mercadoLivreClient: unknown };
    };
    expect(input.pedidoId).toBe('PEDA');
    expect(input.frete).toBe(freteA); // the fetched pedido's OWN live frete block
    expect(input.intFrete).toEqual({
      id: 'INT1',
      tipo: 'melhorEnvios',
      data: { tipo: 'melhorEnvios' },
    });
    expect(input.formato).toBe('pdf');
    // The ML client threads through to the provider deps untouched.
    expect(input.deps.mercadoLivreClient).toBe(mlClient);
    expect(res).toEqual({ status: 'opened' });
  });

  it('returns no-pedido when the pedido is gone (registry never runs)', async () => {
    h.getDoc.mockResolvedValueOnce({ exists: () => false });
    const res = await reprintCheckoutEtiqueta({
      db,
      pedidoId: 'GONE',
      freightClient: {} as never,
      nfeClient: null,
      mercadoLivreClient: null,
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
        mercadoLivreClient: null,
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
        mercadoLivreClient: null,
        formato: 'pdf',
        ui,
      }),
    ).toEqual({ status: 'no-integration' });
  });
});

describe('reprintCheckoutEtiqueta — a stalled stage becomes a reported failure', () => {
  /**
   * The reported bug: clicking "Reimprimir Frete" left BOTH modal buttons
   * spinning on the shared `usePrintInFlight` flag, with no `/imprimir` request
   * and no toast. Root cause of the stall is still open, but an unbounded await
   * behind a spinner is a defect on its own — whatever hangs, the operator must
   * get a result instead of a permanent spinner.
   */
  it('returns a NAMED timeout when the pedido read never settles', async () => {
    vi.useFakeTimers();
    try {
      h.getDoc.mockReturnValue(new Promise(() => {})); // never settles
      h.dereferenceOuterRef.mockReturnValue({ __intRef: 'INT1' });

      const p = reprintCheckoutEtiqueta({
        db,
        pedidoId: 'PEDA',
        freightClient: {} as never,
        nfeClient: null,
        mercadoLivreClient: null,
        formato: 'pdf',
        ui,
        timeoutMs: 30_000,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      const res = await p;

      expect(res.status).toBe('timeout');
      expect(res).toMatchObject({ stage: 'carregar o pedido' });
      // The registry must never have run — nothing was printed.
      expect(h.emitirOuImprimirEtiqueta).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the integração stage when THAT is the one that hangs', async () => {
    // Discriminating: the two bounded stages must be distinguishable in the
    // report, or the toast tells the operator nothing a spinner did not.
    vi.useFakeTimers();
    try {
      h.getDoc
        .mockResolvedValueOnce({
          exists: () => true,
          data: () => ({
            freteInicial: {
              printLabelId: 'LBL-A',
              integracaoFreteOuterRef: 'documents/int_frete/INT1',
              modalidade: '0',
              estado: 'checkFinalizado',
            },
          }),
        })
        .mockReturnValue(new Promise(() => {})); // int_frete read hangs
      h.dereferenceOuterRef.mockReturnValue({ __intRef: 'INT1' });

      const p = reprintCheckoutEtiqueta({
        db,
        pedidoId: 'PEDA',
        freightClient: {} as never,
        nfeClient: null,
        mercadoLivreClient: null,
        formato: 'pdf',
        ui,
        timeoutMs: 30_000,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      const res = await p;

      expect(res).toMatchObject({
        status: 'timeout',
        stage: 'resolver a integração de frete',
      });
      expect(h.emitirOuImprimirEtiqueta).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reprintCheckoutDanfe — bounded on the same terms as its twin', () => {
  it('returns a NAMED timeout when the NF-e lookup never settles', async () => {
    // Not a nice-to-have symmetry: this button shares `usePrintInFlight` with
    // the frete one and BOTH render `loading={printInFlight.inFlight}`, so a
    // stall here spins both and looks identical to the bug being hardened
    // against. Leaving it unbounded meant the operator could not tell which of
    // the two buttons they were protected on.
    vi.useFakeTimers();
    try {
      h.ensureNfeAprovada.mockReturnValue(new Promise(() => {})); // never settles

      const p = reprintCheckoutDanfe({
        db,
        nfeClient: {} as never,
        pedidoId: 'PEDA',
        formato: 'simplificadoPdf',
        timeoutMs: 30_000,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      const res = await p;

      expect(res).toMatchObject({ status: 'timeout', stage: 'carregar a NF-e' });
      // Nothing was printed — the deadline sits before the side effect.
      expect(h.printDanfeForCheckout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT bound the print itself, so a timeout can never double-print', async () => {
    // The invariant every deadline in this module rests on: each bounded stage
    // is BEFORE a side effect, so "timeout, then re-click" is safe. If a future
    // change wraps `printDanfeForCheckout` (or `freightClient.imprimir`), that
    // stops being true and a re-click prints twice.
    vi.useFakeTimers();
    try {
      h.ensureNfeAprovada.mockResolvedValue({ ok: true, nfeId: 'NFE1' });
      h.printDanfeForCheckout.mockReturnValue(new Promise(() => {})); // hangs

      let settled = false;
      void reprintCheckoutDanfe({
        db,
        nfeClient: {} as never,
        pedidoId: 'PEDA',
        formato: 'simplificadoPdf',
        timeoutMs: 1_000,
      }).then(() => (settled = true));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(h.printDanfeForCheckout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
