import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

// PedidoForm pulls in every tab, the footer and the firebase/auth hooks. Stub
// them so the render is just the form shell — enough to assert the Pagamento
// panel's create-mode empty state in isolation. String-returning stubs keep the
// mock factories JSX-free (they hoist above imports).
vi.mock('./tabs', () => {
  const Empty = () => null;
  return {
    // Surfaces the seeded vendedor so the create-stamp below is observable
    // without rendering the real tab.
    PrincipalTab: ({ form }: { form: { getValues: (name: string) => unknown } }) =>
      `vendedor:${String(form.getValues('vendedorPedidoOuterRef'))}`,
    FiscalTab: Empty,
    FreteTab: Empty,
    IncidentesTab: Empty,
    DevolucaoTab: Empty,
    CheckoutTab: Empty,
    EstadoHistoricoTab: Empty,
    EstoqueSyncTab: Empty,
    ModificacoesTab: Empty,
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
let usuarioAtual: { uid: string; email: string } | null = null;
vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: usuarioAtual }) }));
vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: undefined, loading: false, error: undefined }),
}));
// Edit mode builds the NF-e lock query against the (stubbed) Firestore handle.
// The result is never read — `useSnapshot` is stubbed above — it only has to be
// constructible. Everything else in the package stays real.
vi.mock('@/lib/data/nfeCollection', () => ({ nfeCollection: { ref: () => ({}) } }));
vi.mock('@delfrance/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data')>()),
  buildQuery: () => ({}),
}));

// Import AFTER the mocks are registered.
import type { Pedido } from '@delfrance/schemas';
import { PedidoForm } from './PedidoForm';

function renderCreateForm(ehSaida: boolean) {
  return render(
    <MantineTestProvider>
      <PedidoForm ehSaida={ehSaida} onSubmit={async () => {}} />
    </MantineTestProvider>,
  );
}

describe('PedidoForm — the vendedor is stamped on create, never on edit', () => {
  beforeEach(() => {
    usuarioAtual = { uid: 'u-lucas', email: 'lucas@delfrance.com' };
  });

  // Until this seed landed, `createPedidoWithNumero` wrote `values` verbatim
  // with a null vendedor while the screen showed the operator's email — so a
  // pedido created here recorded no seller at all and the print sheet had no
  // line to render.
  it('seeds the logged-in user on a plain create', () => {
    renderCreateForm(true);
    expect(screen.getByText('vendedor:documents/usuarios/u-lucas')).toBeTruthy();
  });

  // The anchored negative, and the reported bug: opening someone else's pedido
  // must not reattribute it to whoever happened to look at it.
  it('leaves a loaded pedido bound to its own vendedor', () => {
    const existente = {
      ehSaida: true,
      vendedorPedidoOuterRef: 'documents/usuarios/u-maria',
      itens: {},
    } as unknown as Pedido;

    render(
      <MantineTestProvider>
        <PedidoForm defaultValues={existente} pedidoId="ped-1" ehSaida onSubmit={async () => {}} />
      </MantineTestProvider>,
    );

    expect(screen.getByText('vendedor:documents/usuarios/u-maria')).toBeTruthy();
    expect(screen.queryByText('vendedor:documents/usuarios/u-lucas')).toBeNull();
  });

  // A Duplicar / Devolução seed already carries its own vendedor and arrives
  // through `defaultValues`, so the create branch must not overwrite it either.
  it('leaves a create SEED bound to the vendedor it arrived with', () => {
    const semente = {
      ehSaida: true,
      vendedorPedidoOuterRef: 'documents/usuarios/u-maria',
      itens: {},
    } as unknown as Pedido;

    render(
      <MantineTestProvider>
        <PedidoForm defaultValues={semente} ehSaida onSubmit={async () => {}} />
      </MantineTestProvider>,
    );

    expect(screen.getByText('vendedor:documents/usuarios/u-maria')).toBeTruthy();
  });
});

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
