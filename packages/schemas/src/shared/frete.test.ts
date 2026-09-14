import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ESTADO_FRETE,
  ESTADOS_FRETE_IGNORAR_REMOCAO,
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
  pacoteFreteSchema,
  podeAutorizarDespacho,
  reboqueSchema,
  seedFreteInicial,
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

/* -------------------------------------------------------------------------- */
/*        pacoteFreteSchema + freteInicial.pacotes — the per-package diary     */
/* -------------------------------------------------------------------------- */

/**
 * The diary a marketplace channel folds the pedido's SINGLE `estado` /
 * `codRastreio` / `prazoDespacho` slots from (Shopee step 7, #1515).
 *
 * Two properties carry the whole design and each has its own test below:
 *
 *   - `pacotes` is `.nullable().optional()` and NOT `.nullable().default(null)`.
 *     A default would materialise `pacotes: null` on the first rewrite of every
 *     stored `freteInicial` by every writer of the block, and `freteInicial` is
 *     in neither `PEDIDO_HISTORY_IGNORE_FIELDS` nor `CONCURRENCY_IGNORE` — one
 *     phantom "Sistema" audit row and one phantom editor conflict per pedido,
 *     fleet-wide. Test 43 is the guard against someone "tidying" it into a
 *     default; test 46 is the same claim from the seed's side.
 *   - a stored row is TOLERANT per ELEMENT, never per field: one corrupt row
 *     must not cost the readable ones (test 47).
 */
// 43 — the `.optional()` contract: a block without the key parses WITHOUT it.
describe('freteDoPedidoSchema.pacotes — the `.optional()` contract (43)', () => {
  /**
   * The 33 keys `freteDoPedidoSchema.parse` materialised BEFORE `pacotes`
   * existed, captured from the pre-change file. Pinned in order, so a stored
   * non-Shopee `freteInicial` rewritten by any writer stays byte-identical.
   */
  const CHAVES_ANTES_DO_DIARIO = [
    'externalId',
    'printLabelId',
    'externalOptionId',
    'externalOptionIntegracao',
    'externalOptionData',
    'externalOptionSelectionDate',
    'estado',
    'integracaoFreteOuterRef',
    'integracaoTargetOuterRef',
    'integracao_path',
    'clienteRecebedorOuterReference',
    'enderecoFreteOuterReference',
    'modalidade',
    'transportadora',
    'veiculo',
    'reboques',
    'vagao',
    'balsa',
    'volumes',
    'codRastreio',
    'valorCobrado',
    'custoCalculado',
    'custoFinal',
    'ehReverso',
    'prazoExtra',
    'prazoDespacho',
    'dataEntrega',
    'dataPrevisaoEntrega',
    'valor_assegurado',
    'maoPropria',
    'avisoRecebimento',
    'ultimaModificacao',
    'timestamp',
  ];

  it('43a — a block with no pacotes parses with NO pacotes key at all', () => {
    const frete = freteDoPedidoSchema.parse({ estado: 'iniciado' });
    // `Object.hasOwn`, not `?? null`: a `.default(null)` would flip this to true
    // while every value-level assertion still passed.
    expect(Object.hasOwn(frete, 'pacotes')).toBe(false);
    expect(Object.keys(frete)).toEqual(CHAVES_ANTES_DO_DIARIO);
  });

  it('43b — ANCHOR: the same parse WITH pacotes does carry the key', () => {
    const frete = freteDoPedidoSchema.parse({
      estado: 'iniciado',
      pacotes: [{ numero: 'OFG242672552205937' }],
    });
    expect(Object.hasOwn(frete, 'pacotes')).toBe(true);
    // Zod emits keys in DECLARATION order, so the diary lands immediately after
    // `codRastreio` — the slot it folds into — and not at the tail. The splice
    // is the pin: move the declaration and this fails.
    const esperadas = [...CHAVES_ANTES_DO_DIARIO];
    esperadas.splice(CHAVES_ANTES_DO_DIARIO.indexOf('codRastreio') + 1, 0, 'pacotes');
    expect(Object.keys(frete)).toEqual(esperadas);
    expect(esperadas[20]).toBe('pacotes');
    expect(frete.pacotes?.[0]?.numero).toBe('OFG242672552205937');
  });

  it('43c — an explicit pacotes: null is kept as null (nullable, not stripped)', () => {
    const frete = freteDoPedidoSchema.parse({ estado: 'iniciado', pacotes: null });
    expect(Object.hasOwn(frete, 'pacotes')).toBe(true);
    expect(frete.pacotes).toBeNull();
  });
});

// 44 — round trip + the row's `.passthrough()`.
describe('freteDoPedidoSchema.pacotes — round trip and row passthrough (44)', () => {
  /** A full row: every declared field present, so the parse adds nothing. */
  const LINHA_COMPLETA = {
    numero: 'OFG242672552205937',
    estado: ESTADO_FRETE.aguardandoPostagem,
    estadoMarketplace: 'LOGISTICS_REQUEST_CREATED',
    codRastreio: 'BR123456789XY',
    canalId: '90021',
    prazoDespacho: 1_788_973_354_000_000,
    atualizadoEm: 1_788_973_300_000_000,
    fonte: 'get_package_detail',
  };

  it('44a — a block WITH pacotes round-trips byte-identically', () => {
    const entrada = { estado: 'iniciado', pacotes: [LINHA_COMPLETA] };
    const frete = freteDoPedidoSchema.parse(entrada);
    expect(frete.pacotes).toEqual([LINHA_COMPLETA]);
    // Byte-identical, not merely deep-equal: key ORDER and value shape survive,
    // which is what makes a replay write the same stored bytes.
    expect(JSON.stringify(frete.pacotes)).toBe(JSON.stringify([LINHA_COMPLETA]));
  });

  it('44b — an unknown key INSIDE a row survives .passthrough()', () => {
    const frete = freteDoPedidoSchema.parse({
      estado: 'iniciado',
      pacotes: [{ ...LINHA_COMPLETA, pesoCobradoGramas: 1250 }],
    });
    expect(frete.pacotes?.[0]).toEqual({ ...LINHA_COMPLETA, pesoCobradoGramas: 1250 });
    expect((frete.pacotes?.[0] as Record<string, unknown>).pesoCobradoGramas).toBe(1250);
  });

  it('44c — a minimal row fills exactly the seven declared defaults with null', () => {
    const linha = pacoteFreteSchema.parse({ numero: 'OFG242672552205937' });
    expect(linha).toEqual({
      numero: 'OFG242672552205937',
      estado: null,
      estadoMarketplace: null,
      codRastreio: null,
      canalId: null,
      prazoDespacho: null,
      atualizadoEm: null,
      fonte: null,
    });
  });

  it('44d — two rows keep their own values and their array order', () => {
    const frete = freteDoPedidoSchema.parse({
      estado: 'iniciado',
      pacotes: [
        { ...LINHA_COMPLETA, numero: 'OFG000000000000001', estadoMarketplace: 'LOGISTICS_READY' },
        LINHA_COMPLETA,
      ],
    });
    expect(frete.pacotes?.map((p) => p.numero)).toEqual([
      'OFG000000000000001',
      'OFG242672552205937',
    ]);
    expect(frete.pacotes?.map((p) => p.estadoMarketplace)).toEqual([
      'LOGISTICS_READY',
      'LOGISTICS_REQUEST_CREATED',
    ]);
  });

  it('44e — the block-level array really IS pacoteFreteSchema, not an opaque list', () => {
    // Without this, `z.array(z.unknown())` passes every other test in this file:
    // the rows survive untouched, so a round trip and a passthrough both look
    // right while nothing validates a row on the way into the pedido.
    // (1) the row's own defaults are filled THROUGH the block parse...
    const frete = freteDoPedidoSchema.parse({
      estado: 'iniciado',
      pacotes: [{ numero: 'OFG242672552205937' }],
    });
    expect(frete.pacotes?.[0]).toEqual({
      numero: 'OFG242672552205937',
      estado: null,
      estadoMarketplace: null,
      codRastreio: null,
      canalId: null,
      prazoDespacho: null,
      atualizadoEm: null,
      fonte: null,
    });
    // (2) ...and a row without the identity fails the WHOLE block parse.
    expect(
      freteDoPedidoSchema.safeParse({
        estado: 'iniciado',
        pacotes: [{ estadoMarketplace: 'LOGISTICS_READY' }],
      }).success,
    ).toBe(false);
    // ANCHOR: the same body with a `numero` parses.
    expect(
      freteDoPedidoSchema.safeParse({
        estado: 'iniciado',
        pacotes: [{ numero: 'OFG242672552205937', estadoMarketplace: 'LOGISTICS_READY' }],
      }).success,
    ).toBe(true);
  });
});

// 45 — the row's own validation, every negative paired with its anchor.
describe('pacoteFreteSchema — row validation (45)', () => {
  it('45a — rejects an empty numero (the row identity), accepts a one-char one', () => {
    expect(pacoteFreteSchema.safeParse({ numero: '' }).success).toBe(false);
    // ANCHOR: the same body with one character in `numero` parses.
    expect(pacoteFreteSchema.safeParse({ numero: 'X' }).success).toBe(true);
  });

  it('45b — rejects a numero over 60 chars, accepts exactly 60', () => {
    expect(pacoteFreteSchema.safeParse({ numero: 'A'.repeat(61) }).success).toBe(false);
    expect(pacoteFreteSchema.safeParse({ numero: 'A'.repeat(60) }).success).toBe(true);
  });

  it('45c — rejects a codRastreio over 200 chars, accepts exactly 200', () => {
    // The cap the N-package join has to respect: `freteInicial.codRastreio` is
    // `.max(200)` too, so an uncapped join would throw inside the merge parse.
    const base = { numero: 'OFG242672552205937' };
    expect(pacoteFreteSchema.safeParse({ ...base, codRastreio: 'B'.repeat(201) }).success).toBe(
      false,
    );
    const ok = pacoteFreteSchema.safeParse({ ...base, codRastreio: 'B'.repeat(200) });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.codRastreio?.length).toBe(200);
  });

  it('45d — rejects an estado outside estadoFreteSchema, accepts a member and null', () => {
    const base = { numero: 'OFG242672552205937' };
    // A raw provider token is NOT an `EstadoFrete` — the derivation is the
    // channel's, and a mis-derived value must not reach the diary.
    expect(pacoteFreteSchema.safeParse({ ...base, estado: 'LOGISTICS_READY' }).success).toBe(false);
    expect(pacoteFreteSchema.safeParse({ ...base, estado: 'postadoo' }).success).toBe(false);
    // ANCHOR x2: a real member, and the explicit "not derived yet" null.
    const membro = pacoteFreteSchema.safeParse({ ...base, estado: ESTADO_FRETE.postado });
    expect(membro.success && membro.data.estado).toBe('postado');
    const nulo = pacoteFreteSchema.safeParse({ ...base, estado: null });
    expect(nulo.success).toBe(true);
    expect(nulo.success && nulo.data.estado).toBeNull();
  });

  it('45e — rejects an estadoMarketplace over 120 chars, accepts exactly 120', () => {
    const base = { numero: 'OFG242672552205937' };
    expect(
      pacoteFreteSchema.safeParse({ ...base, estadoMarketplace: 'L'.repeat(121) }).success,
    ).toBe(false);
    expect(
      pacoteFreteSchema.safeParse({ ...base, estadoMarketplace: 'L'.repeat(120) }).success,
    ).toBe(true);
  });

  it('45f — an unknown raw token IS storable verbatim (the source of truth is free text)', () => {
    const linha = pacoteFreteSchema.parse({
      numero: 'OFG242672552205937',
      estadoMarketplace: 'LOGISTICS_SOMETHING_THE_PROVIDER_ADDS_TOMORROW',
      estado: null,
    });
    expect(linha.estadoMarketplace).toBe('LOGISTICS_SOMETHING_THE_PROVIDER_ADDS_TOMORROW');
    expect(linha.estado).toBeNull();
  });
});

// 46 — `seedFreteInicial` is byte-identical to before the diary existed.
describe('seedFreteInicial — unchanged by the diary (46)', () => {
  /** Captured from the pre-change file: `seedFreteInicial(MODALIDADE_FRETE.fob, true)`. */
  const SEMENTE_FOB_SAIDA_ANTES = {
    externalId: null,
    printLabelId: null,
    externalOptionId: null,
    externalOptionIntegracao: null,
    externalOptionData: null,
    externalOptionSelectionDate: null,
    estado: 'iniciado',
    integracaoFreteOuterRef: null,
    integracaoTargetOuterRef: null,
    integracao_path: null,
    clienteRecebedorOuterReference: null,
    enderecoFreteOuterReference: null,
    modalidade: '1',
    transportadora: null,
    veiculo: null,
    reboques: null,
    vagao: null,
    balsa: null,
    volumes: null,
    codRastreio: null,
    valorCobrado: null,
    custoCalculado: null,
    custoFinal: null,
    ehReverso: false,
    prazoExtra: 0,
    prazoDespacho: null,
    dataEntrega: null,
    dataPrevisaoEntrega: null,
    valor_assegurado: null,
    maoPropria: null,
    avisoRecebimento: null,
    ultimaModificacao: null,
    timestamp: null,
  };

  it('46a — the seed is byte-identical to the pre-diary snapshot, with no pacotes', () => {
    const semente = seedFreteInicial(MODALIDADE_FRETE.fob, true);
    expect(JSON.stringify(semente)).toBe(JSON.stringify(SEMENTE_FOB_SAIDA_ANTES));
    expect(Object.hasOwn(semente, 'pacotes')).toBe(false);
  });

  it('46b — the entrada variant is likewise unchanged (only ehReverso/modalidade differ)', () => {
    const semente = seedFreteInicial(MODALIDADE_FRETE.terceiros, false);
    expect(JSON.stringify(semente)).toBe(
      JSON.stringify({ ...SEMENTE_FOB_SAIDA_ANTES, modalidade: '2', ehReverso: true }),
    );
    expect(Object.hasOwn(semente, 'pacotes')).toBe(false);
  });
});

// 47 — per-ELEMENT tolerance: one corrupt row costs only that row.
describe('pacoteFreteSchema — per-element tolerance (47)', () => {
  const LINHA_BOA = {
    numero: 'OFG242672552205937',
    estado: ESTADO_FRETE.postado,
    estadoMarketplace: 'LOGISTICS_PICKUP_DONE',
    codRastreio: 'BR123456789XY',
    canalId: '90021',
    prazoDespacho: 1_788_973_354_000_000,
    atualizadoEm: 1_788_973_300_000_000,
    fonte: 'get_package_detail',
  };
  /** A stored row a past bug (or a hand edit) left without its identity. */
  const LINHA_CORROMPIDA = { numero: '', estadoMarketplace: 'LOGISTICS_READY' };

  it('47a — one corrupt row becomes null; the readable rows keep their values', () => {
    const tolerante = z.array(pacoteFreteSchema.nullable().catch(null));
    const linhas = tolerante.parse([LINHA_BOA, LINHA_CORROMPIDA, { numero: 'OFG000000000000001' }]);
    expect(linhas.length).toBe(3);
    expect(linhas[0]).toEqual(LINHA_BOA);
    expect(linhas[1]).toBeNull();
    expect(linhas[2]?.numero).toBe('OFG000000000000001');
    // What the reader keeps once the nulls are filtered out.
    expect(linhas.filter((l) => l !== null).map((l) => l.numero)).toEqual([
      'OFG242672552205937',
      'OFG000000000000001',
    ]);
  });

  it('47b — ANCHOR: WITHOUT the per-element catch the same array fails whole', () => {
    // The near-miss that proves the tolerance is doing the work and the row
    // schema is not merely lax: a Zod array fails ENTIRELY on one bad element.
    const estrito = z.array(pacoteFreteSchema);
    expect(estrito.safeParse([LINHA_BOA, LINHA_CORROMPIDA]).success).toBe(false);
    // ...and the same strict array accepts it once the bad row is gone.
    expect(estrito.safeParse([LINHA_BOA]).success).toBe(true);
  });

  it('47c — the tolerance is per ELEMENT, never per FIELD', () => {
    // A row whose `codRastreio` is over the cap is dropped WHOLE (null), not
    // silently repaired into a row with `codRastreio: null` — the diary must
    // never invent a package state nobody observed.
    const tolerante = z.array(pacoteFreteSchema.nullable().catch(null));
    const linhas = tolerante.parse([{ ...LINHA_BOA, codRastreio: 'B'.repeat(201) }]);
    expect(linhas[0]).toBeNull();
    // ANCHOR: the very same row under the cap survives with every field intact.
    expect(tolerante.parse([{ ...LINHA_BOA, codRastreio: 'B'.repeat(200) }])[0]).toEqual({
      ...LINHA_BOA,
      codRastreio: 'B'.repeat(200),
    });
  });
});

/* -------------------------------------------------------------------------- */
/*    Count pins — nothing but the diary moved in this file (Shopee step 7)    */
/* -------------------------------------------------------------------------- */

describe('ESTADO_FRETE and the stock sets are untouched by the diary', () => {
  it('the enum still has exactly its 27 members, in order', () => {
    expect(estadoFreteSchema.options.length).toBe(27);
    expect(estadoFreteSchema.options).toEqual([
      'fulfillment',
      'iniciado',
      'aguardandoAutorizacao',
      'aguardandoNFe',
      'aguardandoValidacaoTransporadora',
      'despachoAutorizado',
      'aguardandoAgendamento',
      'despachoNegado',
      'emSeparacao',
      'empacotado',
      'aguardandoPostagem',
      'checkFinalizado',
      'postado',
      'recebidoPelaTransportadora',
      'aCaminho',
      'tentandoRealizarEntrega',
      'entregue',
      'falhaNaEntrega',
      'suspenso',
      'enderecoNaoEncontrado',
      'aCaminhoDoRemetente',
      'devolvido',
      'objetoExtraviado',
      'cancelado',
      'desconhecido',
      'error',
      'aguardandoRetirada',
    ]);
  });

  it('ESTADOS_FRETE_REMOVE_ESTOQUE still holds exactly its 15 members', () => {
    expect(ESTADOS_FRETE_REMOVE_ESTOQUE.size).toBe(15);
    expect([...ESTADOS_FRETE_REMOVE_ESTOQUE]).toEqual([
      'empacotado',
      'aguardandoPostagem',
      'checkFinalizado',
      'postado',
      'recebidoPelaTransportadora',
      'aCaminho',
      'tentandoRealizarEntrega',
      'entregue',
      'falhaNaEntrega',
      'suspenso',
      'enderecoNaoEncontrado',
      'aCaminhoDoRemetente',
      'devolvido',
      'objetoExtraviado',
      'aguardandoRetirada',
    ]);
  });

  it('ESTADOS_FRETE_IGNORAR_REMOCAO still holds exactly desconhecido + error', () => {
    expect(ESTADOS_FRETE_IGNORAR_REMOCAO.size).toBe(2);
    expect([...ESTADOS_FRETE_IGNORAR_REMOCAO]).toEqual(['desconhecido', 'error']);
  });
});
