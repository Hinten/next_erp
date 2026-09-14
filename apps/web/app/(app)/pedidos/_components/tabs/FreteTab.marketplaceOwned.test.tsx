import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  seedFreteInicial,
} from '@delfrance/schemas';
import type { FreteInicialFormState, PedidoFormState } from '../types';

import { FreteTab } from './FreteTab';

// Step 7 (#1515) — the Frete tab reads ownership off the freight BLOCK
// (`externalOptionIntegracao`), not only off the resolved `int_frete` doc.
// A Shopee pedido never gets an `integracaoFreteOuterRef`
// (`apps/shopee/lib/shopee/pedidos/orderFreteMapping.ts` writes
// `externalOptionIntegracao: 'shopee'` and nothing else), so before this fix
// `tipo` resolved to `undefined`, the tab rendered the EDITABLE generic body,
// and an operator could type over the two fields the importer owns —
// `codRastreio` and the frete `estado` — latching `hasUserInteraction` on a
// block the server (`pedidoReconcile`) already treats as marketplace-owned.

interface IntFreteDocFixture {
  readonly id: string;
  readonly data: { readonly tipo: IntegracaoFrete; readonly nome: string };
}

/** The resolved `int_frete` document, or `null` for "resolves to nothing". */
const mockIntFrete: { doc: IntFreteDocFixture | null } = { doc: null };

vi.mock('@/components/pickers/ClientePicker', () => ({ ClientePicker: () => null }));
vi.mock('@/components/pickers/EnderecoPicker', () => ({
  EnderecoPicker: () => null,
  useEnderecoFromRef: () => ({ endereco: null }),
}));
vi.mock('./frete/IntegracaoFreteSelect', () => ({ IntegracaoFreteSelect: () => null }));
vi.mock('@delfrance/data/hooks', () => ({
  // Mirrors the real hook's null-ref arm: a pedido with no
  // `integracaoFreteOuterRef` can NEVER be handed a resolved document, so a
  // fixture cannot accidentally supply one and make a test vacuous.
  useDocSnapshot: (ref: unknown) => ({
    data: ref == null ? undefined : mockIntFrete.doc,
    loading: false,
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
const REF_INT_1 = 'documents/int_frete/int-1';

function freteWith(over: Partial<FreteInicialFormState>): FreteInicialFormState {
  return {
    ...(seedFreteInicial(MODALIDADE_FRETE.fob, true) as unknown as FreteInicialFormState),
    ...over,
  };
}

function Host({ frete }: { frete: FreteInicialFormState }) {
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
        <FreteTab form={form} db={db} pedidoId="ped-1" />
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
/**
 * Rendered by `GenericFreteFields` and by `RetiradaFields`, by NEITHER
 * `MarketplaceReadOnly` — the anchor that says which body is on screen.
 */
const campoPrazoDespacho = () => screen.queryByLabelText('Data máxima para despacho');

beforeEach(() => {
  // Mantine portals into `document.body`, which RTL's cleanup does not clear.
  document.body.innerHTML = '';
  mockIntFrete.doc = null;
});

describe('FreteTab — marketplace ownership is read off the BLOCK too (#1515)', () => {
  it('1: a Shopee block with no integração doc renders the read-only panel', () => {
    renderTab(
      freteWith({
        externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
        integracaoFreteOuterRef: null,
        codRastreio: 'OFG242672552205937',
      }),
    );

    // The panel, and it names the tipo the BLOCK declares.
    expect(alertaMarketplace()?.textContent).toMatch(
      /Frete gerenciado pelo marketplace \(Shopee\)/,
    );
    // The generic body is gone — so are its two importer-owned inputs.
    expect(campoPrazoDespacho()).toBeNull();
    expect(inputRastreio().readOnly).toBe(true);
    expect(inputRastreio().disabled).toBe(true);
    expect(inputIntegracaoOpcao().readOnly).toBe(true);
    // The header Select the estado would be edited through.
    expect(selectStatus().disabled).toBe(true);
  });

  it('2: NEAR-MISS — a melhorEnvios block with no integração doc stays editable', () => {
    renderTab(
      freteWith({
        externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios,
        integracaoFreteOuterRef: null,
      }),
    );

    expect(alertaMarketplace()).toBeNull();
    // Anchor: the generic body really is on screen, so "editable" is an
    // observation and not an empty render.
    expect(campoPrazoDespacho()).not.toBeNull();
    expect(inputRastreio().readOnly).toBe(false);
    expect(inputRastreio().disabled).toBe(false);
    expect(selectStatus().disabled).toBe(false);
  });

  it('3: a manual pedido (no integração declared anywhere) stays editable', () => {
    renderTab(freteWith({ externalOptionIntegracao: null, integracaoFreteOuterRef: null }));

    expect(alertaMarketplace()).toBeNull();
    expect(campoPrazoDespacho()).not.toBeNull();
    expect(inputRastreio().readOnly).toBe(false);
    expect(inputRastreio().disabled).toBe(false);
    expect(selectStatus().disabled).toBe(false);
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
      }),
    );

    // Ownership is the OR of the two declarations: the weaker one (the doc)
    // widens it, never narrows it. The panel names the side that owns.
    expect(alertaMarketplace()?.textContent).toMatch(
      /Frete gerenciado pelo marketplace \(Shopee\)/,
    );
    // Neither the retirada body nor the generic one reached the screen.
    expect(campoPrazoDespacho()).toBeNull();
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
    renderTab(freteWith({ externalOptionIntegracao: null, integracaoFreteOuterRef: REF_INT_1 }));

    expect(alertaMarketplace()?.textContent).toMatch(
      /Frete gerenciado pelo marketplace \(Mercado Livre\)/,
    );
    expect(campoPrazoDespacho()).toBeNull();
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
    const proprios = integracoesFreteSchema.options.filter((t) => !isFreteMarketplaceOwned(t));

    // O PAR. Os cinco donos-marketplace não aparecem…
    expect(marketplace.length).toBeGreaterThan(0);
    for (const tipo of marketplace) {
      expect(oferecidos).not.toContain(INTEGRACAO_FRETE_LABELS[tipo]);
    }
    // …e o QUASE-ERRO: os não-marketplace continuam todos lá, um a um, então o
    // filtro não dobrou demais nem esvaziou o Select.
    expect(oferecidos).toEqual(proprios.map((tipo) => INTEGRACAO_FRETE_LABELS[tipo]));
    expect(oferecidos).toContain(INTEGRACAO_FRETE_LABELS[INTEGRACAO_FRETE.melhorEnvios]);
  });
});
