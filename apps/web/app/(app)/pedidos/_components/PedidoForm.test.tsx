import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

/** The props PedidoForm hands the (lazy) Link Pgto tab — what the stub below records. */
interface LinkStubProps {
  pedidoId: string;
  pedido: unknown;
  estado: string;
  formDirty: boolean;
  fromCache: boolean;
  nfeEstado: string | null;
  nfeCarregando: boolean;
}

const { incidenteStub, linkStub, nfeSnap, guardState, notificationShow } = vi.hoisted(() => ({
  incidenteStub: {
    mounts: 0,
    unmounts: 0,
    flushResult: true,
    order: [] as string[],
  },
  // The Link Pgto lazy stub: mount/unmount counts prove it stays mounted across
  // tab switches, `lastProps` is what the form passed on its latest render.
  linkStub: {
    mounts: 0,
    unmounts: 0,
    lastProps: null as LinkStubProps | null,
  },
  // What the (only) `useSnapshot` in PedidoForm — the NF-e lock query — returns.
  nfeSnap: { data: undefined as unknown, loading: false },
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
    // without rendering the real tab. It also gets the REAL `form` (the props
    // PedidoForm hands the real tab), so the button can dirty it through
    // react-hook-form — the only thing that moves `formState.isDirty`.
    PrincipalTab: ({
      form,
    }: {
      form: {
        getValues: (name: string) => unknown;
        setValue: (name: string, value: unknown, options?: { shouldDirty?: boolean }) => void;
      };
    }) => (
      <>
        <span>{`vendedor:${String(form.getValues('vendedorPedidoOuterRef'))}`}</span>
        <button
          type="button"
          onClick={() => form.setValue('infCpl', 'texto', { shouldDirty: true })}
        >
          Sujar o formulário
        </button>
      </>
    ),
    // A bare uncontrolled input: it proves an ordinary tab UNMOUNTS on a switch.
    // It is NOT registered with react-hook-form, so typing in it never dirties
    // the form — do not use it to assert anything about `formState.isDirty`.
    FiscalTab: () => <input aria-label="Rascunho fiscal" />,
    FreteTab: Empty,
    DevolucaoTab: Empty,
    CheckoutTab: Empty,
    EstadoHistoricoTab: Empty,
    EstoqueSyncTab: Empty,
    ModificacoesTab: Empty,
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
// The Link Pgto tab is lazy AND keepMounted, so it is mocked at its own module
// (like Incidentes above) — the './tabs' barrel mock would not cover it. The stub
// records the props PedidoForm passes and holds a local draft, so a tab switch
// that unmounted it would visibly lose what was typed.
vi.mock('./tabs/LazyLinkPagamentoTab', async () => {
  const { useEffect, useState } = await import('react');

  return {
    LazyLinkPagamentoTab: (props: LinkStubProps) => {
      const [draft, setDraft] = useState('');

      useEffect(() => {
        linkStub.mounts += 1;
        return () => {
          linkStub.unmounts += 1;
        };
      }, []);
      // No deps on purpose: record the props of EVERY render.
      useEffect(() => {
        linkStub.lastProps = props;
      });

      return (
        <label>
          Rascunho vaquinha
          <input value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
        </label>
      );
    },
  };
});
// Exposes the `disabled` PedidoForm computes from the NF-e lock, so the switch to
// the shared `pagamentosTravadosPorNFe` predicate is observable end to end.
vi.mock('./PagamentosSection', () => ({
  PagamentosSection: ({ disabled }: { disabled?: boolean }) => (
    <span data-testid="pagamentos-section" data-disabled={String(disabled)}>
      PagamentosSection
    </span>
  ),
}));
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
  useSnapshot: () => ({ data: nfeSnap.data, loading: nfeSnap.loading, error: undefined }),
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
import {
  ESTADO_NFE,
  ESTADO_PEDIDO,
  type EstadoNFe,
  type EstadoPedido,
  type Pedido,
} from '@delfrance/schemas';
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
  linkStub.mounts = 0;
  linkStub.unmounts = 0;
  linkStub.lastProps = null;
  nfeSnap.data = undefined;
  nfeSnap.loading = false;
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

/** A saved saída pedido as the edit page hands it over: the LIVE snapshot doc. */
function pedidoSalvo(overrides: Record<string, unknown> = {}): Pedido {
  return {
    ehSaida: true,
    numero: '1234',
    valorCobrado: 100,
    itens: {},
    ...overrides,
  } as unknown as Pedido;
}

function renderEditForm(
  options: { defaults?: Pedido; liveEstado?: EstadoPedido; fromCache?: boolean } = {},
) {
  const defaults = options.defaults ?? pedidoSalvo();
  render(
    <MantineTestProvider>
      <PedidoForm
        defaultValues={defaults}
        pedidoId="ped-1"
        liveEstado={options.liveEstado}
        fromCache={options.fromCache}
        onSubmit={async () => {}}
      />
    </MantineTestProvider>,
  );
  return defaults;
}

describe('PedidoForm — Link Pgto tab in create mode', () => {
  it('shows the save-first hint, not the placeholder, and mounts no editor', () => {
    renderCreateForm(true);
    // Create mode has no draft to keep, so the panel is an ordinary one: it does
    // not exist until the tab is opened. That makes the assertion below about the
    // click, not about a hidden node that was always in the DOM.
    expect(screen.queryByText('Salve o pedido para gerar links de pagamento.')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Link Pgto' }));

    expect(screen.getByText('Salve o pedido para gerar links de pagamento.')).toBeTruthy();
    // The old, wrong "coming soon / use the legacy app" copy must be gone.
    expect(screen.queryByText(/em breve/i)).toBeNull();
    expect(screen.queryByText(/app antigo/i)).toBeNull();
    // And the editor needs a saved pedidoId: it is neither mounted nor even loaded.
    expect(screen.queryByLabelText('Rascunho vaquinha')).toBeNull();
    expect(linkStub.mounts).toBe(0);
  });

  it('has no Link Pgto tab on an entrada — a payment link is a sale-side flow', () => {
    renderCreateForm(false);
    expect(screen.queryByRole('tab', { name: 'Link Pgto' })).toBeNull();
  });
});

describe('PedidoForm — Link Pgto tab in edit mode', () => {
  it('stays unloaded until the tab is first opened', () => {
    renderEditForm();

    expect(screen.getByRole('tab', { name: 'Link Pgto' })).toBeTruthy();
    expect(screen.queryByLabelText('Rascunho vaquinha')).toBeNull();
    expect(linkStub.mounts).toBe(0);
    expect(linkStub.lastProps).toBeNull();
  });

  it('hands the tab the LIVE doc, the estado and the NF-e state', () => {
    nfeSnap.data = [{ data: { estado: ESTADO_NFE.aprovada } }];
    const doc = renderEditForm({ liveEstado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento });

    fireEvent.click(screen.getByRole('tab', { name: 'Link Pgto' }));

    expect(screen.getByLabelText('Rascunho vaquinha')).toBeTruthy();
    expect(screen.queryByText('Salve o pedido para gerar links de pagamento.')).toBeNull();
    expect(linkStub.lastProps).toMatchObject({
      pedidoId: 'ped-1',
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      nfeEstado: ESTADO_NFE.aprovada,
      nfeCarregando: false,
      fromCache: false,
      formDirty: false,
    });
    // The SAME object the page snapshot supplied — never a copy rebuilt from
    // `form.getValues`, which is only the loaded (possibly stale) values.
    expect(linkStub.lastProps?.pedido).toBe(doc);
  });

  it('reports the NF-e snapshot still resolving as nfeCarregando', () => {
    nfeSnap.loading = true;
    renderEditForm();

    fireEvent.click(screen.getByRole('tab', { name: 'Link Pgto' }));

    expect(linkStub.lastProps).toMatchObject({ nfeCarregando: true, nfeEstado: null });
  });

  it('forwards the page snapshot fromCache flag', () => {
    renderEditForm({ fromCache: true });

    fireEvent.click(screen.getByRole('tab', { name: 'Link Pgto' }));

    expect(linkStub.lastProps?.fromCache).toBe(true);
  });

  it('flips formDirty once the form is edited through react-hook-form', async () => {
    renderEditForm();
    fireEvent.click(screen.getByRole('tab', { name: 'Link Pgto' }));
    expect(linkStub.lastProps?.formDirty).toBe(false);

    // The tab stays mounted while another one is active, so it keeps receiving
    // props: dirty the form from the Principal stub (which gets the real `form`).
    fireEvent.click(screen.getByRole('tab', { name: 'Principal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sujar o formulário' }));

    await waitFor(() => expect(linkStub.lastProps?.formDirty).toBe(true));
    expect(guardState.dirty).toBe(true);
  });

  it('keeps the tab mounted, draft included, across tab switches', () => {
    renderEditForm();
    fireEvent.click(screen.getByRole('tab', { name: 'Link Pgto' }));
    fireEvent.change(screen.getByLabelText('Rascunho vaquinha'), {
      target: { value: '3 pessoas' },
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Pagamento' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Link Pgto' }));

    expect((screen.getByLabelText('Rascunho vaquinha') as HTMLInputElement).value).toBe(
      '3 pessoas',
    );
    expect(linkStub.mounts).toBe(1);
    expect(linkStub.unmounts).toBe(0);
    // The two lazy tabs latch independently: opening one never loads the other.
    expect(incidenteStub.mounts).toBe(0);
  });

  it('has no Link Pgto tab on a saved entrada', () => {
    renderEditForm({ defaults: pedidoSalvo({ ehSaida: false }) });

    expect(screen.queryByRole('tab', { name: 'Link Pgto' })).toBeNull();
  });
});

describe('PedidoForm — Pagamento lock follows the shared NF-e predicate', () => {
  // The rule moved from an inline expression to `pagamentosTravadosPorNFe`
  // (schemas), which the Link Pgto tab and the server gate share — so the Pagamento
  // tab must lock in exactly the cases it always did.
  it.each<[string, EstadoNFe | null, EstadoPedido, boolean]>([
    ['no NF-e never locks', null, ESTADO_PEDIDO.pago, false],
    [
      'an aprovada NF-e locks outside the carve-out estados',
      ESTADO_NFE.aprovada,
      ESTADO_PEDIDO.pago,
      true,
    ],
    [
      'an aprovada NF-e still allows aguardandoConfirmacaoDePagamento',
      ESTADO_NFE.aprovada,
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      false,
    ],
    [
      'a cancelada NF-e locks even in a carve-out estado',
      ESTADO_NFE.cancelada,
      ESTADO_PEDIDO.iniciado,
      true,
    ],
    [
      'an inutilizada numeração locks even in a carve-out estado',
      ESTADO_NFE.numeracaoInutilizada,
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      true,
    ],
    ['a rejeitada NF-e does not lock', ESTADO_NFE.rejeitada, ESTADO_PEDIDO.pago, false],
  ])('%s', (_label, nfeEstado, estado, locked) => {
    nfeSnap.data = nfeEstado ? [{ data: { estado: nfeEstado } }] : undefined;
    renderEditForm({ liveEstado: estado });

    fireEvent.click(screen.getByRole('tab', { name: 'Pagamento' }));

    expect(screen.getByTestId('pagamentos-section').getAttribute('data-disabled')).toBe(
      String(locked),
    );
  });

  it('locks while the NF-e snapshot is still resolving (default-deny)', () => {
    nfeSnap.loading = true;
    renderEditForm({ liveEstado: ESTADO_PEDIDO.iniciado });

    fireEvent.click(screen.getByRole('tab', { name: 'Pagamento' }));

    expect(screen.getByTestId('pagamentos-section').getAttribute('data-disabled')).toBe('true');
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

  it('flushes incidentes from an invalid pedido but keeps the pedido blocked', async () => {
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
      target: { value: 'deve salvar mesmo assim' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar editando' }));

    await waitFor(() => expect(incidenteStub.order).toEqual(['incidente']));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Incidente salvo; pedido inválido', color: 'yellow' }),
    );
    expect(notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'red', message: expect.stringContaining('Principal') }),
    );
  });

  it('prioritizes an incidente conflict even when the pedido is invalid', async () => {
    incidenteStub.flushResult = false;
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
      target: { value: 'com conflito' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Principal' }));

    fireEvent.click(screen.getByRole('button', { name: 'Salvar e continuar editando' }));

    expect(await screen.findByText('Conflito no incidente')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: /^Incidentes/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Incidente não salvo', color: 'red' }),
    );
    expect(notificationShow).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Incidente salvo; pedido inválido' }),
    );
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
