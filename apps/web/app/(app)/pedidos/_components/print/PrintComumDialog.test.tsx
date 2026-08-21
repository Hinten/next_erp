import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

// Hoisted spy so we can assert whether the batch build was triggered.
const { buildSpy } = vi.hoisted(() => ({
  buildSpy: vi.fn((..._args: unknown[]) => new Promise<never>(() => {})),
}));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/pedido-print/batch', () => ({
  buildModelsInWaves: (...args: unknown[]) => buildSpy(...args),
  markPedidosPrinted: vi.fn(),
}));
vi.mock('react-to-print', () => ({ useReactToPrint: () => () => undefined }));

import { PrintComumDialog } from './PrintComumDialog';

function renderDialog(props: {
  opened: boolean;
  pedidoIds: string[];
  alreadyPrintedCount: number;
}) {
  return render(
    <MantineTestProvider>
      <PrintComumDialog {...props} onClose={() => undefined} />
    </MantineTestProvider>,
  );
}

describe('PrintComumDialog — already-printed guard', () => {
  it('asks for confirmation (and does not build yet) when some were already printed', () => {
    buildSpy.mockClear();
    renderDialog({ opened: true, pedidoIds: ['a', 'b'], alreadyPrintedCount: 1 });
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/já foi impresso/);
    expect(body).toContain('Imprimir mesmo assim');
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('builds directly when none were already printed', () => {
    buildSpy.mockClear();
    renderDialog({ opened: true, pedidoIds: ['a'], alreadyPrintedCount: 0 });
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });
});
