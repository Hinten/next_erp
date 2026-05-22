import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import type { NotaFiscalEletronica, Pedido } from '@delfrance/schemas';

// Hoisted, mutable state objects so each test can swap the value the mocked
// hooks return before re-rendering. Mirrors the pattern in
// `packages/ui/src/table/TableView.test.tsx`.
const { snapState, queryState, dereferenceMock } = vi.hoisted(() => ({
  snapState: {
    current: {
      data: undefined,
      loading: true,
      error: undefined,
    } as SnapshotState<SnapshotRow<NotaFiscalEletronica>[]>,
  },
  queryState: {
    current: {
      data: null as
        | { nome?: string | null; cpf_cnpj?: string | null; tipo?: string | null }
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
  const actual = await vi.importActual<typeof import('@delfrance/data')>(
    '@delfrance/data',
  );
  return {
    ...actual,
    // The hook is mocked too, so the returned object only needs a stable
    // identity for the useMemo dep array.
    buildQuery: () => ({ __fakeQuery: true }),
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
  };
});

vi.mock('@delfrance/data/hooks', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data/hooks')>(
    '@delfrance/data/hooks',
  );
  return { ...actual, useSnapshot: () => snapState.current };
});

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query',
  );
  return { ...actual, useQuery: () => queryState.current };
});

// firebase/firestore.getDoc is wrapped by the mocked useQuery, but the
// component still imports it at module-load. Stub it so the import resolves.
vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>(
    'firebase/firestore',
  );
  return { ...actual, getDoc: vi.fn() };
});

import {
  ClienteCell,
  FreteCell,
  ImpCell,
  NFCell,
  VlrCell,
} from './PedidoCells';

function wrap(node: React.ReactNode) {
  return render(<MantineProvider env="test">{node}</MantineProvider>);
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
  afterEach(() => {
    setSnap({ data: undefined, loading: true });
  });

  it('shows a skeleton while the snapshot is loading', () => {
    setSnap({ loading: true });
    const { container } = wrap(<NFCell pedidoId="p1" />);
    expect(container.querySelector('[class*="Skeleton"]')).toBeTruthy();
  });

  it('renders DASH when no NFe doc exists', () => {
    setSnap({ data: [] });
    wrap(<NFCell pedidoId="p1" />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  // Sanity-check every estado renders its PT-BR label from ESTADO_NFE_LABELS.
  it.each<[NotaFiscalEletronica['estado'], string]>([
    ['0', 'Gerado'],
    ['1', 'Enviando'],
    ['2', 'Aguardando resposta'],
    ['3', 'Processamento completo'],
    ['4', 'Processamento cancelado'],
    ['a', 'Aprovada'],
    ['p', 'EPEC aprovado'],
    ['n', 'Rejeitada'],
    ['c', 'Cancelada'],
    ['i', 'Numeração inutilizada'],
    ['e', 'Erro'],
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
    setSnap({ data: [rowFromNFe(makeNFe('0'))] });
    const { rerender } = wrap(<NFCell pedidoId="p1" />);
    expect(screen.getByText('Gerado')).toBeTruthy();

    act(() => {
      setSnap({ data: [rowFromNFe(makeNFe('a', { chave: '3'.repeat(44) }))] });
    });
    rerender(
      <MantineProvider env="test">
        <NFCell pedidoId="p1" />
      </MantineProvider>,
    );
    expect(screen.getByText('Aprovada')).toBeTruthy();
    expect(screen.queryByText('Gerado')).toBeNull();

    act(() => {
      setSnap({
        data: [rowFromNFe(makeNFe('n', { xMotivo: 'cliente sem IE' }))],
      });
    });
    rerender(
      <MantineProvider env="test">
        <NFCell pedidoId="p1" />
      </MantineProvider>,
    );
    expect(screen.getByText('Rejeitada')).toBeTruthy();
  });

  it('uses outline variant when tpEmis indicates contingência', () => {
    // tpEmis === 1 is normal; anything else (2 EPEC, 9 SVC-RS, etc.) is
    // contingency emission. The cell switches to `variant="outline"` so
    // operators can spot the rare case at a glance.
    setSnap({ data: [rowFromNFe(makeNFe('a', { tpEmis: 9 }))] });
    const { container } = wrap(<NFCell pedidoId="p1" />);
    // Mantine encodes the variant on a data attribute on the Badge root.
    const badge = container.querySelector('[data-variant="outline"]');
    expect(badge).toBeTruthy();
  });
});

describe('ClienteCell — static cached read', () => {
  afterEach(() => {
    dereferenceMock.mockReset();
    queryState.current = { data: null, isLoading: false };
  });

  it('renders "Anônimo" when the pedido has no cliente ref', () => {
    dereferenceMock.mockReturnValue(null);
    wrap(
      <ClienteCell
        pedido={{ clientePedidoOuterRef: null } as unknown as Pedido}
      />,
    );
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
  it('renders DASH when freteInicial is absent', () => {
    wrap(<FreteCell pedido={{ freteInicial: null } as unknown as Pedido} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders the PT-BR label for the estado', () => {
    wrap(
      <FreteCell
        pedido={{ freteInicial: { estado: 'entregue' } } as unknown as Pedido}
      />,
    );
    expect(screen.getByText('Entregue')).toBeTruthy();
  });
});

describe('ImpCell — printed indicator', () => {
  it('renders nothing when dtImpressao is null', () => {
    const { container } = wrap(
      <ImpCell pedido={{ dtImpressao: null } as unknown as Pedido} />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders the check icon when dtImpressao is set', () => {
    const { container } = wrap(
      <ImpCell
        pedido={{ dtImpressao: Date.parse('2026-05-21T10:00:00Z') } as unknown as Pedido}
      />,
    );
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('[aria-label="Impresso"]')).toBeTruthy();
  });
});

describe('VlrCell — passthrough', () => {
  it('renders DASH when there is no value and no itens', () => {
    wrap(
      <VlrCell
        pedido={{ valorCobrado: null, itens: {} } as unknown as Pedido}
      />,
    );
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders the cached valorCobrado formatted as BRL', () => {
    wrap(
      <VlrCell
        pedido={{ valorCobrado: 1234.56, itens: {} } as unknown as Pedido}
      />,
    );
    // Match by the integer + fraction parts; locale formatting varies in jsdom.
    expect(screen.getByText(/1\.234,56|1234.56/)).toBeTruthy();
  });
});
