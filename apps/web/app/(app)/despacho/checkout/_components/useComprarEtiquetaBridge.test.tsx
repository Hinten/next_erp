import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { FreteDoPedido, Pedido } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  props: [] as Array<{ pedido: Pedido; pedidoId: string; intFreteId: string | null }>,
}));
vi.mock('@/app/(app)/pedidos/_components/EtiquetaComprarModal', () => ({
  EtiquetaComprarModal: (p: { pedido: Pedido; pedidoId: string; intFreteId: string | null }) => {
    h.props.push(p);
    return null;
  },
}));

import { useComprarEtiquetaBridge, type ComprarEtiquetaBridge } from './useComprarEtiquetaBridge';

/**
 * The checkout's bridge from the provider's `ui.comprarEtiqueta(input)` to the
 * `/pedidos` buy modal (master plan step 15, the bridge fix): the modal must be
 * opened with the provider's LIVE frete, never the screen's frozen copy — a
 * freight the post-save chain re-pointed would otherwise be quoted from the old
 * freight doc.
 */

const FRETE_DA_TELA = {
  integracaoFreteOuterRef: 'documents/int_frete/li-conta',
  externalOptionId: null,
} as unknown as FreteDoPedido;
const FRETE_VIVO = {
  integracaoFreteOuterRef: 'documents/int_frete/me-1',
  externalOptionId: '1',
} as unknown as FreteDoPedido;
const PEDIDO_DA_TELA = { numero: '165', freteInicial: FRETE_DA_TELA } as unknown as Pedido;

function montar(pedido: Pedido | null) {
  let api: ComprarEtiquetaBridge | null = null;
  function Tela() {
    const b = useComprarEtiquetaBridge(pedido);
    api = b;
    return <>{b.element}</>;
  }
  render(<Tela />);
  return () => api!;
}

describe('useComprarEtiquetaBridge', () => {
  it("⭐ opens the modal with the input's LIVE frete over the screen's pedido", () => {
    h.props.length = 0;
    const api = montar(PEDIDO_DA_TELA);

    act(() => {
      void api().comprarEtiqueta({
        intFreteId: 'me-1',
        pedidoId: 'ped-1',
        frete: FRETE_VIVO,
        needsPostedConfirm: false,
      });
    });

    const ultimo = h.props.at(-1)!;
    expect(ultimo.pedido.freteInicial).toBe(FRETE_VIVO);
    expect(ultimo.intFreteId).toBe('me-1');
    expect(ultimo.pedidoId).toBe('ped-1');
  });

  it("⚠️ NEAR-MISS: everything else is still the screen's pedido — only the freight is replaced", () => {
    h.props.length = 0;
    const api = montar(PEDIDO_DA_TELA);

    act(() => {
      void api().comprarEtiqueta({
        intFreteId: 'me-1',
        pedidoId: 'ped-1',
        frete: FRETE_VIVO,
        needsPostedConfirm: false,
      });
    });

    const ultimo = h.props.at(-1)!;
    expect(ultimo.pedido.numero).toBe('165');
    expect(ultimo.pedido.freteInicial).not.toBe(FRETE_DA_TELA);
  });

  it('with no pedido on screen nothing opens, and the buy answers cancelled', async () => {
    h.props.length = 0;
    const api = montar(null);

    let outcome: unknown;
    await act(async () => {
      outcome = await api().comprarEtiqueta({
        intFreteId: 'me-1',
        pedidoId: 'ped-1',
        frete: FRETE_VIVO,
        needsPostedConfirm: false,
      });
    });

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(h.props).toHaveLength(0);
  });
});
