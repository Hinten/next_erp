import { describe, expect, it } from 'vitest';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { CheckoutFretePedido } from '@delfrance/schemas';
import { MODALIDADE_FRETE } from '@delfrance/schemas';
import { parseOutroCheckoutRow } from './useOutrosCheckouts';

/** A minimal collection-group snapshot row (only the fields the parser reads). */
function makeRow(
  path: string,
  data: Partial<CheckoutFretePedido> = {},
): SnapshotRow<CheckoutFretePedido> {
  const segs = path.split('/');
  return {
    id: segs[segs.length - 1]!,
    path,
    data: {
      title: 'PED-1',
      obs: null,
      freteNoMomentoDoCheckout: {
        modalidade: MODALIDADE_FRETE.cif,
      } as CheckoutFretePedido['freteNoMomentoDoCheckout'],
      ehDoFreteInicial: null,
      usuarioCheckoutFretePedidoOuterRef: 'documents/usuarios/u1',
      itensCheckout: [],
      timestamp: 1000,
      ...data,
    } as CheckoutFretePedido,
  } as SnapshotRow<CheckoutFretePedido>;
}

describe('parseOutroCheckoutRow', () => {
  it('takes pedidoId from the doc PATH (segment 1), not any denormalized field', () => {
    const r = parseOutroCheckoutRow(makeRow('pedidos/PEDA/checkout/CHK1'));
    expect(r).not.toBeNull();
    // pedidoId is the row's own parent — the anchor of the wrong-label-bug armor.
    expect(r!.pedidoId).toBe('PEDA');
    expect(r!.checkoutId).toBe('CHK1');
  });

  it('maps title→numero, timestamp→timestampMs, and carries the frete snapshot', () => {
    const r = parseOutroCheckoutRow(
      makeRow('pedidos/P/checkout/C', {
        title: 'NUM-9',
        timestamp: 42,
        obs: 'conferido',
        freteNoMomentoDoCheckout: {
          modalidade: MODALIDADE_FRETE.semTransporte,
        } as CheckoutFretePedido['freteNoMomentoDoCheckout'],
      }),
    );
    expect(r!.numero).toBe('NUM-9');
    expect(r!.timestampMs).toBe(42);
    expect(r!.obs).toBe('conferido');
    expect(r!.frete.modalidade).toBe('9');
  });

  it('defaults numero/timestamp to null and itens to [] when absent', () => {
    const r = parseOutroCheckoutRow(
      makeRow('pedidos/P/checkout/C', { title: null, timestamp: null, itensCheckout: null }),
    );
    expect(r!.numero).toBeNull();
    expect(r!.timestampMs).toBeNull();
    expect(r!.itens).toEqual([]);
  });

  it('returns null for a path that is not a 4-segment checkout leaf', () => {
    expect(parseOutroCheckoutRow(makeRow('pedidos/PEDA/nfev4/N1'))).toBeNull();
    expect(parseOutroCheckoutRow(makeRow('pedidos/PEDA'))).toBeNull();
    expect(parseOutroCheckoutRow(makeRow('clientes/X/checkout/C'))).toBeNull();
  });
});
