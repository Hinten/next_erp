import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

// PedidoForm pulls in every tab, the footer and the firebase/auth hooks. Stub
// them so the render is just the form shell — enough to assert the Pagamento
// panel's create-mode empty state in isolation. String-returning stubs keep the
// mock factories JSX-free (they hoist above imports).
vi.mock('./tabs', () => {
  const Empty = () => null;
  return {
    PrincipalTab: Empty,
    FiscalTab: Empty,
    FreteTab: Empty,
    IncidentesTab: Empty,
    DevolucaoTab: Empty,
    CheckoutTab: Empty,
    EstadoHistoricoTab: Empty,
    EstoqueSyncTab: Empty,
    // Mirror the REAL PlaceholderTab copy so that if the Pagamento panel ever
    // regresses to `<PlaceholderTab name="Pagamento" />`, the "em breve" / "app
    // antigo" wording reappears and the assertions below fail.
    PlaceholderTab: ({ name }: { name: string }) =>
      `${name} — em breve. Use o app antigo para editar este bloco.`,
  };
});
vi.mock('./PagamentosSection', () => ({ PagamentosSection: () => 'PagamentosSection' }));
vi.mock('./PedidoFooter', () => ({ PedidoFooter: () => 'PedidoFooter' }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/auth', () => ({ usePermission: () => ({ allowed: true, loading: false }) }));
vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
}));

// Import AFTER the mocks are registered.
import { PedidoForm } from './PedidoForm';

function renderCreateForm(ehSaida: boolean) {
  return render(
    <MantineProvider>
      <PedidoForm ehSaida={ehSaida} onSubmit={async () => {}} />
    </MantineProvider>,
  );
}

describe('PedidoForm — Pagamento tab in create mode', () => {
  // The same shared form backs both directions (pedido / entrada), so the
  // create-mode hint must be correct for each — "tanto no pedido quanto na
  // entrada".
  it.each([
    ['saída (pedido)', true],
    ['entrada', false],
  ] as const)('shows the save-first hint, not the placeholder, on a %s', (_label, ehSaida) => {
    renderCreateForm(ehSaida);
    // keepMounted={false}: only the active panel mounts, so activate Pagamento.
    fireEvent.click(screen.getByRole('tab', { name: 'Pagamento' }));

    // Payments are ported — the hint explains they unlock once the doc is saved
    // (the subcollection is keyed by pedidoId), it does not claim the feature is
    // unbuilt.
    expect(screen.getByText('Salve o pedido para registrar pagamentos.')).toBeTruthy();
    // The old, wrong "coming soon / use the legacy app" copy must be gone.
    expect(screen.queryByText(/em breve/i)).toBeNull();
    expect(screen.queryByText(/app antigo/i)).toBeNull();
    // And it must not prematurely mount the real editor (needs a saved pedidoId).
    expect(screen.queryByText('PagamentosSection')).toBeNull();
  });
});
