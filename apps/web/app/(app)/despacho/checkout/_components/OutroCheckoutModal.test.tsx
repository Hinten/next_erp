import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
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

function renderModal(row: OutroCheckoutRow | null) {
  return render(
    <MantineProvider>
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
    </MantineProvider>,
  );
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

  it('hides Reimprimir Frete when the checkout snapshot is sem frete (modalidade 9)', () => {
    renderModal(
      makeRow({
        frete: { modalidade: MODALIDADE_FRETE.semTransporte } as OutroCheckoutRow['frete'],
      }),
    );
    expect(screen.queryByRole('button', { name: /Reimprimir Frete/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Reimprimir NF-e/ })).toBeTruthy();
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
});
