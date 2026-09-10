import { describe, expect, it } from 'vitest';
import { coerceToMicros, millisToMicros } from '@delfrance/core/datetime';
import {
  CAPTURA_COMPRADOR_ESTADO,
  ESTADO_PEDIDO,
  capturaCompradorEstadoSchema,
  marketplacePedidoSchema,
} from '@delfrance/schemas';
import type { ShopeeEscrowDetail, ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { CAPTURA_COMPRADOR_ESTADO as CAPTURA_DO_ADAPTADOR, REGIAO_BR } from './comprador';
import type { ConferenciaDoPedido } from './itens';
import { mapearFreteInicialShopee } from './orderFreteMapping';
import {
  PISO_SEGUNDOS_SHOPEE,
  REGIAO_BR_PEDIDO,
  mapearPedidoShopee,
  microsDeSegundosShopee,
  segundosShopeeUtilizaveis,
  type MapearPedidoShopeeArgs,
} from './orderMapping';
import { ALVO_ESTADO_SHOPEE } from './orderStatusMaps';

const WATERMARK_US = microsDeSegundosShopee(1_788_973_354);

function detalheSG(): ShopeeOrderDetailRow {
  return lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
}

function linha(patch: Record<string, unknown>): ShopeeOrderDetailRow {
  return { ...detalheSG(), ...patch } as ShopeeOrderDetailRow;
}

const CONFERENCIA: ConferenciaDoPedido = {
  orderSn: '260910KJBHUJDM',
  somaDosItens: 30,
  descontoTotal: 0,
  freteCobrado: 1.99,
  totalConferido: 31.99,
  totalDoPedido: 31.99,
  diferenca: 0,
};

function argsBase(patch: Partial<MapearPedidoShopeeArgs> = {}): MapearPedidoShopeeArgs {
  const detalhe = patch.detalhe ?? detalheSG();
  return {
    detalhe,
    escrow: null,
    itens: [],
    conferencia: CONFERENCIA,
    frete: mapearFreteInicialShopee({ detalhe, escrow: null, watermarkUs: WATERMARK_US }).frete,
    conta: {
      integracaoPedidoOuterRef: 'documents/integracao/int-1',
      listaDePrecosOuterRef: 'documents/listaDePrecos/lp-1',
      operacaoPedidoOuterRef: 'documents/operacao/op-1',
    },
    captura: { estado: CAPTURA_COMPRADOR_ESTADO.expirado, camposRecusados: ['regiao:nao-br'] },
    clientePedidoOuterRef: null,
    enderecoFiscalOuterRef: null,
    watermarkUs: WATERMARK_US,
    ...patch,
  };
}

/* -------------------------------------------------------------------------- */
/*                          the seconds → µs conversion                        */
/* -------------------------------------------------------------------------- */

describe('microsDeSegundosShopee', () => {
  it('multiplica por 1_000_000 — segundos viram µs', () => {
    expect(microsDeSegundosShopee(1_788_973_354)).toBe(1_788_973_354_000_000);
    expect(microsDeSegundosShopee(1_788_973_354)).toBe(millisToMicros(1_788_973_354_000));
  });

  it('⚠️ NEAR-MISS: multiplicar por 1000 dá um carimbo de 1970', () => {
    const errado = 1_788_973_354 * 1000;
    expect(errado).toBeLessThan(microsDeSegundosShopee(1_788_973_354));
    expect(new Date(errado / 1000).getUTCFullYear()).toBe(1970);
  });

  it('⚠️ NEAR-MISS: coerceToMicros NÃO serve para segundos — lê 1.78e9 como MILISSEGUNDOS', () => {
    // The trap this whole seam exists for: `coerceToMicros` classifies by
    // MAGNITUDE, and a Shopee `update_time` is below `MILLIS_UPPER_BOUND`, so it
    // is read as ms and answers 1970 — a watermark comparison that says "older"
    // for ever, with nothing failing. Asserted against the REAL helper, so the
    // day its bounds change this test says so.
    expect(coerceToMicros(1_788_973_354)).toBe(1_788_973_354_000);
    expect(coerceToMicros(1_788_973_354)).not.toBe(microsDeSegundosShopee(1_788_973_354));
    expect(new Date(coerceToMicros(1_788_973_354)! / 1000).getUTCFullYear()).toBe(1970);
    // …and it IS the right reader for a STORED µs value, which is what the
    // transaction uses it for.
    expect(coerceToMicros(1_788_973_354_000_000)).toBe(1_788_973_354_000_000);
  });
});

describe('segundosShopeeUtilizaveis', () => {
  it('aceita um carimbo acima do piso de 2020-01-01 e recusa o zero-fill', () => {
    expect(segundosShopeeUtilizaveis(1_788_973_354)).toBe(1_788_973_354);
    expect(segundosShopeeUtilizaveis(PISO_SEGUNDOS_SHOPEE)).toBe(PISO_SEGUNDOS_SHOPEE);
    expect(segundosShopeeUtilizaveis(0)).toBeNull();
    expect(segundosShopeeUtilizaveis(null)).toBeNull();
  });

  it('⚠️ NEAR-MISS: um segundo ABAIXO do piso ainda é ausência', () => {
    expect(segundosShopeeUtilizaveis(PISO_SEGUNDOS_SHOPEE - 1)).toBeNull();
    // The floor is a real date, not a magic number: 2020-01-01T00:00:00Z.
    expect(new Date(PISO_SEGUNDOS_SHOPEE * 1000).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the groups                                 */
/* -------------------------------------------------------------------------- */

describe('mapearPedidoShopee — o grupo SEMPRE', () => {
  it('grava o order_status VERBATIM e statusEm = watermark', () => {
    const m = mapearPedidoShopee(argsBase());
    expect(m.sempre.marketplace.status).toBe('READY_TO_SHIP');
    expect(m.sempre.marketplace.statusEm).toBe(WATERMARK_US);
    expect(m.sempre.marketplace.tipo).toBe('shopee');
  });

  it('um status DESCONHECIDO ainda é gravado como dado, e a escada vira erro', () => {
    const m = mapearPedidoShopee(argsBase({ detalhe: linha({ order_status: 'INVOICE_PENDING' }) }));
    expect(m.sempre.marketplace.status).toBe('INVOICE_PENDING');
    expect(m.alvo.tipo).toBe(ALVO_ESTADO_SHOPEE.erro);
    expect(m.sempre.erro).toEqual({
      tipo: 'definir',
      mensagem: '[shopee] status desconhecido: "INVOICE_PENDING"',
    });
    // …and the block still parses, which is the whole reason `status` is a
    // string: an enum would make this pedido unwritable.
    expect(marketplacePedidoSchema.safeParse(m.sempre.marketplace).success).toBe(true);
  });

  it('um status CONHECIDO pede a limpeza condicional do error', () => {
    expect(mapearPedidoShopee(argsBase()).sempre.erro).toEqual({ tipo: 'limpar-se-nosso' });
  });

  it('pendingTerms: null quando a Shopee não mandou, [] quando mandou vazio', () => {
    expect(
      mapearPedidoShopee(argsBase({ detalhe: linha({ pending_terms: null }) })).sempre.marketplace
        .pendingTerms,
    ).toBeNull();
    expect(
      mapearPedidoShopee(argsBase({ detalhe: linha({ pending_terms: [] }) })).sempre.marketplace
        .pendingTerms,
    ).toEqual([]);
    expect(
      mapearPedidoShopee(argsBase({ detalhe: linha({ pending_terms: ['KYC_PENDING'] }) })).sempre
        .marketplace.pendingTerms,
    ).toEqual(['KYC_PENDING']);
  });

  it('⚠️ ESCOPO: pending_terms mudam o FLAG e nunca o veredito da escada', () => {
    // This is where the terms are actually READ, so this is where the scope
    // property lives. `estadoPedidoDeOrderStatus` takes one argument, so the
    // ladder itself cannot see them — what this pins is that the MAPPER does
    // not sneak them into `alvo` on the way past. The pair is deliberate: the
    // two must agree on `alvo` and DISAGREE on the flag, so a mutant that drops
    // the terms entirely fails the second half.
    const semTermos = mapearPedidoShopee(
      argsBase({ detalhe: linha({ order_status: 'PENDING', pending_terms: null }) }),
    );
    const comTermos = mapearPedidoShopee(
      argsBase({ detalhe: linha({ order_status: 'PENDING', pending_terms: ['KYC_PENDING'] }) }),
    );
    expect(comTermos.alvo).toEqual(semTermos.alvo);
    expect(comTermos.alvo).toEqual({
      tipo: ALVO_ESTADO_SHOPEE.estado,
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    });
    expect(comTermos.sempre.marketplace.pendingTerms).not.toEqual(
      semTermos.sempre.marketplace.pendingTerms,
    );
  });

  it('cancelReason/cancelBy vazios ("" na fixture SG) viram null, não string vazia', () => {
    const m = mapearPedidoShopee(argsBase());
    expect(detalheSG().cancel_reason).toBe('');
    expect(m.sempre.marketplace.cancelReason).toBeNull();
    expect(m.sempre.marketplace.cancelBy).toBeNull();
  });

  it('cancelReason preserva um asterisco — este NÃO é o preditor de mascaramento', () => {
    // ⚠️ `valorUtilizavel` refuses any `*`, which is right for BUYER data and
    // wrong here: a cancel reason is Shopee's own text and dropping it would
    // lose the only explanation the operator gets.
    const m = mapearPedidoShopee(
      argsBase({ detalhe: linha({ cancel_reason: 'Buyer changed mind (*)' }) }),
    );
    expect(m.sempre.marketplace.cancelReason).toBe('Buyer changed mind (*)');
  });

  it('completedScenario sai do DETALHE quando presente, e é null quando não', () => {
    expect(mapearPedidoShopee(argsBase()).sempre.marketplace.completedScenario).toBeNull();
    const m = mapearPedidoShopee(
      argsBase({ detalhe: linha({ order_status: 'COMPLETED', completed_scenario: 'NORMAL' }) }),
    );
    expect(m.sempre.marketplace.completedScenario).toBe('NORMAL');
  });

  it('capturaComprador carrega NOMES de campo e o status observado — nunca um valor', () => {
    const m = mapearPedidoShopee(
      argsBase({
        captura: {
          estado: CAPTURA_COMPRADOR_ESTADO.pendente,
          camposRecusados: ['nome:mascarado', 'cpf_cnpj:invalido'],
        },
        camposRecusadosExtra: ['endereco:sem-cep'],
      }),
    );
    expect(m.sempre.capturaComprador).toEqual({
      estado: CAPTURA_COMPRADOR_ESTADO.pendente,
      statusObservado: 'READY_TO_SHIP',
      camposRecusados: ['nome:mascarado', 'cpf_cnpj:invalido', 'endereco:sem-cep'],
      // ⚠️ The IO-observed half kept on its own: the transaction's `capturado`
      // latch drops the BUYER refusals (a captured field was not refused) and
      // must NOT drop an endereço refusal with them — a linked cliente with no
      // endereço can never be fiscalizado.
      camposRecusadosExtra: ['endereco:sem-cep'],
    });
    // Anti-leak: the SG fixture's masked buyer values must appear nowhere.
    const serializado = JSON.stringify(m);
    expect(serializado).not.toContain('Rua Redacted');
    expect(serializado).not.toContain('****');
  });
});

describe('mapearPedidoShopee — o grupo DADOS', () => {
  it('observacoesInternas junta note e message_to_seller com uma quebra de linha', () => {
    const m = mapearPedidoShopee(
      argsBase({
        detalhe: linha({ note: 'separar hoje', message_to_seller: 'presente, sem nota' }),
      }),
    );
    expect(m.dados.observacoesInternas).toBe('separar hoje\npresente, sem nota');
  });

  it('⚠️ NEAR-MISS: com os dois ausentes o campo é null — nunca "null" nem "\\n"', () => {
    // The legacy interpolated `"${note}\n${message_to_seller}"` and wrote the
    // literal string "null" into this field.
    const m = mapearPedidoShopee(
      argsBase({ detalhe: linha({ note: null, message_to_seller: '' }) }),
    );
    expect(m.dados.observacoesInternas).toBeNull();
    expect(m.dados.observacoesInternas).not.toBe('null');
    expect(m.dados.observacoesInternas).not.toBe('null\nnull');
    expect(m.dados.observacoesInternas).not.toBe('\n');
  });

  it('só um dos dois presente ⇒ o campo é aquele texto, sem quebra pendurada', () => {
    const m = mapearPedidoShopee(
      argsBase({ detalhe: linha({ note: '', message_to_seller: 'oi' }) }),
    );
    expect(m.dados.observacoesInternas).toBe('oi');
  });

  it('⚠️ uma mensagem MASCARADA não é armazenada — o comprador a escreveu', () => {
    const m = mapearPedidoShopee(
      argsBase({ detalhe: linha({ note: null, message_to_seller: 'J******n' }) }),
    );
    expect(m.dados.observacoesInternas).toBeNull();
  });

  it('⚠️ PAR: o `note` do VENDEDOR sobrevive com asterisco; a mensagem do COMPRADOR não', () => {
    // The two halves have different authors, so they get different predicates.
    // `note` is the seller's own Seller Centre note — Shopee does not mask a
    // field it returns to its author — so an asterisk in it is punctuation, not
    // a mask, and the masking predicate would silently drop a dispatch
    // instruction (nothing logs it and `camposRecusados` carries buyer fields
    // only). `message_to_seller` is buyer-authored and stays refused.
    const soNota = mapearPedidoShopee(
      argsBase({ detalhe: linha({ note: 'URGENTE *frágil*', message_to_seller: '' }) }),
    );
    expect(soNota.dados.observacoesInternas).toBe('URGENTE *frágil*');

    const ambos = mapearPedidoShopee(
      argsBase({ detalhe: linha({ note: 'URGENTE *frágil*', message_to_seller: 'J******n' }) }),
    );
    expect(ambos.dados.observacoesInternas).toBe('URGENTE *frágil*');
  });

  it('valorCobrado: o escrow ganha do total_amount, que ganha da soma calculada', () => {
    const escrow = {
      order_income: { buyer_total_amount: 40 },
    } as unknown as ShopeeEscrowDetail;
    expect(mapearPedidoShopee(argsBase({ escrow })).dados.valorCobrado).toBe(40);
    expect(mapearPedidoShopee(argsBase()).dados.valorCobrado).toBe(31.99);
    expect(
      mapearPedidoShopee(argsBase({ detalhe: linha({ total_amount: null }) })).dados.valorCobrado,
    ).toBe(31.99); // 30 + 1.99 estimado, arredondado
  });

  it('⚠️ NEAR-MISS: um total_amount ZERO-FILL não vence a soma calculada', () => {
    // `total_amount` is "only returned after payment"; a zero there is absence,
    // and storing it would show an unpaid order as worth nothing.
    const m = mapearPedidoShopee(argsBase({ detalhe: linha({ total_amount: 0 }) }));
    expect(m.dados.valorCobrado).toBe(31.99);
  });

  it('descontoTotal vem da conferência do mapeador de itens, não de um novo somatório', () => {
    const m = mapearPedidoShopee(
      argsBase({ conferencia: { ...CONFERENCIA, descontoTotal: 3.75 } }),
    );
    expect(m.dados.descontoTotal).toBe(3.75);
  });
});

describe('mapearPedidoShopee — PREENCHER UMA VEZ e CRIAÇÃO', () => {
  it('numero é o order_sn verbatim e timestamp vem de create_time em µs', () => {
    const m = mapearPedidoShopee(argsBase());
    expect(m.numero).toBe('260910KJBHUJDM');
    expect(m.preencherUmaVez.numero).toBe('260910KJBHUJDM');
    expect(m.preencherUmaVez.timestamp).toBe(microsDeSegundosShopee(1_788_973_351));
  });

  it('um create_time zero-fill deixa timestamp null (a transação decide o que fazer)', () => {
    expect(
      mapearPedidoShopee(argsBase({ detalhe: linha({ create_time: 0 }) })).preencherUmaVez
        .timestamp,
    ).toBeNull();
  });

  it('os três outer refs vêm da conta, verbatim', () => {
    const m = mapearPedidoShopee(argsBase());
    expect(m.preencherUmaVez.integracaoPedidoOuterRef).toBe('documents/integracao/int-1');
    expect(m.preencherUmaVez.listaDePrecosOuterRef).toBe('documents/listaDePrecos/lp-1');
    expect(m.preencherUmaVez.operacaoPedidoOuterRef).toBe('documents/operacao/op-1');
  });

  it('uma conta sem tabela/operação escreve null — nunca inventa uma referência', () => {
    const m = mapearPedidoShopee(
      argsBase({
        conta: {
          integracaoPedidoOuterRef: 'documents/integracao/int-1',
          listaDePrecosOuterRef: null,
          operacaoPedidoOuterRef: null,
        },
      }),
    );
    expect(m.preencherUmaVez.listaDePrecosOuterRef).toBeNull();
    expect(m.preencherUmaVez.operacaoPedidoOuterRef).toBeNull();
  });

  it('⚠️ bloquearEmissaoNFe = true na região SG (a fixture) e null numa BR', () => {
    expect(mapearPedidoShopee(argsBase()).criacao.bloquearEmissaoNFe).toBe(true);
    expect(
      mapearPedidoShopee(argsBase({ detalhe: linha({ region: 'BR' }) })).criacao.bloquearEmissaoNFe,
    ).toBeNull();
  });

  it('⚠️ NEAR-MISS: a região lida é a do PEDIDO, nunca a do recipient_address', () => {
    // `recipient_address.region` is inside exactly the block masking hides, so a
    // masked BR order would read `null !== 'BR'` and be blocked for ever.
    const m = mapearPedidoShopee(
      argsBase({
        detalhe: linha({
          region: 'BR',
          recipient_address: { ...detalheSG().recipient_address, region: null },
        }),
      }),
    );
    expect(m.criacao.bloquearEmissaoNFe).toBeNull();
  });

  it('uma região AUSENTE não bloqueia nada — a ausência não é uma afirmação', () => {
    expect(
      mapearPedidoShopee(argsBase({ detalhe: linha({ region: null }) })).criacao.bloquearEmissaoNFe,
    ).toBeNull();
  });

  it('ehSaida é true e é o único outro campo de criação', () => {
    expect(mapearPedidoShopee(argsBase()).criacao.ehSaida).toBe(true);
  });

  it('o token da região BR é o MESMO nos dois módulos que o leem', () => {
    expect(REGIAO_BR_PEDIDO).toBe(REGIAO_BR);
  });

  it('⚠️ o vocabulário da captura é UM só — o adaptador re-exporta o do schema', () => {
    // `packages/schemas` cannot import an app, so this pair could have been two
    // declarations of one vocabulary — and a fourth verdict added on one side
    // only would surface as a `ZodError` INSIDE the pedido write, at the one
    // moment the pedido must not fail. The adapter re-exports instead.
    expect(CAPTURA_DO_ADAPTADOR).toBe(CAPTURA_COMPRADOR_ESTADO);
    expect(Object.values(CAPTURA_COMPRADOR_ESTADO).sort()).toEqual([
      'capturado',
      'expirado',
      'pendente',
    ]);
    // …and every one of them is a value the schema actually accepts.
    for (const estado of Object.values(CAPTURA_COMPRADOR_ESTADO)) {
      expect(capturaCompradorEstadoSchema.safeParse(estado).success).toBe(true);
    }
    expect(capturaCompradorEstadoSchema.safeParse('mascarado').success).toBe(false);
  });
});
