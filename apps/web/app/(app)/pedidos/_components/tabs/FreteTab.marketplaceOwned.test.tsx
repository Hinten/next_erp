import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useForm } from 'react-hook-form';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import type { IntegracaoFrete, Pedido } from '@delfrance/schemas';
import {
  INTEGRACAO_FRETE,
  INTEGRACAO_FRETE_LABELS,
  MODALIDADE_FRETE,
  integracoesFreteSchema,
  isFreteMarketplaceOwned,
  isFreteSelecionavelManualmente,
  seedFreteInicial,
} from '@delfrance/schemas';
import type { FreteInicialFormState, PedidoFormState } from '../types';
import type { IntegracaoFreteSelectProps } from './frete/IntegracaoFreteSelect';

import { FreteTab } from './FreteTab';

// Step 7 (#1515) — the Frete tab reads ownership off the freight BLOCK
// (`externalOptionIntegracao`), not only off the resolved `int_frete` doc.
// When that was written a Shopee pedido this app imported never got an
// `integracaoFreteOuterRef`
// (`apps/shopee/lib/shopee/pedidos/orderFreteMapping.ts` writes
// `externalOptionIntegracao: 'shopee'` and nothing else), so before this fix
// `tipo` resolved to `undefined`, the tab rendered the EDITABLE generic body,
// and an operator could type over the two fields the importer owns —
// `codRastreio` and the frete `estado` — latching `hasUserInteraction` on a
// block the server (`pedidoReconcile`) already treats as marketplace-owned.
// Since 2026-11-18 (Lucas reversed step 20's Q1 (a)) the importer also stamps
// its conta's active `int_frete` ref — on a CREATE only, never as a backfill —
// so BOTH Shopee shapes stay live: the ref-less one (case 1: a pedido created
// while its conta had no active doc, or, on staging only, one imported
// earlier), locked by the block half alone, and the ref'd one (case 7), locked
// by both halves with the picker naming the conta's doc.

interface IntFreteDocFixture {
  readonly id: string;
  readonly data: { readonly tipo: IntegracaoFrete; readonly nome: string };
}

/** The resolved `int_frete` document, or `null` for "resolves to nothing". */
const mockIntFrete: { doc: IntFreteDocFixture | null; loading: boolean } = {
  doc: null,
  loading: false,
};

const tracking = vi.hoisted(() => ({ rastrear: vi.fn() }));
vi.mock('@/lib/mercado-livre/client', () => ({ useMercadoLivreClient: () => tracking }));
vi.mock('@/lib/auth/usePermission', () => ({
  usePermission: () => ({ allowed: true, loading: false }),
}));
vi.mock('@/lib/freight/client', () => ({ useFreightClient: () => null }));
vi.mock('./frete/EtiquetaMelhorEnvioPanel', () => ({ EtiquetaMelhorEnvioPanel: () => null }));

// The three header pickers render only what the tab HANDS them — whether the
// control is disabled and, for the integração picker, which doc it names: the
// `value`, the `currentFallback` id (the real picker shows the fallback only
// under that id, so the two must agree) and its label in the real picker's
// `nome (tipo)` shape, with the raw tipo. The picker's own display of a stored
// marketplace doc through `currentFallback` is `IntegracaoFreteSelect.test.tsx`'s
// ("displays a stored Shopee selection through currentFallback after the
// active list loads").
vi.mock('@/components/pickers/ClientePicker', () => ({
  ClientePicker: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="cliente-recebedor-picker" data-disabled={String(!!disabled)} />
  ),
}));
vi.mock('@/components/pickers/EnderecoPicker', () => ({
  EnderecoPicker: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="endereco-frete-picker" data-disabled={String(!!disabled)} />
  ),
  useEnderecoFromRef: () => ({ endereco: null }),
}));
vi.mock('./frete/IntegracaoFreteSelect', () => ({
  IntegracaoFreteSelect: ({
    value,
    currentFallback,
    disabled,
  }: Pick<IntegracaoFreteSelectProps, 'value' | 'currentFallback' | 'disabled'>) => (
    <div
      data-testid="integracao-frete-select"
      data-value={value ?? ''}
      data-fallback-id={currentFallback?.id ?? ''}
      data-disabled={String(!!disabled)}
    >
      {currentFallback ? `${currentFallback.nome} (${currentFallback.tipo})` : ''}
    </div>
  ),
}));
vi.mock('@delfrance/data/hooks', () => ({
  // Mirrors the real hook's null-ref arm: a pedido with no
  // `integracaoFreteOuterRef` can NEVER be handed a resolved document, so a
  // fixture cannot accidentally supply one and make a test vacuous. And it
  // answers only for the doc ref whose id IS the fixture's (the
  // `intFreteCollection.docRef` mock below returns `{ id }`): a tab that
  // resolved any other id reads a missing doc, as it would for real.
  useDocSnapshot: (ref: unknown) => ({
    data:
      ref != null && (ref as { id: string }).id === mockIntFrete.doc?.id
        ? mockIntFrete.doc
        : undefined,
    loading: ref != null && mockIntFrete.loading,
    error: undefined,
  }),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  dereferenceOuterRef: (_db: unknown, outerRef: unknown) =>
    typeof outerRef === 'string' ? { id: outerRef.split('/').filter(Boolean).pop() } : null,
}));
vi.mock('@/lib/data/intFreteCollection', () => ({
  intFreteCollection: { docRef: (_db: unknown, _parents: unknown, id: string) => ({ id }) },
}));

const db = {} as Firestore;
const PRAZO_LABEL = 'Data máxima para despacho';
const PRAZO_DESPACHO_US = new Date(2026, 11, 3, 14, 25).getTime() * 1_000;
const PRAZO_EXIBIDO = '03/12/2026 14:25';
const REF_INT_1 = 'documents/int_frete/int-1';
/** A conta's `int_frete` doc, as the Shopee importer stamps it on a CREATE (fixture id and nome). */
const DOC_SHOPEE: IntFreteDocFixture = {
  id: 'shopee-conta-1',
  data: { tipo: INTEGRACAO_FRETE.shopee, nome: 'Conta Shopee de teste' },
};
const REF_DOC_SHOPEE = `documents/int_frete/${DOC_SHOPEE.id}`;

function freteWith(over: Partial<FreteInicialFormState>): FreteInicialFormState {
  return {
    ...(seedFreteInicial(MODALIDADE_FRETE.fob, true) as unknown as FreteInicialFormState),
    ...over,
  };
}

function Host({ frete, disabled }: { frete: FreteInicialFormState; disabled?: boolean }) {
  const form = useForm<PedidoFormState, unknown, Pedido>({
    defaultValues: {
      freteInicial: frete,
      ehSaida: true,
      _itensFlat: [],
    } as unknown as PedidoFormState,
  });
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <MantineTestProvider>
      <QueryClientProvider client={queryClient}>
        <FreteTab form={form} db={db} disabled={disabled} pedidoId="ped-1" />
      </QueryClientProvider>
    </MantineTestProvider>
  );
}

function renderTab(frete: FreteInicialFormState) {
  return render(<Host frete={frete} />);
}

/** The read-only panel's own alert, with the tipo it names. */
const alertaMarketplace = () => screen.queryByText(/Frete gerenciado pelo marketplace/);
const inputRastreio = () => screen.getByLabelText('Código de rastreio') as HTMLInputElement;
const inputIntegracaoOpcao = () =>
  screen.getByLabelText('Integração da opção externa') as HTMLInputElement;
/** The HEADER "Status do frete" Select — the label also targets a hidden node. */
const selectStatus = () => screen.getAllByLabelText('Status do frete')[0] as HTMLInputElement;
const selectModalidade = () =>
  screen.getAllByLabelText('Modalidade de frete')[0] as HTMLInputElement;
const pickerIntegracao = () => screen.getByTestId('integracao-frete-select');
const pickerEndereco = () => screen.getByTestId('endereco-frete-picker');
const pickerRecebedor = () => screen.getByTestId('cliente-recebedor-picker');
const campoPrazoDespacho = () => screen.getByLabelText(PRAZO_LABEL) as HTMLButtonElement;

function expectPrazoBloqueado() {
  const campo = campoPrazoDespacho();
  expect(campo.textContent).toBe(PRAZO_EXIBIDO);
  expect(campo.disabled).toBe(true);
}

beforeEach(() => {
  // Mantine portals into `document.body`, which RTL's cleanup does not clear.
  document.body.innerHTML = '';
  mockIntFrete.doc = null;
  mockIntFrete.loading = false;
  tracking.rastrear.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('FreteTab — marketplace ownership is read off the BLOCK too (#1515)', () => {
  it('passes the saved pedido ID to tracking while freight fields remain read-only', async () => {
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      opener: null,
      closed: false,
      location: { replace },
    } as unknown as Window);
    tracking.rastrear.mockResolvedValue({ name: 'Carrier', url: 'https://carrier.example/track' });
    renderTab(
      freteWith({
        externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre,
        externalId: '555',
        codRastreio: null,
      }),
    );
    expect(inputRastreio().disabled).toBe(true);
    const action = screen.getByRole('button', { name: 'Rastrear' }) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    fireEvent.click(action);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://carrier.example/track'));
    expect(tracking.rastrear).toHaveBeenCalledExactlyOnceWith('ped-1');
  });

  it('1: a Shopee block with no integração doc renders the read-only panel', () => {
    renderTab(
      freteWith({
        externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
        integracaoFreteOuterRef: null,
        codRastreio: 'OFG242672552205937',
        prazoDespacho: PRAZO_DESPACHO_US,
      }),
    );

    // The panel, and it names the tipo the BLOCK declares.
    expect(alertaMarketplace()?.textContent).toMatch(
      /Frete gerenciado pelo marketplace \(Shopee\)/,
    );
    expectPrazoBloqueado();
    expect(inputRastreio().readOnly).toBe(true);
    expect(inputRastreio().disabled).toBe(true);
    expect(inputIntegracaoOpcao().readOnly).toBe(true);
    // The header Select the estado would be edited through.
    expect(selectStatus().disabled).toBe(true);
    // Case 7's near-miss: the ref-less pedido — created while its conta had no
    // active doc (or, on staging only, imported before 2026-11-18) — locks the
    // picker too, but names no doc.
    expect(pickerIntegracao().dataset.disabled).toBe('true');
    expect(pickerIntegracao().dataset.value).toBe('');
    expect(pickerIntegracao().dataset.fallbackId).toBe('');
    expect(pickerIntegracao().textContent).toBe('');
  });

  it('2: NEAR-MISS — a melhorEnvios block with no integração doc stays editable', () => {
    renderTab(
      freteWith({
        externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios,
        integracaoFreteOuterRef: null,
      }),
    );

    expect(alertaMarketplace()).toBeNull();
    expect(campoPrazoDespacho().disabled).toBe(false);
    expect(inputRastreio().readOnly).toBe(false);
    expect(inputRastreio().disabled).toBe(false);
    expect(selectStatus().disabled).toBe(false);
  });

  it('3: a manual pedido (no integração declared anywhere) stays editable', () => {
    renderTab(freteWith({ externalOptionIntegracao: null, integracaoFreteOuterRef: null }));

    expect(alertaMarketplace()).toBeNull();
    expect(campoPrazoDespacho().disabled).toBe(false);
    expect(campoPrazoDespacho().textContent).toBe('');
    expect(inputRastreio().readOnly).toBe(false);
    expect(inputRastreio().disabled).toBe(false);
    expect(selectStatus().disabled).toBe(false);
    // Case 7's near-miss on the lock: every header control it asserts locked
    // is ENABLED here, so "locked" there is an observation, not a stub default.
    expect(selectModalidade().disabled).toBe(false);
    expect(pickerIntegracao().dataset.disabled).toBe('false');
    expect(pickerEndereco().dataset.disabled).toBe('false');
    expect(pickerRecebedor().dataset.disabled).toBe('false');
  });

  it('4: PRECEDENCE — a resolved retiradaNaLoja doc does NOT unlock a Shopee block', () => {
    mockIntFrete.doc = {
      id: 'int-1',
      data: { tipo: INTEGRACAO_FRETE.retiradaNaLoja, nome: 'Loja' },
    };
    renderTab(
      freteWith({
        externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
        integracaoFreteOuterRef: REF_INT_1,
        prazoDespacho: PRAZO_DESPACHO_US,
      }),
    );

    // Ownership is the OR of the two declarations: the weaker one (the doc)
    // widens it, never narrows it. The panel names the side that owns.
    expect(alertaMarketplace()?.textContent).toMatch(
      /Frete gerenciado pelo marketplace \(Shopee\)/,
    );
    expectPrazoBloqueado();
    expect(inputRastreio().readOnly).toBe(true);
    expect(selectStatus().disabled).toBe(true);
  });

  it('5: the RESOLVED path is unchanged — an ML doc still renders the read-only panel', () => {
    // `externalOptionIntegracao` is deliberately null, so the lock can only
    // come from the resolved document: this is the pre-fix path, pinned.
    mockIntFrete.doc = {
      id: 'int-1',
      data: { tipo: INTEGRACAO_FRETE.mercadoLivre, nome: 'Mercado Livre' },
    };
    renderTab(
      freteWith({
        externalOptionIntegracao: null,
        integracaoFreteOuterRef: REF_INT_1,
        prazoDespacho: PRAZO_DESPACHO_US,
      }),
    );

    expect(alertaMarketplace()?.textContent).toMatch(
      /Frete gerenciado pelo marketplace \(Mercado Livre\)/,
    );
    expectPrazoBloqueado();
    expect(inputRastreio().readOnly).toBe(true);
    expect(selectStatus().disabled).toBe(true);
  });

  it('6: a TRAVA NÃO TEM DESFAZER, então o Select editável não oferece tipo marketplace nenhum', () => {
    // O pedido manual do caso 3, agora pela outra ponta. `externalOptionIntegracao`
    // é o campo que a trava lê, e a trava REMOVE da tela o Select que o escreve:
    // uma escolha marketplace feita à mão aqui fecharia a aba para sempre — sem
    // caminho de volta nesta aba nem fora dela (os outros dois escritores do
    // campo, `onIntegracaoChange` e `MelhorEnvioFields`, ficam inalcançáveis pelo
    // mesmo bloqueio). Por isso os cinco valores marketplace saíram da lista.
    renderTab(freteWith({ externalOptionIntegracao: null, integracaoFreteOuterRef: null }));
    fireEvent.click(screen.getAllByLabelText('Integração da opção externa')[0]!);

    const oferecidos = screen.getAllByRole('option').map((o) => o.textContent);
    const marketplace = integracoesFreteSchema.options.filter(isFreteMarketplaceOwned);
    const proprios = integracoesFreteSchema.options.filter(isFreteSelecionavelManualmente);

    // O PAR. Os quatro donos-marketplace não aparecem…
    expect(marketplace.length).toBeGreaterThan(0);
    for (const tipo of marketplace) {
      expect(oferecidos).not.toContain(INTEGRACAO_FRETE_LABELS[tipo]);
    }
    // …nem a Loja Integrada: ela não é dona do bloco (é roteada, passo 15), mas
    // escolhê-la aqui à mão marcaria o bloco com um tipo que nenhum fluxo de
    // etiqueta despacha.
    expect(isFreteMarketplaceOwned(INTEGRACAO_FRETE.lojaIntegrada)).toBe(false);
    expect(oferecidos).not.toContain(INTEGRACAO_FRETE_LABELS[INTEGRACAO_FRETE.lojaIntegrada]);
    // …e o QUASE-ERRO: os selecionáveis continuam todos lá, um a um, então o
    // filtro não dobrou demais nem esvaziou o Select.
    expect(oferecidos).toEqual(proprios.map((tipo) => INTEGRACAO_FRETE_LABELS[tipo]));
    expect(oferecidos).toContain(INTEGRACAO_FRETE_LABELS[INTEGRACAO_FRETE.melhorEnvios]);
  });

  it('7: a Shopee block WITH its conta’s int_frete ref (stamped on create since 2026-11-18) locks the whole header, and the picker names that doc', () => {
    // The shape the Shopee importer CREATES since Lucas reversed step 20's
    // Q1 (a): the block names `shopee` AND the ref points at the conta's own
    // tipo-`shopee` doc. Both halves of the ownership OR agree here; case 1 is
    // the ref-less shape (a conta with no active doc at create), where the
    // block half alone locks.
    mockIntFrete.doc = DOC_SHOPEE;
    renderTab(
      freteWith({
        externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
        integracaoFreteOuterRef: REF_DOC_SHOPEE,
        prazoDespacho: PRAZO_DESPACHO_US,
      }),
    );

    // The read-only panel, naming Shopee — never the generic body.
    expect(alertaMarketplace()?.textContent).toMatch(
      /Frete gerenciado pelo marketplace \(Shopee\)/,
    );
    expectPrazoBloqueado();
    expect(inputRastreio().readOnly).toBe(true);
    // Every header control is locked: modalidade, integração, endereço,
    // recebedor and status — case 3 pins each one ENABLED.
    expect(selectModalidade().disabled).toBe(true);
    expect(pickerIntegracao().dataset.disabled).toBe('true');
    expect(pickerEndereco().dataset.disabled).toBe('true');
    expect(pickerRecebedor().dataset.disabled).toBe('true');
    expect(selectStatus().disabled).toBe(true);
    // …and the locked picker still NAMES the conta's doc: its id as the value,
    // the same id, nome and tipo through `currentFallback` (a Shopee doc is
    // never in the picker's hand-pickable list). The mocked snapshot answers
    // only for that id, so a tab that resolved another doc names nothing.
    // Case 1 is the near-miss: no ref, no doc named.
    expect(pickerIntegracao().dataset.value).toBe(DOC_SHOPEE.id);
    expect(pickerIntegracao().dataset.fallbackId).toBe(DOC_SHOPEE.id);
    expect(pickerIntegracao().textContent).toBe(
      `${DOC_SHOPEE.data.nome} (${INTEGRACAO_FRETE.shopee})`,
    );
  });

  it.each([INTEGRACAO_FRETE.amazon, INTEGRACAO_FRETE.magalu])(
    'shows the stored deadline as read-only for %s',
    (tipo) => {
      renderTab(freteWith({ externalOptionIntegracao: tipo, prazoDespacho: PRAZO_DESPACHO_US }));

      expectPrazoBloqueado();
    },
  );

  it('shows an editable deadline for a linked Melhor Envio configuration', () => {
    mockIntFrete.doc = {
      id: 'int-1',
      data: { tipo: INTEGRACAO_FRETE.melhorEnvios, nome: 'Melhor Envio' },
    };
    renderTab(freteWith({ integracaoFreteOuterRef: REF_INT_1, prazoDespacho: PRAZO_DESPACHO_US }));

    expect(screen.getByRole('button', { name: 'Calcular frete' })).toBeTruthy();
    expect(campoPrazoDespacho().textContent).toBe(PRAZO_EXIBIDO);
    expect(campoPrazoDespacho().disabled).toBe(false);
  });

  it.each([
    { status: 'loading', loading: true },
    { status: 'missing', loading: false },
  ])(
    'keeps the visible deadline locked when the linked configuration is $status',
    ({ loading }) => {
      mockIntFrete.loading = loading;
      renderTab(
        freteWith({ integracaoFreteOuterRef: REF_INT_1, prazoDespacho: PRAZO_DESPACHO_US }),
      );

      expectPrazoBloqueado();
    },
  );

  it('shows the stored deadline as read-only on a locked manual order', () => {
    render(<Host frete={freteWith({ prazoDespacho: PRAZO_DESPACHO_US })} disabled />);

    expectPrazoBloqueado();
  });

  it('shows a stored deadline as read-only even without active freight', () => {
    renderTab(
      freteWith({
        modalidade: MODALIDADE_FRETE.semTransporte,
        prazoDespacho: PRAZO_DESPACHO_US,
      }),
    );

    expectPrazoBloqueado();
  });

  it('omits the deadline when there is no active freight and no date', () => {
    renderTab(freteWith({ modalidade: MODALIDADE_FRETE.semTransporte, prazoDespacho: null }));

    expect(screen.queryByLabelText(PRAZO_LABEL)).toBeNull();
  });
});
