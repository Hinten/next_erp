import { describe, expect, it } from 'vitest';
import {
  ESTADO_FRETE,
  ESTADOS_FRETE_PRE_AUTORIZACAO,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  FREIGHT_TIPO_CAPS,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  estadoFreteSchema,
  freightCapsFor,
  freteDoPedidoSchema,
  integracoesFreteSchema,
  isFreteJaPostado,
  isFreteMarketplaceOwned,
  podeAutorizarDespacho,
  reboqueSchema,
  transportadoraSchema,
  veiculoSchema,
  type EstadoFrete,
} from './frete';
import { derivePedidoFreteTotals, itemDoPedidoSchema } from '../pedido';

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
/*        modalidade default — the fail-safe direction for a fiscal field     */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ FISCAL GUARD (#1090). `freteDoPedidoSchema` is what the NF-e generator
 * actually reads — `apps/nfe/lib/nfe/orchestrator/bundle.ts:parseFreteFromPedido`
 * runs `freteDoPedidoSchema.safeParse(pedido.freteInicial)` — and `'0'` (CIF) is
 * the ONLY modalidade that charges the freight into the nota. A block stored
 * without `modalidade` must therefore never read back as CIF, or the store pays
 * ICMS on freight a third party charged, plus every `vNF`-derived figure.
 *
 * The default used to be `'0'`, ported from Flutter's DESERIALISATION fallback
 * (`_modalidadeFreteFromJson` → `contratacaoEmitente`). Flutter's constructor
 * default was never CIF, and its `toJson` always writes the key, so nothing was
 * gained by that fallback and a whole fiscal trap was inherited with it.
 */
describe('freteDoPedidoSchema.modalidade — fail-safe default', () => {
  it('an absent modalidade reads back as destinatário (FOB), never as emitente', () => {
    const frete = freteDoPedidoSchema.parse({ estado: 'iniciado', valorCobrado: 49.9 });

    expect(frete.modalidade).toBe(MODALIDADE_FRETE.fob);
  });

  it('⚠️ the invariant that matters: an absent modalidade is NEVER CIF', () => {
    // Asserted separately from the exact value on purpose — the exact code may
    // one day move between non-emitente modalidades, but this line may not
    // change without a fiscal decision. See #1085 for what CIF costs.
    const frete = freteDoPedidoSchema.parse({ estado: 'iniciado' });

    expect(frete.modalidade).not.toBe(MODALIDADE_FRETE.cif);
  });

  it('an explicitly stored CIF still parses as CIF — the default must not clobber it', () => {
    const frete = freteDoPedidoSchema.parse({
      estado: 'iniciado',
      modalidade: MODALIDADE_FRETE.cif,
      valorCobrado: 49.9,
    });

    expect(frete.modalidade).toBe(MODALIDADE_FRETE.cif);
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

describe('FREIGHT_TIPO_CAPS', () => {
  it('has exactly one row per integração tipo (no missing / extra keys)', () => {
    const tipos = [...integracoesFreteSchema.options].sort();
    const capsKeys = Object.keys(FREIGHT_TIPO_CAPS).sort();
    expect(capsKeys).toEqual(tipos);
  });

  it('Melhor Envio is the only emit provider and the only routed channel', () => {
    expect(FREIGHT_TIPO_CAPS.melhorEnvios).toMatchObject({
      labelMode: 'emit',
      canQuote: true,
      canBuy: true,
      canPrint: true,
      channel: 'melhor-envio',
      marketplaceOwned: false,
    });
    const routed = integracoesFreteSchema.options.filter(
      (t) => FREIGHT_TIPO_CAPS[t].channel != null,
    );
    expect(routed).toEqual(['melhorEnvios']);
  });

  it('every non-ME tipo is non-buyable/non-quotable/non-trackable today', () => {
    // Behavioral guarantee: the caps swap is byte-identical to the old
    // `tipo !== 'melhorEnvios'` reject until a provider implements its flow.
    // `canPrint` is excluded here — the generic-label tipos are printable
    // via their own on-demand PDF (see the dedicated test below).
    for (const tipo of integracoesFreteSchema.options) {
      if (tipo === 'melhorEnvios') continue;
      const caps = FREIGHT_TIPO_CAPS[tipo];
      expect(caps.canQuote).toBe(false);
      expect(caps.canBuy).toBe(false);
      expect(caps.canTrack).toBe(false);
    }
  });

  it('the generic-label tipos (motoboy/outros) are printable via the on-demand PDF, not the freight client', () => {
    for (const tipo of [INTEGRACAO_FRETE.motoboy, INTEGRACAO_FRETE.outros] as const) {
      expect(FREIGHT_TIPO_CAPS[tipo]).toMatchObject({
        labelMode: 'generic',
        canPrint: true,
        canQuote: false,
        canBuy: false,
        canFetchLabel: false,
        canTrack: false,
        marketplaceOwned: false,
        channel: null,
      });
    }
    // Nothing else is printable outside Melhor Envio + the generic tipos —
    // the `channel`-routed check above already pins ME as the only channel.
    const printable = integracoesFreteSchema.options.filter((t) => FREIGHT_TIPO_CAPS[t].canPrint);
    expect([...printable].sort()).toEqual(
      [INTEGRACAO_FRETE.melhorEnvios, INTEGRACAO_FRETE.motoboy, INTEGRACAO_FRETE.outros].sort(),
    );
  });

  it('Mercado Livre is the only fetch-label tipo (marketplace-client print)', () => {
    // Full key set: `canFetchLabel` is true ONLY for mercadoLivre — every other
    // tipo (ME's emit flow included) fetches nothing via a marketplace client.
    const fetchable = integracoesFreteSchema.options.filter(
      (t) => FREIGHT_TIPO_CAPS[t].canFetchLabel,
    );
    expect(fetchable).toEqual([INTEGRACAO_FRETE.mercadoLivre]);
    // The unknown-tipo fallback stays all-false too.
    expect(freightCapsFor(null).canFetchLabel).toBe(false);
    expect(freightCapsFor('bogus-legacy-tipo').canFetchLabel).toBe(false);
  });

  it('the marketplace tipos are the read-only-tab ones', () => {
    const marketplaceOwned = integracoesFreteSchema.options.filter(
      (t) => FREIGHT_TIPO_CAPS[t].marketplaceOwned,
    );
    expect([...marketplaceOwned].sort()).toEqual(
      ['mercadoLivre', 'lojaIntegrada', 'amz', 'magalu', 'shopee'].sort(),
    );
  });

  it('freightCapsFor tolerates an unknown / null tipo (→ all-false, never throws)', () => {
    // `tipo` reaches the UI unparsed from Firestore, so a legacy/corrupt value
    // must degrade to "unsupported" — the pre-table `Set.has` / `!==` safety.
    const unknown = freightCapsFor('bogus-legacy-tipo');
    expect(unknown.canPrint).toBe(false);
    expect(unknown.canBuy).toBe(false);
    expect(unknown.canQuote).toBe(false);
    expect(unknown.marketplaceOwned).toBe(false);
    expect(freightCapsFor(null)).toEqual(unknown);
    expect(freightCapsFor(undefined)).toEqual(unknown);
    // a known tipo still returns its real row
    expect(freightCapsFor('melhorEnvios').canBuy).toBe(true);
  });
});

describe('isFreteJaPostado', () => {
  it('is false for the não-postado estados (no re-emit confirm needed)', () => {
    expect(isFreteJaPostado(ESTADO_FRETE.iniciado)).toBe(false);
    expect(isFreteJaPostado(ESTADO_FRETE.aguardandoNFe)).toBe(false);
    expect(isFreteJaPostado(ESTADO_FRETE.empacotado)).toBe(false);
    expect(isFreteJaPostado(ESTADO_FRETE.aguardandoAgendamento)).toBe(false);
  });

  it('is false for checkFinalizado (explicitly excluded by the Dart guard)', () => {
    expect(isFreteJaPostado(ESTADO_FRETE.checkFinalizado)).toBe(false);
  });

  it('is true once the frete is posted / in transit / terminal', () => {
    expect(isFreteJaPostado(ESTADO_FRETE.postado)).toBe(true);
    expect(isFreteJaPostado(ESTADO_FRETE.aguardandoPostagem)).toBe(true);
    expect(isFreteJaPostado(ESTADO_FRETE.aCaminho)).toBe(true);
    expect(isFreteJaPostado(ESTADO_FRETE.entregue)).toBe(true);
    expect(isFreteJaPostado(ESTADO_FRETE.cancelado)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*        ESTADOS_FRETE_PRE_AUTORIZACAO — the #702 dispatch-guard vocab        */
/* -------------------------------------------------------------------------- */

/**
 * The expected classification, written out as literals on BOTH sides — the table
 * test compares `podeAutorizarDespacho` against these, never against
 * `ESTADOS_FRETE_PRE_AUTORIZACAO` itself (that would only assert
 * `Set.has === Set.has`). Together they must partition `estadoFreteSchema.options`,
 * so a **new** enum member lands in neither list and reds the test: a future
 * estado has to be classified deliberately, not inherit `false` by default.
 */
const PODE_AUTORIZAR: EstadoFrete[] = [
  ESTADO_FRETE.iniciado,
  ESTADO_FRETE.aguardandoAutorizacao,
  ESTADO_FRETE.aguardandoNFe,
  ESTADO_FRETE.aguardandoValidacaoTransporadora,
];

const NAO_PODE_AUTORIZAR: EstadoFrete[] = [
  ESTADO_FRETE.fulfillment,
  ESTADO_FRETE.despachoAutorizado,
  ESTADO_FRETE.aguardandoAgendamento,
  ESTADO_FRETE.despachoNegado,
  ESTADO_FRETE.emSeparacao,
  ESTADO_FRETE.empacotado,
  ESTADO_FRETE.aguardandoPostagem,
  ESTADO_FRETE.checkFinalizado,
  ESTADO_FRETE.postado,
  ESTADO_FRETE.recebidoPelaTransportadora,
  ESTADO_FRETE.aCaminho,
  ESTADO_FRETE.tentandoRealizarEntrega,
  ESTADO_FRETE.entregue,
  ESTADO_FRETE.falhaNaEntrega,
  ESTADO_FRETE.suspenso,
  ESTADO_FRETE.enderecoNaoEncontrado,
  ESTADO_FRETE.aCaminhoDoRemetente,
  ESTADO_FRETE.devolvido,
  ESTADO_FRETE.objetoExtraviado,
  ESTADO_FRETE.cancelado,
  ESTADO_FRETE.desconhecido,
  ESTADO_FRETE.error,
  ESTADO_FRETE.aguardandoRetirada,
];

describe('ESTADOS_FRETE_PRE_AUTORIZACAO', () => {
  it('contains exactly the estados that precede despachoAutorizado', () => {
    expect([...ESTADOS_FRETE_PRE_AUTORIZACAO].sort()).toEqual([...PODE_AUTORIZAR].sort());
  });

  it('classifies every estado of the enum (a new member must be classified deliberately)', () => {
    expect([...PODE_AUTORIZAR, ...NAO_PODE_AUTORIZAR].sort()).toEqual(
      [...estadoFreteSchema.options].sort(),
    );
    for (const estado of estadoFreteSchema.options) {
      expect(podeAutorizarDespacho(estado)).toBe(PODE_AUTORIZAR.includes(estado));
    }
  });

  it('is disjoint from ESTADOS_FRETE_REMOVE_ESTOQUE (dispatch must never un-remove stock)', () => {
    // If the two overlapped, flipping a paid pedido to `despachoAutorizado` could
    // walk `efeitoEstoquePedido` backwards and put sold goods back in the depósito.
    for (const estado of ESTADOS_FRETE_PRE_AUTORIZACAO) {
      expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(estado)).toBe(false);
    }
  });

  it('excludes the estados that are progress past authorization', () => {
    // The exact regression #702 fixes: `!isFreteJaPostado(...)` said `true` for the
    // first four, so a payment erased warehouse progress.
    expect(podeAutorizarDespacho(ESTADO_FRETE.empacotado)).toBe(false);
    expect(podeAutorizarDespacho(ESTADO_FRETE.emSeparacao)).toBe(false);
    expect(podeAutorizarDespacho(ESTADO_FRETE.aguardandoAgendamento)).toBe(false);
    expect(podeAutorizarDespacho(ESTADO_FRETE.checkFinalizado)).toBe(false);
    expect(podeAutorizarDespacho(ESTADO_FRETE.despachoAutorizado)).toBe(false);
    expect(podeAutorizarDespacho(ESTADO_FRETE.despachoNegado)).toBe(false);
    expect(podeAutorizarDespacho(ESTADO_FRETE.desconhecido)).toBe(false);
    expect(podeAutorizarDespacho(ESTADO_FRETE.fulfillment)).toBe(false);
    expect(podeAutorizarDespacho(ESTADO_FRETE.postado)).toBe(false);
  });
});

describe('isFreteMarketplaceOwned', () => {
  it('is true for the five marketplace tipos (the read-only Frete tab lock)', () => {
    expect(isFreteMarketplaceOwned('mercadoLivre')).toBe(true);
    expect(isFreteMarketplaceOwned('lojaIntegrada')).toBe(true);
    expect(isFreteMarketplaceOwned('amz')).toBe(true);
    expect(isFreteMarketplaceOwned('magalu')).toBe(true);
    expect(isFreteMarketplaceOwned('shopee')).toBe(true);
  });

  it('is false for the emit / manual tipos', () => {
    expect(isFreteMarketplaceOwned('melhorEnvios')).toBe(false);
    expect(isFreteMarketplaceOwned('motoboy')).toBe(false);
    expect(isFreteMarketplaceOwned('retiradaNaLoja')).toBe(false);
    expect(isFreteMarketplaceOwned('fob')).toBe(false);
    expect(isFreteMarketplaceOwned('outros')).toBe(false);
  });

  it('tolerates an unknown / null tipo (→ not marketplace-owned)', () => {
    // Same unparsed-Firestore tolerance as `freightCapsFor`: never a crash, and
    // "unknown" must not accidentally lock the tab / block the reconcile.
    expect(isFreteMarketplaceOwned('bogus-legacy-tipo')).toBe(false);
    expect(isFreteMarketplaceOwned(null)).toBe(false);
    expect(isFreteMarketplaceOwned(undefined)).toBe(false);
  });
});
