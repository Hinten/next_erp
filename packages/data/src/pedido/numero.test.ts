import { describe, expect, it } from 'vitest';
import { PEDIDO_COUNTER_PATH, mintNumeros } from './numero';

describe('mintNumeros', () => {
  it('starts the sequence at 1 when the counter doc is missing (createPedidoWithNumero semantics)', () => {
    const { numeros, counterOp } = mintNumeros(null, ['VEN']);
    expect(numeros).toEqual(['VEN-000001']);
    expect(counterOp).toEqual({ type: 'set', path: 'counters/pedido', data: { value: 1 } });
  });

  it('treats a counter doc without a numeric value as 0', () => {
    expect(mintNumeros({}, ['VEN']).numeros).toEqual(['VEN-000001']);
    expect(mintNumeros({ value: 'x' }, ['VEN']).numeros).toEqual(['VEN-000001']);
  });

  it('applies one prefix per numero, sequentially', () => {
    const { numeros, counterOp } = mintNumeros({ value: 41 }, ['VEN', 'DEV']);
    expect(numeros).toEqual(['VEN-000042', 'DEV-000043']);
    expect(counterOp).toEqual({ type: 'set', path: PEDIDO_COUNTER_PATH, data: { value: 43 } });
  });

  it('writes the counter with the value after the LAST mint', () => {
    const { counterOp } = mintNumeros({ value: 10 }, ['A', 'B', 'C']);
    expect(counterOp).toMatchObject({ data: { value: 13 } });
  });

  it('mints nothing (counter value unchanged) for an empty prefix list', () => {
    const { numeros, counterOp } = mintNumeros({ value: 7 }, []);
    expect(numeros).toEqual([]);
    expect(counterOp).toMatchObject({ data: { value: 7 } });
  });
});
