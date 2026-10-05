import { describe, expect, it } from 'vitest';
import { ESTADO_PEDIDO } from '../pedido/collection/pedido';
import { ESTADO_FRETE } from './frete';
import { INTEGRACAO_TIPO } from '../integracao';
import {
  canalInicioElegivel,
  DESPACHO_METRICAS,
  inicioCheckoutJanela,
  inicioDespachoJanela,
  inicioDespachoPredicado,
  inicioDespachoHref,
  inicioVendasPredicado,
  parseInicioDespacho,
  vendasInicioResultado,
  mapQueryPredicate,
  type QueryPredicate,
  type DespachoMetrica,
} from './inicio';

function matches(predicate: QueryPredicate, row: Record<string, unknown>): boolean {
  return mapQueryPredicate<boolean>(predicate, {
    and: (children) => children.every(Boolean),
    or: (children) => children.some(Boolean),
    leaf: ({ field, op, value }) => {
      const actual = field
        .split('.')
        .reduce<unknown>(
          (current, key) =>
            current && typeof current === 'object'
              ? (current as Record<string, unknown>)[key]
              : undefined,
          row,
        );
      if (op === 'in') return value.includes(actual as string);
      if (op === 'eq') return actual === value;
      if (typeof actual !== 'number' || typeof value !== 'number') return false;
      return op === 'lt'
        ? actual < value
        : op === 'lte'
          ? actual <= value
          : op === 'gt'
            ? actual > value
            : actual >= value;
    },
  });
}
describe('dashboard local calendar', () => {
  it.each([25, 26, 27, 28])('uses the correct Friday–Monday window on September %s', (day) => {
    const window = inicioDespachoJanela(new Date(2026, 8, day, 14));
    const first = day === 25 ? 25 : 26;
    const next = day === 25 ? 26 : 29;
    expect(window).toEqual({
      inicioUs: new Date(2026, 8, first).getTime() * 1000,
      fimUs: (new Date(2026, 8, next).getTime() - 1) * 1000,
    });
  });
  it('keeps the Monday week crossing a month boundary', () => {
    const now = new Date(2026, 9, 1, 13);
    expect(inicioCheckoutJanela(now)).toEqual({
      diaMs: new Date(2026, 9, 1).getTime(),
      mesMs: new Date(2026, 9, 1).getTime(),
      semanaMs: new Date(2026, 8, 28).getTime(),
      inicioMs: new Date(2026, 8, 28).getTime(),
      fimMs: now.getTime(),
    });
  });
});
describe('dispatch counters and destination sets', () => {
  const window = { canalId: 'a', inicioUs: 1000, fimUs: 2000 };
  const row = (
    id: string,
    deadline: number,
    state: string,
    printed = false,
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    ehSaida: true,
    estado: ESTADO_PEDIDO.pago,
    integracaoPedidoOuterRef: 'documents/integracao/a',
    foiImpresso: printed,
    freteInicial: { estado: state, prazoDespacho: deadline },
    ...overrides,
  });
  const rows = [
    row('overdue', 999, ESTADO_FRETE.emSeparacao),
    row('start', 1000, ESTADO_FRETE.iniciado),
    row('packed', 1500, ESTADO_FRETE.empacotado),
    row('end', 2000, ESTADO_FRETE.iniciado, true),
    row('future', 2001, ESTADO_FRETE.iniciado),
    row('future-printed', 2001, ESTADO_FRETE.iniciado, true),
    row('future-ready', 9000, ESTADO_FRETE.checkFinalizado),
    row('future-packed', 9000, ESTADO_FRETE.empacotado),
    row('old-ready', 999, ESTADO_FRETE.checkFinalizado),
    row('posted', 1500, ESTADO_FRETE.aCaminho),
    row('incoming', 1500, ESTADO_FRETE.iniciado, false, { ehSaida: false }),
    row('unpaid', 1500, ESTADO_FRETE.iniciado, false, { estado: ESTADO_PEDIDO.iniciado }),
    row('other-channel', 1500, ESTADO_FRETE.iniciado, false, {
      integracaoPedidoOuterRef: 'documents/integracao/b',
    }),
  ];
  const expected: Record<DespachoMetrica, string[]> = {
    faltam: ['start', 'packed', 'end'],
    atrasados: ['overdue'],
    despachados: ['packed', 'future-ready', 'future-packed'],
    faltaImprimir: ['overdue', 'start', 'packed'],
    proximosDias: ['future', 'future-printed', 'future-packed'],
    proximosDiasSemImpressao: ['future', 'future-packed'],
    total: ['overdue', 'start', 'packed', 'end', 'future-ready', 'future-packed'],
  };
  it.each(Object.keys(DESPACHO_METRICAS) as DespachoMetrica[])(
    '%s links match their counter, including exact bounds and future prepared orders',
    (metrica) => {
      const value = { ...window, metrica };
      const decoded = parseInicioDespacho(
        new URL(inicioDespachoHref(value), 'https://example.com').searchParams
          .get('inicioDespacho')!
          .slice(3),
      );
      expect(decoded).toEqual(value);
      expect(
        rows.filter((r) => matches(inicioDespachoPredicado(decoded!), r)).map((r) => r.id),
      ).toEqual(expected[metrica]);
      expect(
        matches(
          inicioDespachoPredicado(value),
          row('bare', 1500, ESTADO_FRETE.iniciado, false, {
            integracaoPedidoOuterRef: 'integracao/a',
          }),
        ),
      ).toBe(metrica === 'faltam' || metrica === 'faltaImprimir' || metrica === 'total');
    },
  );
  it.each([
    '{}',
    'null',
    '{',
    JSON.stringify({ ...window, metrica: 'unknown' }),
    JSON.stringify({ ...window, metrica: 'faltam', canalId: '../b' }),
    JSON.stringify({ ...window, metrica: 'faltam', inicioUs: 3000 }),
    JSON.stringify({ ...window, metrica: 'faltam', extra: true }),
  ])('rejects malformed presets %s', (value) => expect(parseInicioDespacho(value)).toBeNull());
});
describe('sales and channels', () => {
  it('isolates the seller and outgoing paid/finalized orders within the window', () => {
    const predicate = inicioVendasPredicado('seller', 1000, 2000);
    const base = {
      vendedorPedidoOuterRef: 'documents/usuarios/seller',
      ehSaida: true,
      estado: ESTADO_PEDIDO.pago,
      timestamp: 1000,
    };
    expect(matches(predicate, base)).toBe(true);
    expect(
      matches(predicate, {
        ...base,
        vendedorPedidoOuterRef: 'usuarios/seller',
        estado: ESTADO_PEDIDO.finalizado,
        timestamp: 2000,
      }),
    ).toBe(true);
    for (const patch of [
      { vendedorPedidoOuterRef: 'usuarios/other' },
      { ehSaida: false },
      { estado: ESTADO_PEDIDO.iniciado },
      { timestamp: 999 },
      { timestamp: 2001 },
    ])
      expect(matches(predicate, { ...base, ...patch })).toBe(false);
  });
  it('returns zero for no sales and rounds average using the money helper', () => {
    expect(vendasInicioResultado(0, 0, 1, 2).ticketMedio).toBe(0);
    expect(vendasInicioResultado(100, 3, 1, 2).ticketMedio).toBe(33.33);
  });
  it('includes all six eligible active tipos and excludes inactive or non-dispatch channels', () => {
    const eligible = ['mercadoLivre', 'lojaIntegrada', 'magalu', 'shopee', 'amazon', 'balcao'];
    for (const [name, tipo] of Object.entries(INTEGRACAO_TIPO)) {
      expect(canalInicioElegivel({ tipo, ativo: true })).toBe(eligible.includes(name));
      expect(canalInicioElegivel({ tipo, ativo: false })).toBe(false);
    }
  });
});
