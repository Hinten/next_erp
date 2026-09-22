import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

const { incidenteStub, guardState, notificationShow } = vi.hoisted(() => ({
  incidenteStub: {
    mounts: 0,
    unmounts: 0,
    flushResult: true,
    order: [] as string[],
  },
  guardState: { dirty: false },
  notificationShow: vi.fn(),
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: unknown) => ({ values, errors: {} }),
}));
vi.mock('@delfrance/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/ui')>()),
  useUnsavedChangesGuard: (dirty: boolean) => {
    guardState.dirty = dirty;
  },
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: notificationShow } }));

// PedidoForm pulls in every tab, the footer and the firebase/auth hooks. Stub
// them so these tests exercise the form shell, its tab lifecycle and save
// coordinator without mounting every domain editor at once.
vi.mock('./tabs', () => {
  const Empty = () => null;
  return {
    // Surfaces the seeded vendedor so the create-stamp below is observable
    // without rendering the real tab.
    PrincipalTab: ({ form }: { form: { getValues: (name: string) => unknown } }) =>
      `vendedor:${String(form.getValues('vendedorPedidoOuterRef'))}`,
    FiscalTab: () => <input aria-label="Rascunho fiscal" />,
    FreteTab: Empty,
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
vi.mock('./tabs/LazyIncidentesTab', async () => {
  const { useEffect, useState } = await import('react');

  return {
    LazyIncidentesTab: ({
      onDirtyChange,
      flushRef,
    }: {
      onDirtyChange?: (dirty: boolean) => void;
      flushRef?: { current: null | (() => Promise<boolean>) };
    }) => {
      const [draft, setDraft] = useState('');
      const [error, setError] = useState<string | null>(null);

      useEffect(() => {
        incidenteStub.mounts += 1;
        return () => {
          incidenteStub.unmounts += 1;
        };
      }, []);
      useEffect(() => {
        if (!flushRef) return;
        flushRef.current = async () => {
          incidenteStub.order.push('incidente');
          if (!incidenteStub.flushResult) {
            setError('Conflito no incidente');
            return false;
          }
          onDirtyChange?.(false);
          return true;
        };
        return () => {
          flushRef.current = null;
        };
      }, [flushRef, onDirtyChange]);

      return (
        <>
          <label>
            Rascunho incidente
            <input
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                onDirtyChange?.(true);
              }}
            />
          </label>
          {error}
        </>
      );
    },
  };
});
vi.mock('./PagamentosSection', () => ({ PagamentosSection: () => 'PagamentosSection' }));
vi.mock('./PedidoFooter', () => ({
  PedidoFooter: ({ onSaveAndContinue }: { onSaveAndContinue?: () => void }) => (
    <button type="button" onClick={onSaveAndContinue}>
      Salvar e continuar editando
    </button>
  ),
}));
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

beforeEach(() => {
  usuarioAtual = { uid: 'u-lucas', email: 'lucas@delfrance.com' };
  incidenteStub.mounts = 0;
  incidenteStub.unmounts = 0;
  incidenteStub.flushResult = true;
  incidenteStub.order = [];
  guardState.dirty = false;
  notificationShow.mockReset();
});

describe('PedidoForm — the vendedor is stamped on create, never on edit', () => {
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

describe('PedidoForm — persistent lazy Incidentes tab', () => {
  const existente = {
    ehSaida: true,
    integracaoPedidoOuterRef: 'documents/integracoes/int-1',
    itens: {
      'prod-1': [
        {
          produtoUid: 'prod-1',
          ordem: 1,
          sku: 'SKU-1',
          nomeDeVenda: 'Produto de teste',
          precoDeVenda: 10,
          descontoUnitario: 0,
          quantidade: 1,
          custo: null,
        },
      ],
    },
  } as unknown as Pedido;

  function renderEdit(onSubmit = vi.fn(async () => true)) {
    render(
      <MantineTestProvider>
        <PedidoForm defaultValues={existente} pedidoId="ped-1" ehSaida onSubmit={onSubmit} />
      </MantineTestProvider>,
    );
    return onSubmit;
  }

  it('does not mount before first activation, then preserves its state across tab changes', () => {
    renderEdit();
    expect(screen.queryByLabelText('Rascunho incidente')).toBeNull();
    expect(incidenteStub.mounts).toBe(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Incidentes' }));
    const incidenteInput = screen.getByLabelText('Rascunho incidente') as HTMLInputElement;
    fireEvent.change(incidenteInput, { target: { value: 'texto preservado' } });
    expect(guardState.dirty).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Fiscal' }));
    const fiscalInput = screen.getByLabelText('Rascunho fiscal') as HTMLInputElement;
    fireEvent.change(fiscalInput, { target: { value: 'será descartado' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Principal' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Fiscal' }));
    expect((screen.getByLabelText('Rascunho fiscal') as HTMLInputElement).value).toBe('');

    fireEvent.click(screen.getByRole('tab', { name: /^Incidentes/ }));
    expect((screen.getByLabelText('Rascunho incidente') as HTMLInputElement).value).toBe(
      'texto preservado',
    );
    expect(incidenteStub.mounts).toBe(1);
    expect(incidenteStub.unmounts).toBe(0);
  });

  it('flushes incidentes before the pedido and reports incident-only work as saved', async () => {
    const onSubmit = vi.fn(async () => {
      incidenteStub.order.push('pedido');
      return true;
    });
    renderEdit(onSubmit);
    fireEvent.click(screen.getByRole('tab', { name: 'Incidentes' }));
    fireEvent.change(screen.getByLabelText('Rascunho incidente'), {
      target: { value: 'pendente' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Principal' }));

    fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar editando' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(incidenteStub.order).toEqual(['incidente', 'pedido']);
    const submitArgs = onSubmit.mock.calls[0] as unknown as unknown[];
    expect(submitArgs[2]).toEqual({
      continueEditing: true,
      incidenteSaved: true,
    });
    expect(guardState.dirty).toBe(false);
  });

  it('validates the pedido before attempting the incidente flush', async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <MantineTestProvider>
        <PedidoForm
          defaultValues={{ ehSaida: true, itens: {} } as unknown as Pedido}
          pedidoId="ped-invalido"
          ehSaida
          onSubmit={onSubmit}
        />
      </MantineTestProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Incidentes' }));
    fireEvent.change(screen.getByLabelText('Rascunho incidente'), {
      target: { value: 'não deve salvar ainda' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar editando' }));

    await waitFor(() => expect(notificationShow).toHaveBeenCalled());
    expect(incidenteStub.order).toEqual([]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks the pedido save, reopens Incidentes and preserves its error when flush fails', async () => {
    incidenteStub.flushResult = false;
    const onSubmit = renderEdit();
    fireEvent.click(screen.getByRole('tab', { name: 'Incidentes' }));
    fireEvent.change(screen.getByLabelText('Rascunho incidente'), {
      target: { value: 'com conflito' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Principal' }));

    fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar editando' }));

    expect(await screen.findByText('Conflito no incidente')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /^Incidentes/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect((screen.getByLabelText('Rascunho incidente') as HTMLInputElement).value).toBe(
      'com conflito',
    );
  });

  it('warns when the incidente committed but the pedido save was rejected', async () => {
    const onSubmit = vi.fn(async () => false);
    renderEdit(onSubmit);
    fireEvent.click(screen.getByRole('tab', { name: 'Incidentes' }));
    fireEvent.change(screen.getByLabelText('Rascunho incidente'), {
      target: { value: 'salvo primeiro' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar editando' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Incidente salvo; pedido pendente', color: 'yellow' }),
    );
  });
});
