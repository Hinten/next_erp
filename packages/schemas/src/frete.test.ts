import { describe, expect, it } from 'vitest';
import {
  freteDoPedidoSchema,
  isFreteJaPostado,
  reboqueSchema,
  transportadoraSchema,
  veiculoSchema,
} from './frete';
import { derivePedidoFreteTotals, itemDoPedidoSchema, round2 } from './pedido';

/* -------------------------------------------------------------------------- */
/*      Golden-doc round-trips — fixtures shaped exactly as Flutter writes    */
/* -------------------------------------------------------------------------- */

describe('transportadoraSchema — Flutter wire shape', () => {
  it('parses a Flutter-written carrier (lowercase keys, not the XSD names)', () => {
    // Shape from `Transportadora.toJson` —
    // `.old/packages/pedido/lib/src/models.dart:796-848`.
    const doc = {
      cnpj: '99999999000191',
      ie: '110042490114',
      nome: 'Transportadora Dev SA',
      endereco: 'Av Carrier 100',
      municipio: 'Sao Paulo',
      uf: 'SP',
    };
    expect(transportadoraSchema.parse(doc)).toEqual(doc);
  });

  it('fills missing keys with null and rejects the XSD names as known fields', () => {
    const parsed = transportadoraSchema.parse({ nome: 'Só nome' });
    expect(parsed).toEqual({
      cnpj: null,
      ie: null,
      nome: 'Só nome',
      endereco: null,
      municipio: null,
      uf: null,
    });
    // XSD-named keys pass through untyped (passthrough), but the typed
    // fields stay null — i.e. nothing reads `CNPJ`/`xNome` as data.
    const mixed = transportadoraSchema.parse({ CNPJ: '1', xNome: 'X' });
    expect(mixed.cnpj).toBeNull();
    expect(mixed.nome).toBeNull();
  });
});

describe('veiculoSchema / reboqueSchema — Flutter wire shape', () => {
  it('parses {placa, uf, rntc} and requires placa + uf', () => {
    expect(veiculoSchema.parse({ placa: 'ABC1D23', uf: 'SP', rntc: '12345' })).toEqual({
      placa: 'ABC1D23',
      uf: 'SP',
      rntc: '12345',
    });
    expect(veiculoSchema.parse({ placa: 'ABC1D23', uf: 'SP' }).rntc).toBeNull();
    expect(veiculoSchema.safeParse({ uf: 'SP' }).success).toBe(false);
    expect(veiculoSchema.safeParse({ placa: 'ABC1D23' }).success).toBe(false);
  });

  it('reboque shares the veiculo wire shape', () => {
    expect(reboqueSchema.parse({ placa: 'XYZ9876', uf: 'MG' })).toEqual({
      placa: 'XYZ9876',
      uf: 'MG',
      rntc: null,
    });
  });
});

describe('freteDoPedidoSchema — embedded carrier/vehicle blocks', () => {
  it('round-trips a freteInicial with Flutter-shaped nested entities', () => {
    const frete = freteDoPedidoSchema.parse({
      estado: 'iniciado',
      modalidade: '0',
      valorCobrado: 49.9,
      transportadora: {
        cnpj: '99999999000191',
        ie: '110042490114',
        nome: 'Trans Dev',
        endereco: 'Av Carrier 100',
        municipio: 'Sao Paulo',
        uf: 'SP',
      },
      veiculo: { placa: 'ABC1D23', uf: 'SP', rntc: null },
      reboques: [{ placa: 'XYZ9876', uf: 'SP', rntc: null }],
    });
    expect(frete.transportadora?.cnpj).toBe('99999999000191');
    expect(frete.transportadora?.nome).toBe('Trans Dev');
    expect(frete.veiculo?.placa).toBe('ABC1D23');
    expect(frete.reboques?.[0]?.uf).toBe('SP');
  });
});

/* -------------------------------------------------------------------------- */
/*                  derivePedidoFreteTotals — legacy formulas                 */
/* -------------------------------------------------------------------------- */

function item(precoDeVenda: number, quantidade: number, descontoUnitario = 0) {
  return itemDoPedidoSchema.parse({ precoDeVenda, quantidade, descontoUnitario, ordem: 1 });
}

describe('derivePedidoFreteTotals', () => {
  it('null frete → caches 0, valorCobrado = subtotal − desconto (Pedido.total)', () => {
    const out = derivePedidoFreteTotals({
      itens: [item(100, 2)],
      descontoTotal: 25,
      freteInicial: null,
    });
    expect(out).toEqual({ valorCobrado: 175, valorFreteInicial: 0, custoFreteInicial: 0 });
  });

  it('mirrors the legacy factory vector: frete 15.50 / custo 8.75 / desconto 5', () => {
    // `.old/packages/pedido/test/pedido_factory_test.dart:98-132`.
    const out = derivePedidoFreteTotals({
      itens: [item(50, 1)],
      descontoTotal: 5,
      freteInicial: { valorCobrado: 15.5, custoCalculado: 8.75, custoFinal: null },
    });
    expect(out).toEqual({
      valorCobrado: 60.5,
      valorFreteInicial: 15.5,
      custoFreteInicial: 8.75,
    });
  });

  it('rounds the caches to 2 decimals (7.777 → 7.78, 3.333 → 3.33)', () => {
    // `.old/packages/pedido/test/pedido_factory_test.dart:279-283`.
    const out = derivePedidoFreteTotals({
      itens: [item(33.333, 3)],
      descontoTotal: 0,
      freteInicial: { valorCobrado: 7.777, custoCalculado: 3.333, custoFinal: null },
    });
    expect(out.valorFreteInicial).toBe(7.78);
    expect(out.custoFreteInicial).toBe(3.33);
  });

  it('custoCalculado wins over custoFinal; custoFinal is the fallback', () => {
    // Factory precedence — `.old/packages/pedido/lib/src/models.dart:3602`.
    const both = derivePedidoFreteTotals({
      itens: [],
      descontoTotal: 0,
      freteInicial: { valorCobrado: null, custoCalculado: 8, custoFinal: 12 },
    });
    expect(both.custoFreteInicial).toBe(8);
    const fallback = derivePedidoFreteTotals({
      itens: [],
      descontoTotal: 0,
      freteInicial: { valorCobrado: null, custoCalculado: null, custoFinal: 12 },
    });
    expect(fallback.custoFreteInicial).toBe(12);
  });

  it('frete charge participates regardless of modalidade (no sem-frete special case)', () => {
    // `Pedido.total` adds `freteInicial.valorCobrado` unconditionally —
    // `.old/packages/pedido/lib/src/models.dart:3320`.
    const out = derivePedidoFreteTotals({
      itens: [item(10, 1)],
      descontoTotal: 0,
      freteInicial: { valorCobrado: 5, custoCalculado: null, custoFinal: null },
    });
    expect(out.valorCobrado).toBe(15);
  });
});

describe('round2', () => {
  it('matches Dart duasCasasDecimais on the money vectors', () => {
    expect(round2(7.777)).toBe(7.78);
    expect(round2(3.333)).toBe(3.33);
    expect(round2(99.999)).toBe(100);
    expect(round2(0)).toBe(0);
  });
});

describe('isFreteJaPostado', () => {
  it('is false for the não-postado estados (no re-emit confirm needed)', () => {
    expect(isFreteJaPostado('iniciado')).toBe(false);
    expect(isFreteJaPostado('aguardandoNFe')).toBe(false);
    expect(isFreteJaPostado('empacotado')).toBe(false);
    expect(isFreteJaPostado('aguardandoAgendamento')).toBe(false);
  });

  it('is false for checkFinalizado (explicitly excluded by the Dart guard)', () => {
    expect(isFreteJaPostado('checkFinalizado')).toBe(false);
  });

  it('is true once the frete is posted / in transit / terminal', () => {
    expect(isFreteJaPostado('postado')).toBe(true);
    expect(isFreteJaPostado('aguardandoPostagem')).toBe(true);
    expect(isFreteJaPostado('aCaminho')).toBe(true);
    expect(isFreteJaPostado('entregue')).toBe(true);
    expect(isFreteJaPostado('cancelado')).toBe(true);
  });
});
