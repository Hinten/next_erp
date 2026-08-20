import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';

// Capture the direction filter the picker builds. `whereOp` is the operator the
// query uses to constrain `tipo`; asserting its arguments proves that an entrada
// only ever requests `tipo == 0` (entrada operations) and never saída ones.
const whereOp = vi.fn((..._args: unknown[]) => ({}));
vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown, _clauses: unknown[]) => base,
  orderByField: () => ({}),
  whereOp: (...args: unknown[]) => whereOp(...args),
}));
vi.mock('firebase/firestore', () => ({
  getDocs: vi.fn(async () => ({ docs: [] })),
}));
vi.mock('@/lib/data/operacaoCollection', () => ({
  operacaoCollection: { ref: () => ({}), resolvePath: () => 'operacao' },
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: () => null,
}));

// Import AFTER the mocks are registered.
import { OperacaoPicker } from './OperacaoPicker';

function renderPicker(ehSaida: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MantineTestProvider>
        <OperacaoPicker db={{} as Firestore} ehSaida={ehSaida} value={null} onChange={() => {}} />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
}

describe('OperacaoPicker — direction filter', () => {
  it('lists only entrada operations (tipo == 0) for an entrada', async () => {
    whereOp.mockClear();
    renderPicker(false);
    await waitFor(() => expect(whereOp).toHaveBeenCalledWith('tipo', '==', 0));
    // And never asks for saída operations.
    expect(whereOp).not.toHaveBeenCalledWith('tipo', '==', 1);
  });

  it('lists only saída operations (tipo == 1) for a saída', async () => {
    whereOp.mockClear();
    renderPicker(true);
    await waitFor(() => expect(whereOp).toHaveBeenCalledWith('tipo', '==', 1));
    expect(whereOp).not.toHaveBeenCalledWith('tipo', '==', 0);
  });
});
