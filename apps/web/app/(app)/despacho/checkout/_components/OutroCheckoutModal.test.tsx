import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { MODALIDADE_FRETE } from '@delfrance/schemas';

import type { OutroCheckoutRow } from './useOutrosCheckouts';

// The reprint helpers do the real Firestore/print I/O — stub them so we can
// assert EXACTLY which pedido each reprint targets (the wrong-label-bug armor).
const h = vi.hoisted(() => ({
  reprintCheckoutEtiqueta: vi.fn(),
  reprintCheckoutDanfe: vi.fn(),
  showCopyableNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));
vi.mock('@/lib/checkout/reprintCheckout', () => ({
  reprintCheckoutEtiqueta: h.reprintCheckoutEtiqueta,
  reprintCheckoutDanfe: h.reprintCheckoutDanfe,
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showCopyableNotification: h.showCopyableNotification,
  showErrorNotification: h.showErrorNotification,
}));

import { OutroCheckoutModal } from './OutroCheckoutModal';

function makeRow(over: Partial<OutroCheckoutRow> = {}): OutroCheckoutRow {
  return {
    checkoutId: 'C1',
    pedidoId: 'PEDA',
    numero: 'NUM-A',
    timestampMs: 1000,
    obs: null,
    frete: { modalidade: MODALIDADE_FRETE.cif } as OutroCheckoutRow['frete'],
    itens: [],
    ...over,
  };
}

function modalTree(row: OutroCheckoutRow | null) {
  return (
    <MantineTestProvider>
      <OutroCheckoutModal
        row={row}
        onClose={() => {}}
        db={{} as never}
        nfeClient={null}
        freightClient={null}
        mercadoLivreClient={null}
        formatoDanfe="simplificadoPdf"
        formatoEtiqueta="pdf"
      />
    </MantineTestProvider>
  );
}

function renderModal(row: OutroCheckoutRow | null) {
  const utils = render(modalTree(row));
  return {
    ...utils,
    /**
     * Re-render the SAME component instance with a different row — `row={null}`
     * is the operator closing the reprint modal. One tree, so the two can't
     * drift apart.
     */
    rerenderWith: (next: OutroCheckoutRow | null) => utils.rerender(modalTree(next)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reprintCheckoutEtiqueta.mockResolvedValue({ status: 'opened' });
  h.reprintCheckoutDanfe.mockResolvedValue({ status: 'printed' });
});

describe("OutroCheckoutModal — reprints target the row's OWN pedido", () => {
  it('reprints the frete for exactly row.pedidoId with the selected format', async () => {
    renderModal(makeRow({ pedidoId: 'PEDA' }));
    fireEvent.click(screen.getByRole('button', { name: /Reimprimir Frete/ }));
    await waitFor(() => expect(h.reprintCheckoutEtiqueta).toHaveBeenCalledTimes(1));
    expect(h.reprintCheckoutEtiqueta).toHaveBeenCalledWith(
      expect.objectContaining({ pedidoId: 'PEDA', formato: 'pdf' }),
    );
    // An 'opened' outcome (label URL in a new tab) must not read as "sent to print".
    await waitFor(() =>
      expect(h.showCopyableNotification).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Etiqueta aberta em nova aba.' }),
      ),
    );
  });

  it('reprints the DANFE for exactly row.pedidoId (a different row → a different id)', async () => {
    renderModal(makeRow({ pedidoId: 'PEDB' }));
    fireEvent.click(screen.getByRole('button', { name: /Reimprimir NF-e/ }));
    await waitFor(() => expect(h.reprintCheckoutDanfe).toHaveBeenCalledTimes(1));
    expect(h.reprintCheckoutDanfe).toHaveBeenCalledWith(
      expect.objectContaining({ pedidoId: 'PEDB', formato: 'simplificadoPdf' }),
    );
  });

  /**
   * The user-visible half of the deadline work.
   *
   * ⚠️ These exist because the reporting path can fail SILENTLY: `reportEtiqueta`
   * / `reportDanfe` only fire a toast, so a missing `case` is invisible to both
   * `tsc` and lint (this repo enables no switch-exhaustiveness rule). Asserting
   * the returned `{status:'timeout'}` object — which the `reprintCheckout` unit
   * tests already do — proves nothing about whether the operator is told. A
   * timeout that produces no toast IS the "it froze" symptom, reached a
   * different way.
   */
  it('tells the operator WHICH stage timed out on the frete button', async () => {
    h.reprintCheckoutEtiqueta.mockResolvedValue({
      status: 'timeout',
      stage: 'carregar o pedido',
      message: 'A etapa "carregar o pedido" não respondeu em 30s.',
    });
    renderModal(makeRow({ pedidoId: 'PEDA' }));
    fireEvent.click(screen.getByRole('button', { name: /Reimprimir Frete/ }));

    await waitFor(() =>
      expect(h.showErrorNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Etiqueta',
          // The stage name is the payload — a bare "timed out" would be no
          // better than the spinner it replaced.
          message: expect.stringContaining('carregar o pedido'),
        }),
      ),
    );
    expect(h.showCopyableNotification).not.toHaveBeenCalled();
  });

  it('tells the operator WHICH stage timed out on the NF-e button too', async () => {
    // The sibling shares `usePrintInFlight`, so an unreported stall here spins
    // BOTH buttons — the asymmetry a review caught in the first draft.
    h.reprintCheckoutDanfe.mockResolvedValue({
      status: 'timeout',
      stage: 'carregar a NF-e',
      message: 'A etapa "carregar a NF-e" não respondeu em 30s.',
    });
    renderModal(makeRow({ pedidoId: 'PEDB' }));
    fireEvent.click(screen.getByRole('button', { name: /Reimprimir NF-e/ }));

    await waitFor(() =>
      expect(h.showErrorNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'NF-e',
          message: expect.stringContaining('carregar a NF-e'),
        }),
      ),
    );
    expect(h.showCopyableNotification).not.toHaveBeenCalled();
  });

  it('releases the print mutex after a timeout, so the operator can retry', async () => {
    // The wedge is the actual harm: a timeout that left `inFlight` true would
    // produce the toast AND keep both buttons disabled — still no way forward.
    h.reprintCheckoutEtiqueta.mockResolvedValue({
      status: 'timeout',
      stage: 'carregar o pedido',
      message: 'A etapa "carregar o pedido" não respondeu em 30s.',
    });
    renderModal(makeRow());
    const btn = screen.getByRole('button', { name: /Reimprimir Frete/ });

    fireEvent.click(btn);
    await waitFor(() => expect(h.reprintCheckoutEtiqueta).toHaveBeenCalledTimes(1));
    fireEvent.click(btn);
    await waitFor(() => expect(h.reprintCheckoutEtiqueta).toHaveBeenCalledTimes(2));
  });

  it('hides Reimprimir Frete when the checkout snapshot is sem frete (modalidade 9)', () => {
    renderModal(
      makeRow({
        frete: { modalidade: MODALIDADE_FRETE.semTransporte } as OutroCheckoutRow['frete'],
      }),
    );
    expect(screen.queryByRole('button', { name: /Reimprimir Frete/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Reimprimir NF-e/ })).toBeTruthy();
  });

  /**
   * `row.frete` is TYPED `FreteDoPedido`, so the compiler is no help here: the
   * value comes through `parseSoftRead`, which returns the RAW document on a
   * schema mismatch, so a checkout doc stored without
   * `freteNoMomentoDoCheckout` reaches this component as `undefined`. Before
   * the `?.` guard this render threw, and `apps/web` has no `error.tsx` — the
   * whole despacho page went down, not just the modal.
   */
  it('survives an unreadable frete snapshot and KEEPS the reprint offered', () => {
    renderModal(makeRow({ frete: undefined as unknown as OutroCheckoutRow['frete'] }));

    // Rendered at all — the regression was a TypeError, not a wrong label.
    expect(screen.getByRole('button', { name: /Reimprimir NF-e/ })).toBeTruthy();
    // Still offered: the snapshot is display + sem-frete gate only, and the
    // reprint re-fetches the pedido's LIVE frete. An unreadable snapshot is not
    // evidence of "sem frete", so it must not silently disable the button.
    expect(screen.getByRole('button', { name: /Reimprimir Frete/ })).toBeTruthy();
  });

  it('drops a second reprint click while the first is still in flight', async () => {
    let resolveFirst!: () => void;
    h.reprintCheckoutEtiqueta.mockImplementation(
      () =>
        new Promise<{ status: string }>((r) => {
          resolveFirst = () => r({ status: 'opened' });
        }),
    );
    renderModal(makeRow());
    const btn = screen.getByRole('button', { name: /Reimprimir Frete/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(h.reprintCheckoutEtiqueta).toHaveBeenCalledTimes(1);
    resolveFirst();
    await waitFor(() => expect(h.reprintCheckoutEtiqueta).toHaveBeenCalledTimes(1));
  });

  it('keeps a pending confirm answerable after the modal closes, so the print mutex releases', async () => {
    // Before #1096, confirm.element was nested inside the <Modal>, so closing
    // the parent modal unmounted it. keepMounted defaults to false, so the
    // stored resolve never fired, and printInFlight.run's finally block never
    // ran — leaving the print mutex wedged for the life of the pane. Both
    // reprint buttons would spin forever.
    h.reprintCheckoutEtiqueta.mockImplementation(
      async (args: { ui: { confirmRisk: (msg: string) => Promise<boolean> } }) => {
        const ok = await args.ui.confirmRisk('etiqueta já postada — reimprimir?');
        return { status: ok ? 'printed' : 'skipped' };
      },
    );

    const { rerenderWith } = renderModal(makeRow());
    fireEvent.click(screen.getByRole('button', { name: /Reimprimir Frete/ }));
    await waitFor(() => expect(screen.getByText(/já postada/)).toBeTruthy());

    // The operator closes the reprint modal while the risk confirm is still open.
    rerenderWith(null);

    // The confirm dialog must STILL be in the document so the operator can
    // still answer it.
    expect(screen.queryByText(/já postada/)).not.toBeNull();

    // …and answering it must actually SETTLE the promise — mounted-but-dead is
    // the same wedge. Only a resolved `confirmRisk` lets reprintCheckoutEtiqueta
    // return, which is what runs printInFlight.run's `finally`; reportEtiqueta's
    // `printed` arm fires strictly after that, so this toast IS the mutex
    // releasing. Asserting DOM presence alone would stay green if `settle` ever
    // broke.
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() =>
      expect(h.showCopyableNotification).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Etiqueta enviada para impressão.' }),
      ),
    );
  });
});
