import { Component, type ReactNode } from 'react';
import { FirebaseError } from 'firebase/app';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import { ESTADO_NFE, IE_SENTINELA, TIPO_CLIENTE } from '@delfrance/schemas';
import type { Integracao, NotaFiscalEletronica, Pedido } from '@delfrance/schemas';

import { nfeAssinadoXml, type NfeAssinadoFixtureInput } from '@/lib/nfe/nfeAssinadoFixture';

// Hoisted, mutable state objects so each test can swap the value the mocked
// hooks return before re-rendering. Mirrors the pattern in
// `packages/ui/src/table/TableView.test.tsx`.
const {
  intersecting,
  observeRef,
  snapState,
  queryState,
  useQueryCalls,
  dereferenceMock,
  authUid,
  firestoreDb,
  readClienteMock,
} = vi.hoisted(() => ({
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
      data: null,
      isLoading: false,
    } as {
      data:
        | {
            nome?: string | null;
            cpf_cnpj?: string | null;
            tipo?: string | null;
            ie?: string | null;
          }
        | string
        | null;
      isLoading: boolean;
      // Read by NFCell's `OrientacaoRejeicaoCliente`; absent = no error.
      isError?: boolean;
    },
  },
  // Every options object the mocked `useQuery` received — so a test can assert
  // WHICH key, staleness and gate a call site used, not just what it rendered.
  useQueryCalls: vi.fn(),
  // The ClienteCell calls `dereferenceOuterRef` once with the pedido's
  // outer ref; the test toggles its return shape between a fake doc ref
  // and `null` to exercise the "Anônimo" branch.
  dereferenceMock: vi.fn(),
  // `null` = the real (provider-less) auth context. A uid lets `useLatestNfe`
  // remember a badge, which the memo-backed NFCell render needs.
  authUid: { current: null as string | null },
  // ONE db object, so a test can pin WHICH handle a query function reads with.
  firestoreDb: { __db: true },
  // The shared cliente reader behind `clienteQueryKey` (#1303) — spied so a
  // test can run a recorded `queryFn` and see what it read.
  readClienteMock: vi.fn(),
}));

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => firestoreDb,
}));

vi.mock('@/lib/data/readClienteByRef', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/readClienteByRef')>()),
  readClienteByRef: (...args: unknown[]) => readClienteMock(...args),
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
  return {
    ...actual,
    useQuery: (options: unknown) => {
      useQueryCalls(options);
      return queryState.current;
    },
  };
});

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return authUid.current === null
        ? real
        : ({ user: { uid: authUid.current }, loading: false } as unknown as typeof real);
    },
  };
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

import { ClienteCell, FreteCell, ImpCell, IntegracaoCell, NFCell, VlrCell } from './PedidoCells';
import type { IntegracaoLookup } from './integracaoLookup';
import { PedidoRowReadsContext, clienteQueryKey } from './rowReadPrefetch';
import { NFE_LISTENER_UNSEEN_MS, __resetLatestNfeMemo } from './useLatestNfe';

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
    totais: null,
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

  it('shows a placeholder, NOT the no-NF-e dash, once the row is released off screen', () => {
    // The distinction is load-bearing: a released row has no listener, and
    // rendering DASH there would assert the pedido has no nota fiscal.
    //
    // ⚠️ Reaching `status: 'idle'` requires ADVANCING PAST the teardown delay.
    // The gate is one-directional, so merely reporting `isIntersecting: false`
    // leaves `active` true and the cell in the ordinary loading branch — an
    // earlier version of this test asserted the same Skeleton either way and
    // was green with the gate neutralised.
    vi.useFakeTimers();
    try {
      intersecting.current = false;
      setSnap({ data: undefined, loading: false });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      act(() => {
        vi.advanceTimersByTime(NFE_LISTENER_UNSEEN_MS);
      });
      expect(container.querySelector('[class*="Skeleton"]')).toBeTruthy();
      expect(screen.queryByText('—')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  describe('cStat 805 guidance in the HoverCard (#852)', () => {
    const XMOTIVO_805 =
      'Rejeição: A SEFAZ do destinatário não permite Contribuinte Isento de Inscrição Estadual';
    const CLIENTE_REF = 'documents/clientes/cli-1';
    const CLIENTE_PATH = 'clientes/cli-1';
    /** What `dereferenceOuterRef` returns for {@link CLIENTE_REF} — one object, so identity is assertable. */
    const CLIENTE_DOC_REF = { id: 'cli-1', path: CLIENTE_PATH, parent: { id: 'clientes' } };
    const TITULO_CORRIGIR = 'Inscrição estadual do cliente recusada pela SEFAZ';
    const TITULO_REEMITIR = 'Cadastro do cliente já alterado';

    /** A rejeitada doc whose signed XML (homologação fixture) says what was sent. */
    function rejeitada(cStat: string, xml: NfeAssinadoFixtureInput): NotaFiscalEletronica {
      return makeNFe(ESTADO_NFE.rejeitada, {
        cStat,
        xMotivo: cStat === '805' ? XMOTIVO_805 : 'Rejeição: Duplicidade de NF-e',
        xml_assinado: nfeAssinadoXml(xml),
      });
    }

    async function openHoverCard(container: HTMLElement): Promise<void> {
      fireEvent.mouseEnter(container.querySelector('[data-variant]')!);
      await screen.findByText('Estado:');
    }

    /** Options of every `useQuery` call made under the shared cliente key. */
    function clienteQueryOptions(path: string): Array<Record<string, unknown>> {
      const key = JSON.stringify(clienteQueryKey(path));
      return useQueryCalls.mock.calls
        .map(([options]) => options as Record<string, unknown>)
        .filter((options) => JSON.stringify(options.queryKey) === key);
    }

    beforeEach(() => {
      useQueryCalls.mockClear();
      readClienteMock.mockReset();
      dereferenceMock.mockReset();
      dereferenceMock.mockImplementation((_db: unknown, ref: unknown) =>
        ref === CLIENTE_REF ? CLIENTE_DOC_REF : null,
      );
      queryState.current = {
        data: { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: IE_SENTINELA.isento },
        isLoading: false,
      };
    });

    afterEach(() => {
      dereferenceMock.mockReset();
      queryState.current = { data: null, isLoading: false };
      authUid.current = null;
    });

    it('shows the fix-it Alert ABOVE the raw cStat / xMotivo rows, which stay', async () => {
      const nfe = rejeitada('805', { idDest: '1', indIEDest: '2', ufDest: 'SP' });
      expect(nfe.xml_assinado).toContain('<tpAmb>2</tpAmb>');
      setSnap({ data: [rowFromNFe(nfe)] });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      await openHoverCard(container);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText(TITULO_CORRIGIR)).toBeTruthy();
      const texto = alert.textContent ?? '';
      expect(texto).toContain('foi enviada com o cliente ACME LTDA');
      expect(texto).toContain('SEFAZ-SP');
      expect(texto).toContain('operação interna');
      expect(texto).toContain('Buscar dados do CNPJ');
      expect(texto).toContain(IE_SENTINELA.naoContribuinte);
      const link = within(alert).getByRole('link', { name: 'Abrir cadastro de ACME LTDA' });
      expect(link.getAttribute('href')).toBe('/clientes/cli-1');

      // SEFAZ's own words stay on screen, BELOW the guidance.
      const cStatLabel = screen.getByText('cStat:');
      expect(screen.getByText('805')).toBeTruthy();
      expect(screen.getByText(XMOTIVO_805)).toBeTruthy();
      expect(alert.compareDocumentPosition(cStatLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      // …and the guidance sits under the Estado row.
      expect(
        screen.getByText('Estado:').compareDocumentPosition(alert) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

      // The shared key and reader as ClienteCell, but never stale: a cadastro
      // fixed a minute ago must flip the copy to "já alterado".
      expect(dereferenceMock).toHaveBeenCalledWith(expect.anything(), CLIENTE_REF);
      const opts = clienteQueryOptions(CLIENTE_PATH);
      expect(opts.length).toBeGreaterThan(0);
      expect(opts.at(-1)).toMatchObject({ staleTime: 0, enabled: true });

      // …and the recorded query function reads through the SHARED reader, with
      // the page's db and the dereferenced ref itself — the #1303 provenance.
      const cadastro = { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: '1' };
      readClienteMock.mockResolvedValue(cadastro);
      const queryFn = opts.at(-1)?.queryFn as () => Promise<unknown>;
      await expect(queryFn()).resolves.toBe(cadastro);
      expect(readClienteMock).toHaveBeenCalledTimes(1);
      const [dbArg, refArg] = readClienteMock.mock.calls[0] ?? [];
      expect(dbArg).toBe(firestoreDb);
      expect(refArg).toBe(CLIENTE_DOC_REF);
    });

    it('a failed cliente read never vouches for a changed cadastro: isError → the fix-it text', async () => {
      // The data still in the shared key would say "já alterado"; an error
      // makes the cadastro unknown, and unknown keeps the fix-it text.
      queryState.current = {
        data: { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: '123456789' },
        isLoading: false,
        isError: true,
      };
      setSnap({ data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      await openHoverCard(container);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText(TITULO_CORRIGIR)).toBeTruthy();
      expect(within(alert).queryByText(TITULO_REEMITIR)).toBeNull();
      // The id is still known, so the id-only link survives.
      expect(within(alert).getByRole('link').getAttribute('href')).toBe('/clientes/cli-1');
    });

    it('waits for the page batch: under a pending row-read context the cliente query is disabled', async () => {
      setSnap({ data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(
        <PedidoRowReadsContext.Provider value="pending">
          <NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />
        </PedidoRowReadsContext.Provider>,
      );
      await openHoverCard(container);

      const opts = clienteQueryOptions(CLIENTE_PATH);
      expect(opts.length).toBeGreaterThan(0);
      expect(opts.at(-1)).toMatchObject({ enabled: false });
    });

    it('a cliente ref into ANOTHER collection names "o cliente deste pedido", links nothing and reads nothing', async () => {
      // Same id, other collection: `/clientes/cli-1` would open a DIFFERENT cadastro.
      const OUTRO_REF = 'documents/fornecedores/cli-1';
      const OUTRO_PATH = 'fornecedores/cli-1';
      dereferenceMock.mockImplementation((_db: unknown, ref: unknown) =>
        ref === OUTRO_REF
          ? { id: 'cli-1', path: OUTRO_PATH, parent: { id: 'fornecedores' } }
          : null,
      );
      setSnap({ data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={OUTRO_REF} />);
      await openHoverCard(container);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText(TITULO_CORRIGIR)).toBeTruthy();
      expect(alert.textContent).toContain('o cliente deste pedido');
      // The mocked query still "returns" ACME — that name belongs to no cliente here.
      expect(alert.textContent).not.toContain('ACME LTDA');
      expect(within(alert).queryByRole('link')).toBeNull();
      expect(dereferenceMock).toHaveBeenCalledWith(expect.anything(), OUTRO_REF);
      expect(clienteQueryOptions(OUTRO_PATH)).toEqual([]);
      expect(useQueryCalls.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
    });

    it('a legacy ref that dereference cannot resolve (FirebaseError) degrades to "o cliente deste pedido" instead of throwing in render', async () => {
      // An opaque `{ path }` ref with an odd segment count makes the real `doc()`
      // throw `FirebaseError invalid-argument` synchronously — inside this cell's
      // render. The loader already degrades this case; the HoverCard must too.
      const REF_IMPAR = { path: 'clientes' };
      dereferenceMock.mockImplementation(() => {
        throw new FirebaseError('invalid-argument', 'odd number of path segments');
      });
      setSnap({ data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(
        <NFCell
          pedidoId="p1"
          clientePedidoOuterRef={REF_IMPAR as unknown as Pedido['clientePedidoOuterRef']}
        />,
      );
      await openHoverCard(container);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText(TITULO_CORRIGIR)).toBeTruthy();
      expect(alert.textContent).toContain('o cliente deste pedido');
      expect(alert.textContent).not.toContain('ACME LTDA');
      expect(within(alert).queryByRole('link')).toBeNull();
      expect(dereferenceMock).toHaveBeenCalledWith(expect.anything(), REF_IMPAR);
      expect(useQueryCalls.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
    });

    it('near-miss: a NON-Firebase error from dereference still propagates (narrowed, not swallowed)', async () => {
      class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
        override state = { error: null as unknown };
        static getDerivedStateFromError(error: unknown) {
          return { error };
        }
        override render() {
          return this.state.error != null ? (
            <div data-testid="boundary">{String(this.state.error)}</div>
          ) : (
            this.props.children
          );
        }
      }
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      dereferenceMock.mockImplementation(() => {
        throw new TypeError('a bug, not a legacy ref');
      });
      setSnap({ data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(
        <Boundary>
          <NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />
        </Boundary>,
      );
      fireEvent.mouseEnter(container.querySelector('[data-variant]')!);

      expect((await screen.findByTestId('boundary')).textContent).toContain(
        'a bug, not a legacy ref',
      );
      consoleError.mockRestore();
    });

    it('switches to the "já alterado" variant once the cadastro no longer declares ISENTO', async () => {
      queryState.current = {
        data: { nome: 'ACME LTDA', tipo: TIPO_CLIENTE.pessoaJuridica, ie: '123456789' },
        isLoading: false,
      };
      setSnap({ data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      await openHoverCard(container);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText(TITULO_REEMITIR)).toBeTruthy();
      expect(within(alert).queryByText(TITULO_CORRIGIR)).toBeNull();
      expect(alert.textContent).toContain('emita a NF-e novamente');
      expect(
        within(alert)
          .getByRole('link', { name: 'Abrir cadastro de ACME LTDA' })
          .getAttribute('href'),
      ).toBe('/clientes/cli-1');
    });

    it('a RAW cliente doc with a non-string ie reads it as blank instead of throwing', async () => {
      // The shared key can hold a soft-read RAW document; `normalizarIe` would
      // throw on a number, during the dropdown's render. The shared mapper
      // (`cadastroClienteRejeicao`, the loader's too) reads it as `null`.
      queryState.current = {
        data: {
          nome: 'ACME LTDA',
          tipo: TIPO_CLIENTE.pessoaJuridica,
          ie: 123 as unknown as string,
        },
        isLoading: false,
      };
      setSnap({ data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      await openHoverCard(container);
      // A PJ whose ie is unreadable no longer yields indIEDest=2 → "reemitir".
      expect(within(screen.getByRole('alert')).getByText(TITULO_REEMITIR)).toBeTruthy();
    });

    it.each<[string, NfeAssinadoFixtureInput]>([
      ['indIEDest 9 (não contribuinte)', { idDest: '1', indIEDest: '9' }],
      ['indIEDest 1 (contribuinte)', { idDest: '1', indIEDest: '1' }],
      ['idDest 3 (exterior)', { idDest: '3', indIEDest: '2' }],
    ])('an 805 whose XML says %s shows no guidance — only the raw rows', async (_l, xml) => {
      setSnap({ data: [rowFromNFe(rejeitada('805', xml))] });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      await openHoverCard(container);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText(XMOTIVO_805)).toBeTruthy();
    });

    it('any other cStat mounts no guidance and reads no cliente', async () => {
      setSnap({ data: [rowFromNFe(rejeitada('226', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      await openHoverCard(container);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(clienteQueryOptions(CLIENTE_PATH)).toEqual([]);
      expect(dereferenceMock).not.toHaveBeenCalled();
    });

    it('without the cliente ref (the optional prop omitted) names "o cliente deste pedido" and links nothing', async () => {
      setSnap({ data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))] });
      const { container } = wrap(<NFCell pedidoId="p1" />);
      await openHoverCard(container);

      const alert = screen.getByRole('alert');
      expect(within(alert).getByText(TITULO_CORRIGIR)).toBeTruthy();
      expect(alert.textContent).toContain('o cliente deste pedido');
      // The mocked query still "returns" ACME — a name must never appear
      // without a ref to vouch for whose cadastro it is.
      expect(alert.textContent).not.toContain('ACME LTDA');
      expect(within(alert).queryByRole('link')).toBeNull();
      expect(dereferenceMock).not.toHaveBeenCalled();
      expect(useQueryCalls.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
    });

    it('idDest 2 (the owner decision) gets the interstate wording with the destinatário UF', async () => {
      setSnap({
        data: [rowFromNFe(rejeitada('805', { idDest: '2', indIEDest: '2', ufDest: 'MG' }))],
      });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      await openHoverCard(container);

      const texto = screen.getByRole('alert').textContent ?? '';
      expect(texto).toContain('SEFAZ-MG');
      expect(texto).toContain('interestadual');
      expect(texto).not.toContain('operação interna');
    });

    it('a memo-backed render (no live doc) still shows the guidance', async () => {
      // The remembered badge carries `destinatario`, so a scrolled-back row
      // explains its 805 without the XML — while offering no XML action.
      authUid.current = 'user-a';
      setSnap({
        data: [rowFromNFe(rejeitada('805', { idDest: '1', indIEDest: '2' }))],
        fromCache: false,
      });
      const live = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      live.unmount();

      setSnap({ data: undefined, loading: true });
      const { container } = wrap(<NFCell pedidoId="p1" clientePedidoOuterRef={CLIENTE_REF} />);
      await openHoverCard(container);

      expect(within(screen.getByRole('alert')).getByText(TITULO_CORRIGIR)).toBeTruthy();
      // Proof the render is memo-backed: the live-doc-only action is absent.
      expect(screen.queryByRole('button', { name: /baixar xml/i })).toBeNull();
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

describe('IntegracaoCell — page-wide lookup, no per-row read', () => {
  const integracao = (nome: string, tipo: number, cor: number | null) =>
    ({ nome, tipo, cor, ativo: true }) as unknown as Integracao;

  const lookup = (
    status: IntegracaoLookup['status'],
    entries: Array<[string, Integracao]> = [],
  ): IntegracaoLookup => ({ rows: [], byId: new Map(entries), status });

  const pedido = (ref: unknown) => ({ integracaoPedidoOuterRef: ref }) as unknown as Pedido;

  afterEach(() => {
    dereferenceMock.mockReset();
  });

  it('renders a dash when the pedido carries no integração', () => {
    dereferenceMock.mockReturnValue(null);
    wrap(<IntegracaoCell pedido={pedido(null)} lookup={lookup('success')} />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('shows a skeleton while the shared lookup is in flight', () => {
    // ⚠️ Status first: an empty `byId` while pending must NOT read as
    // "this integração does not exist".
    dereferenceMock.mockReturnValue({ id: 'ml-1' });
    const { container } = wrap(
      <IntegracaoCell pedido={pedido('documents/integracao/ml-1')} lookup={lookup('pending')} />,
    );
    expect(container.querySelector('[class*="Skeleton"]')).toBeTruthy();
  });

  it('says the lookup is unavailable when the read failed, not that the id is unknown', () => {
    // A user without `PERM.integracao.read` gets `permission-denied`, which
    // leaves `byId` empty — a system problem, reported as one.
    dereferenceMock.mockReturnValue({ id: 'ml-1' });
    wrap(<IntegracaoCell pedido={pedido('documents/integracao/ml-1')} lookup={lookup('error')} />);
    expect(screen.getByText('indisponível')).toBeTruthy();
  });

  it('flags an id the loaded lookup genuinely does not hold', () => {
    dereferenceMock.mockReturnValue({ id: 'gone' });
    wrap(
      <IntegracaoCell
        pedido={pedido('documents/integracao/gone')}
        lookup={lookup('success', [['ml-1', integracao('ML Principal', 1, null)]])}
      />,
    );
    expect(screen.getByText('desconhecida')).toBeTruthy();
  });

  it('renders the channel name once the lookup resolves it', () => {
    dereferenceMock.mockReturnValue({ id: 'ml-1' });
    wrap(
      <IntegracaoCell
        pedido={pedido('documents/integracao/ml-1')}
        lookup={lookup('success', [['ml-1', integracao('ML Principal', 1, 0x1e88e5)]])}
      />,
    );
    expect(screen.getByText('ML Principal')).toBeTruthy();
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
