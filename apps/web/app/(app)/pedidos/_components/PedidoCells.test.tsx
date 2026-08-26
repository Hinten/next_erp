import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import { ESTADO_NFE } from '@delfrance/schemas';
import type { NotaFiscalEletronica, Pedido } from '@delfrance/schemas';

// Hoisted, mutable state objects so each test can swap the value the mocked
// hooks return before re-rendering. Mirrors the pattern in
// `packages/ui/src/table/TableView.test.tsx`.
const { intersecting, observeRef, snapState, queryState, dereferenceMock } = vi.hoisted(() => ({
  // NFCell's listener is gated on the row being on screen (#1216). These tests
  // are about what the cell RENDERS, so the row is on screen by default; the
  // gate itself is proved in `useLatestNfe.test.ts`.
  intersecting: { current: true },
  // The observer's ref callback. Spied so one test can prove it actually
  // reaches a DOM node — see 'attaches the intersection ref'.
  observeRef: vi.fn(),
  snapState: {
    current: {
      data: undefined,
      loading: true,
      error: undefined,
    } as SnapshotState<SnapshotRow<NotaFiscalEletronica>[]>,
  },
  queryState: {
    current: {
      // Shared by every `useQuery` call site the mocked hook stands in for:
      // `ClienteCell`'s cliente doc (an object) and the `intFreteTipo` lookup
      // `FreteCell`/`EtiquetaRowAction` both make (a bare tipo string).
      data: null as
        | { nome?: string | null; cpf_cnpj?: string | null; tipo?: string | null }
        | string
        | null,
      isLoading: false,
    },
  },
  // The ClienteCell calls `dereferenceOuterRef` once with the pedido's
  // outer ref; the test toggles its return shape between a fake doc ref
  // and `null` to exercise the "Anônimo" branch.
  dereferenceMock: vi.fn(),
}));

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
}));

vi.mock('@/lib/data/nfeCollection', () => ({
  nfeCollection: { ref: () => ({ __nfeRef: true }) },
}));

vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (...args: unknown[]) => dereferenceMock(...args),
}));

vi.mock('@delfrance/data', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data')>('@delfrance/data');
  return {
    ...actual,
    // The hook is mocked too, so the returned object only needs a stable
    // identity for the useMemo dep array.
    buildQuery: () => ({ __fakeQuery: true }),
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
  };
});

vi.mock('@mantine/hooks', async () => {
  const actual = await vi.importActual<typeof import('@mantine/hooks')>('@mantine/hooks');
  return {
    ...actual,
    // jsdom cannot drive a real IntersectionObserver, so stand in for the
    // observed state. `vitest.setup.ts` shims the constructor for everything
    // else that touches it.
    useIntersection: () => ({
      ref: observeRef,
      entry: { isIntersecting: intersecting.current } as unknown as IntersectionObserverEntry,
    }),
  };
});

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useSnapshot: () => snapState.current };
});

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { ...actual, useQuery: () => queryState.current };
});

// firebase/firestore.getDoc is wrapped by the mocked useQuery, but the
// component still imports it at module-load. Stub it so the import resolves.
vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return { ...actual, getDoc: vi.fn() };
});

// NFCell's "Cancelar NF-e" button redirects via useRouter — stub next/navigation
// so the cell renders outside a Next router context.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { ClienteCell, FreteCell, ImpCell, NFCell, VlrCell } from './PedidoCells';
import { __resetLatestNfeMemo } from './useLatestNfe';

function wrap(node: React.ReactNode) {
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

/** Build a fully-typed NFe doc with the given estado + overrides. */
function makeNFe(
  estado: NotaFiscalEletronica['estado'],
  overrides: Partial<NotaFiscalEletronica> = {},
): NotaFiscalEletronica {
  return {
    numeracao: 1,
    serie: 1,
    tpEmis: 1,
    estado,
    chave: null,
    idLote: null,
    infNFe: null,
    xml_nfe_proc: null,
    xml_epec_proc: null,
    xml_assinado: null,
    nRec: null,
    retries: null,
    proximaConsultaEm: null,
    cStat: null,
    xMotivo: null,
    cMsg: null,
    xMsg: null,
    data_emissao: null,
    data_autorizacao: null,
    dataContingencia: null,
    justificativaContingencia: null,
    error: null,
    ultima_modificacao: null,
    ...overrides,
  };
}

function rowFromNFe(nfe: NotaFiscalEletronica): SnapshotRow<NotaFiscalEletronica> {
  return { id: 'nfe-1', path: 'pedidos/p1/nfev4/nfe-1', data: nfe };
}

function setSnap(state: Partial<SnapshotState<SnapshotRow<NotaFiscalEletronica>[]>>) {
  snapState.current = {
    data: undefined,
    loading: false,
    error: undefined,
    ...state,
  };
}

describe('NFCell — Firestore snapshot-driven cell', () => {
  beforeEach(() => {
    intersecting.current = true;
    observeRef.mockClear();
    // The memo is module state keyed by pedidoId, so it survives `cleanup()`
    // and would otherwise leak one test's badge into the next (every case here
    // uses "p1").
    __resetLatestNfeMemo();
  });

  it.each<[string, () => void]>([
    ['unresolved', () => setSnap({ loading: true })],
    ['no NF-e', () => setSnap({ data: [] })],
    ['a badge', () => setSnap({ data: [rowFromNFe(makeNFe(ESTADO_NFE.aprovada))] })],
  ])('attaches the intersection ref to a real DOM node while rendering %s', (_label, arrange) => {
    // Load-bearing, and invisible to every other test here: if the wrapper
    // stopped forwarding `ref` (or rendered nothing in a branch), the observer
    // would never observe, `isIntersecting` would never fire, and EVERY badge
    // would stay unresolved forever — while the mocked-hook tests all still
    // passed. Assert the element reaches the callback in all three branches.
    arrange();
    wrap(<NFCell pedidoId="p1" />);
    const attached = observeRef.mock.calls.map(([el]) => el).filter(Boolean);
    expect(attached.length).toBeGreaterThan(0);
    expect(attached[0]).toBeInstanceOf(HTMLElement);
  });

  afterEach(() => {
    setSnap({ data: undefined, loading: true });
  });

  it('shows a skeleton while the snapshot is loading', () => {
    setSnap({ loading: true });
    const { container } = wrap(<NFCell pedidoId="p1" />);
    expect(container.querySelector('[class*="Skeleton"]')).toBeTruthy();
  });

  it('shows a placeholder, NOT the no-NF-e dash, while the row is off screen', () => {
    // The distinction is load-bearing: an off-screen row has no listener, and
    // rendering DASH there would assert the pedido has no nota fiscal.
    intersecting.current = false;
    setSnap({ data: undefined, loading: false });
    const { container } = wrap(<NFCell pedidoId="p1" />);
    expect(container.querySelector('[class*="Skeleton"]')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('renders DASH when no NFe doc exists', () => {
    setSnap({ data: [] });
    wrap(<NFCell pedidoId="p1" />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  // Sanity-check every estado renders its PT-BR label from ESTADO_NFE_LABELS.
  it.each<[NotaFiscalEletronica['estado'], string]>([
    [ESTADO_NFE.gerado, 'Gerado'],
    [ESTADO_NFE.enviando, 'Enviando'],
    [ESTADO_NFE.aguardandoResposta, 'Aguardando resposta'],
    [ESTADO_NFE.processamentoCompleto, 'Processamento completo'],
    [ESTADO_NFE.processamentoCancelado, 'Processamento cancelado'],
    [ESTADO_NFE.aprovada, 'Aprovada'],
    [ESTADO_NFE.epecAprovado, 'EPEC aprovado'],
    [ESTADO_NFE.rejeitada, 'Rejeitada'],
    [ESTADO_NFE.cancelada, 'Cancelada'],
    [ESTADO_NFE.numeracaoInutilizada, 'Numeração inutilizada'],
    [ESTADO_NFE.error, 'Erro'],
  ])('renders the %s estado as a badge with label "%s"', (estado, label) => {
    setSnap({ data: [rowFromNFe(makeNFe(estado))] });
    wrap(<NFCell pedidoId="p1" />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('updates the badge text when the snapshot mutates (no remount)', () => {
    // The load-bearing assertion for the listener-per-row design: when
    // useSnapshot's state changes (which `onSnapshot` will do in
    // production as SEFAZ replies update the NFe doc), the cell re-renders
    // with the new estado without unmounting / remounting.
    setSnap({ data: [rowFromNFe(makeNFe(ESTADO_NFE.gerado))] });
    const { rerender } = wrap(<NFCell pedidoId="p1" />);
    expect(screen.getByText('Gerado')).toBeTruthy();

    act(() => {
      setSnap({ data: [rowFromNFe(makeNFe(ESTADO_NFE.aprovada, { chave: '3'.repeat(44) }))] });
    });
    rerender(
      <MantineTestProvider>
        <NFCell pedidoId="p1" />
      </MantineTestProvider>,
    );
    expect(screen.getByText('Aprovada')).toBeTruthy();
    expect(screen.queryByText('Gerado')).toBeNull();

    act(() => {
      setSnap({
        data: [rowFromNFe(makeNFe(ESTADO_NFE.rejeitada, { xMotivo: 'cliente sem IE' }))],
      });
    });
    rerender(
      <MantineTestProvider>
        <NFCell pedidoId="p1" />
      </MantineTestProvider>,
    );
    expect(screen.getByText('Rejeitada')).toBeTruthy();
  });

  it('uses outline variant when tpEmis indicates contingência', () => {
    // tpEmis === 1 is normal; anything else (2 EPEC, 9 SVC-RS, etc.) is
    // contingency emission. The cell switches to `variant="outline"` so
    // operators can spot the rare case at a glance.
    setSnap({ data: [rowFromNFe(makeNFe(ESTADO_NFE.aprovada, { tpEmis: 9 }))] });
    const { container } = wrap(<NFCell pedidoId="p1" />);
    // Mantine encodes the variant on a data attribute on the Badge root.
    const badge = container.querySelector('[data-variant="outline"]');
    expect(badge).toBeTruthy();
  });

  describe('HoverCard dropdown — cStat / xMotivo / copy buttons', () => {
    // jsdom does not implement navigator.clipboard. Mantine's CopyButton
    // calls `navigator.clipboard.writeText(value)`, so each test installs
    // a fresh mock and the assertions verify the call arguments.
    let writeText: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
        writable: true,
      });
    });

    it('shows cStat and xMotivo on hover regardless of estado (load-bearing)', async () => {
      // The load-bearing assertion for the user's first requirement: cStat
      // and xMotivo must render in the dropdown for *any* estado where they
      // are set — not just `'n'` (rejeitada). Use `'a'` (aprovada) to make
      // sure the old "only show xMotivo on rejeitada" gate is gone.
      setSnap({
        data: [
          rowFromNFe(
            makeNFe(ESTADO_NFE.aprovada, {
              cStat: '100',
              xMotivo: 'Autorizado o uso da NF-e',
              chave: '3'.repeat(44),
            }),
          ),
        ],
      });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      const badge = container.querySelector('[data-variant]');
      expect(badge).toBeTruthy();
      fireEvent.mouseEnter(badge!);
      // The dropdown is portalled; findByText queries the whole document.
      expect(await screen.findByText('cStat:')).toBeTruthy();
      expect(screen.getByText('100')).toBeTruthy();
      expect(screen.getByText('xMotivo:')).toBeTruthy();
      expect(screen.getByText('Autorizado o uso da NF-e')).toBeTruthy();
    });

    it('copies the chave when the chave copy button is clicked', async () => {
      const chave = '3'.repeat(44);
      setSnap({ data: [rowFromNFe(makeNFe(ESTADO_NFE.aprovada, { chave }))] });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      const badge = container.querySelector('[data-variant]');
      fireEvent.mouseEnter(badge!);
      const copyButton = await screen.findByLabelText('Copiar chave');
      fireEvent.click(copyButton);
      expect(writeText).toHaveBeenCalledWith(chave);
    });
  });

  describe('Cancelar NF-e action gating', () => {
    it('offers "Cancelar NF-e" in the dropdown when the NF-e is aprovada', async () => {
      setSnap({ data: [rowFromNFe(makeNFe(ESTADO_NFE.aprovada, { chave: '3'.repeat(44) }))] });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
      expect(await screen.findByRole('button', { name: /cancelar nf-e/i })).toBeTruthy();
    });

    it.each<NotaFiscalEletronica['estado']>([
      ESTADO_NFE.gerado,
      ESTADO_NFE.enviando,
      ESTADO_NFE.aguardandoResposta,
      ESTADO_NFE.rejeitada,
      ESTADO_NFE.cancelada,
      ESTADO_NFE.error,
      ESTADO_NFE.epecAprovado,
    ])('does NOT offer "Cancelar NF-e" for estado %s', async (estado) => {
      setSnap({ data: [rowFromNFe(makeNFe(estado))] });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
      // The dropdown is open once "Estado:" is in the document.
      await screen.findByText('Estado:');
      expect(screen.queryByRole('button', { name: /cancelar nf-e/i })).toBeNull();
    });
  });

  describe('Carta de correção action gating', () => {
    it('offers "Carta de correção" next to "Cancelar NF-e" when the NF-e is aprovada', async () => {
      setSnap({ data: [rowFromNFe(makeNFe(ESTADO_NFE.aprovada, { chave: '3'.repeat(44) }))] });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
      expect(await screen.findByRole('button', { name: /carta de corre/i })).toBeTruthy();
    });

    it.each<NotaFiscalEletronica['estado']>([
      ESTADO_NFE.gerado,
      ESTADO_NFE.enviando,
      ESTADO_NFE.aguardandoResposta,
      ESTADO_NFE.rejeitada,
      ESTADO_NFE.cancelada,
      ESTADO_NFE.error,
      ESTADO_NFE.epecAprovado,
    ])('does NOT offer "Carta de correção" for estado %s', async (estado) => {
      setSnap({ data: [rowFromNFe(makeNFe(estado))] });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
      await screen.findByText('Estado:');
      expect(screen.queryByRole('button', { name: /carta de corre/i })).toBeNull();
    });
  });

  describe('Baixar XML action — reads straight from the nfev4 doc', () => {
    it.each<keyof NotaFiscalEletronica>(['xml_nfe_proc', 'xml_epec_proc', 'xml_assinado'])(
      'offers "Baixar XML" when %s is present on the doc',
      async (field) => {
        setSnap({
          data: [
            rowFromNFe(
              makeNFe(ESTADO_NFE.aprovada, {
                [field]: '<nfeProc/>',
              } as Partial<NotaFiscalEletronica>),
            ),
          ],
        });
        const { container } = wrap(<NFCell pedidoId="p1" />);
        fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
        expect(await screen.findByRole('button', { name: /baixar xml/i })).toBeTruthy();
      },
    );

    it('does NOT offer "Baixar XML" when no XML has been persisted', async () => {
      // Aprovada but with every xml_* field null (the makeNFe default) — the
      // button is gated on XML presence, not on estado.
      setSnap({ data: [rowFromNFe(makeNFe(ESTADO_NFE.aprovada, { chave: '3'.repeat(44) }))] });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
      await screen.findByText('Estado:');
      expect(screen.queryByRole('button', { name: /baixar xml/i })).toBeNull();
    });

    it('downloads a .xml file named by the chave when clicked', async () => {
      // jsdom implements neither the object-URL API nor anchor navigation;
      // stub them and capture the anchor's download attribute at click time.
      // Save the originals (absent in jsdom) and restore in `finally` so the
      // global mutation never leaks into later tests.
      const origCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
      const origRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
      const createSpy = vi.fn(() => 'blob:fake');
      const revokeSpy = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', { value: createSpy, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: revokeSpy, configurable: true });
      let downloadName = '';
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloadName = this.download;
      });

      try {
        const chave = '3'.repeat(44);
        setSnap({
          data: [rowFromNFe(makeNFe(ESTADO_NFE.aprovada, { chave, xml_nfe_proc: '<nfeProc/>' }))],
        });
        const { container } = wrap(<NFCell pedidoId="p1" />);
        fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
        fireEvent.click(await screen.findByRole('button', { name: /baixar xml/i }));

        expect(createSpy).toHaveBeenCalledOnce();
        expect(downloadName).toBe(`${chave}.xml`);
        expect(revokeSpy).toHaveBeenCalledOnce();
      } finally {
        clickSpy.mockRestore();
        if (origCreate) Object.defineProperty(URL, 'createObjectURL', origCreate);
        else delete (URL as { createObjectURL?: unknown }).createObjectURL;
        if (origRevoke) Object.defineProperty(URL, 'revokeObjectURL', origRevoke);
        else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      }
    });
  });

  describe('EPEC aprovado (estado p) action gating — issue #86', () => {
    it('offers the DANFE menu (plain-paper print) but neither Cancelar nor Carta de correção', async () => {
      setSnap({
        data: [
          rowFromNFe(
            makeNFe(ESTADO_NFE.epecAprovado, { tpEmis: 4, chave: '3'.repeat(44), cStat: '136' }),
          ),
        ],
      });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
      await screen.findByText('Estado:');
      expect(screen.getByRole('button', { name: /imprimir danfe/i })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /cancelar nf-e/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /carta de corre/i })).toBeNull();
    });
  });
});

describe('ClienteCell — static cached read', () => {
  afterEach(() => {
    dereferenceMock.mockReset();
    queryState.current = { data: null, isLoading: false };
  });

  it('renders "Anônimo" when the pedido has no cliente ref', () => {
    dereferenceMock.mockReturnValue(null);
    wrap(<ClienteCell pedido={{ clientePedidoOuterRef: null } as unknown as Pedido} />);
    expect(screen.getByText('Anônimo')).toBeTruthy();
  });

  it('renders nome inside a link to /clientes/<id>', () => {
    dereferenceMock.mockReturnValue({ id: 'abc', path: 'clientes/abc' });
    queryState.current = {
      data: { nome: 'Acme Ltda', cpf_cnpj: '12345678000190', tipo: '1' },
      isLoading: false,
    };
    wrap(
      <ClienteCell
        pedido={{ clientePedidoOuterRef: { path: 'clientes/abc' } } as unknown as Pedido}
      />,
    );
    const link = screen.getByRole('link', { name: 'Acme Ltda' });
    expect(link.getAttribute('href')).toBe('/clientes/abc');
  });

  it('shows a skeleton while the one-shot query is in flight', () => {
    dereferenceMock.mockReturnValue({ id: 'abc', path: 'clientes/abc' });
    queryState.current = { data: null, isLoading: true };
    const { container } = wrap(
      <ClienteCell
        pedido={{ clientePedidoOuterRef: { path: 'clientes/abc' } } as unknown as Pedido}
      />,
    );
    expect(container.querySelector('[class*="Skeleton"]')).toBeTruthy();
  });
});

describe('FreteCell — passthrough', () => {
  afterEach(() => {
    dereferenceMock.mockReset();
    queryState.current = { data: null, isLoading: false };
  });

  it('renders DASH when freteInicial is absent', () => {
    wrap(<FreteCell pedido={{ freteInicial: null } as unknown as Pedido} pedidoId="p1" />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders the PT-BR label for the estado', () => {
    wrap(
      <FreteCell
        pedido={{ freteInicial: { estado: 'entregue' } } as unknown as Pedido}
        pedidoId="p1"
      />,
    );
    expect(screen.getByText('Entregue')).toBeTruthy();
  });

  it('opens the etiqueta HoverCard for a generic-label tipo, even with no bought label/quote', () => {
    // motoboy/outros have no printLabelId/externalOptionId/externalOptionIntegracao
    // to key off — only the resolved `int_frete` tipo says the on-demand PDF
    // is available (#376).
    dereferenceMock.mockReturnValue({ id: 'mot-1', path: 'int_frete/mot-1' });
    queryState.current = { data: 'motoboy', isLoading: false };
    const { container } = wrap(
      <FreteCell
        pedido={
          {
            freteInicial: {
              estado: 'iniciado',
              integracaoFreteOuterRef: { path: 'int_frete/mot-1' },
              printLabelId: null,
              externalOptionId: null,
              externalOptionIntegracao: null,
            },
          } as unknown as Pedido
        }
        pedidoId="p1"
      />,
    );
    // Mantine encodes the variant on a data attribute on the Badge root —
    // present only on the HoverCard branch, absent from the plain-text one.
    expect(container.querySelector('[data-variant]')).toBeTruthy();
  });

  it('keeps the lightweight tooltip for a non-generic tipo with nothing to act on yet', () => {
    dereferenceMock.mockReturnValue({ id: 'ret-1', path: 'int_frete/ret-1' });
    queryState.current = { data: 'retiradaNaLoja', isLoading: false };
    const { container } = wrap(
      <FreteCell
        pedido={
          {
            freteInicial: {
              estado: 'iniciado',
              integracaoFreteOuterRef: { path: 'int_frete/ret-1' },
              printLabelId: null,
              externalOptionId: null,
              externalOptionIntegracao: null,
            },
          } as unknown as Pedido
        }
        pedidoId="p1"
      />,
    );
    expect(container.querySelector('[data-variant]')).toBeNull();
  });
});

describe('ImpCell — printed indicator', () => {
  it('renders nothing when dtImpressao is null', () => {
    const { container } = wrap(<ImpCell pedido={{ dtImpressao: null } as unknown as Pedido} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders the check icon when dtImpressao is set', () => {
    const { container } = wrap(
      <ImpCell pedido={{ dtImpressao: Date.parse('2026-05-21T10:00:00Z') } as unknown as Pedido} />,
    );
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('[aria-label="Impresso"]')).toBeTruthy();
  });
});

describe('VlrCell — passthrough', () => {
  it('renders DASH when there is no value and no itens', () => {
    wrap(<VlrCell pedido={{ valorCobrado: null, itens: {} } as unknown as Pedido} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders the cached valorCobrado formatted as BRL', () => {
    wrap(<VlrCell pedido={{ valorCobrado: 1234.56, itens: {} } as unknown as Pedido} />);
    // Match by the integer + fraction parts; locale formatting varies in jsdom.
    expect(screen.getByText(/1\.234,56|1234.56/)).toBeTruthy();
  });
});
